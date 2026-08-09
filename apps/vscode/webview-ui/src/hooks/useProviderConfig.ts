import { StringRequest } from "@shared/proto/cline/common"
import {
	type AwsProviderConfig,
	CommitModelSelectionRequest,
	type GcpProviderConfig,
	type ProviderConfigResponse,
	WriteProviderConfigPatch,
	WriteProviderConfigRequest,
} from "@shared/proto/cline/models"
import {
	type ProviderModelOverrides,
	toProtobufModelOverrides as toProtobufProviderModelOverrides,
} from "@shared/proto-conversions/models/modelOverrides"
import { useCallback, useEffect, useSyncExternalStore } from "react"
import { useApiConfigurationScope } from "@/components/settings/utils/ApiConfigurationScopeContext"
import type { ProviderId } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"

export type ProviderConfigWritePatch = Partial<Omit<WriteProviderConfigPatch, "headers" | "aws" | "gcp">> & {
	headers?: Record<string, string>
	aws?: Partial<AwsProviderConfig>
	gcp?: Partial<GcpProviderConfig>
}

// The overrides domain type and its proto conversions are shared with the
// host; see the tri-state and normalization semantics documented there.
export {
	fromProtobufModelOverrides as fromProtobufProviderModelOverrides,
	toProtobufModelOverrides as toProtobufProviderModelOverrides,
} from "@shared/proto-conversions/models/modelOverrides"
export type { ProviderModelOverrides }

export interface ProviderModelSelection {
	providerId: ProviderId
	modelId: string
	/**
	 * Tri-state: `undefined` preserves the model's stored overrides, an
	 * explicitly empty object clears them, and a non-empty object replaces
	 * them wholesale.
	 */
	overrides?: ProviderModelOverrides
}

function toWriteProviderConfigPatch(patch: ProviderConfigWritePatch): WriteProviderConfigPatch {
	const headers = patch.headers ?? {}
	const shouldClearHeaders = patch.headers !== undefined && Object.keys(headers).length === 0

	return WriteProviderConfigPatch.create({
		...patch,
		headers,
		clearHeaders: shouldClearHeaders || undefined,
	})
}

/**
 * One provider entry, one copy of it.
 *
 * A provider's `providers.json` entry is host state, but every call site used
 * to hold a private copy read once on mount and never invalidated. Two of them
 * are always mounted together — the API configuration profile bar and the
 * provider's own settings panel — so a context window typed into the panel
 * never reached the bar: it went on comparing, and saving into profiles, the
 * value it had read when settings opened. Nothing looked unsaved, an overwrite
 * stored the old number, and loading the profile back put the old number in.
 *
 * Sharing the entry means a write from any call site is what every other one
 * sees, in the same tick, without a remount.
 */
interface ProviderConfigEntry {
	response?: ProviderConfigResponse
	/** Sequence of the newest request issued for this provider, by any caller. */
	issued: number
	listeners: Set<() => void>
}

const providerConfigEntries = new Map<string, ProviderConfigEntry>()
let nextRequestSeq = 0

function entryFor(providerId: string): ProviderConfigEntry {
	const existing = providerConfigEntries.get(providerId)
	if (existing) {
		return existing
	}
	const created: ProviderConfigEntry = { issued: 0, listeners: new Set() }
	providerConfigEntries.set(providerId, created)
	return created
}

/**
 * Claims the newest-request slot for a provider.
 *
 * Reads and writes resolve asynchronously and can complete out of order (e.g. a
 * slow mount read landing after a user-triggered write). Only the newest issued
 * request may apply its response; anything older is stale and would roll the UI
 * back. The sequence is global rather than per hook, so the rule holds between
 * two panels writing the same entry as well as within one.
 */
function issueRequest(providerId: string): number {
	const entry = entryFor(providerId)
	nextRequestSeq += 1
	entry.issued = nextRequestSeq
	return entry.issued
}

function publishConfig(providerId: string, seq: number, response: ProviderConfigResponse): void {
	const entry = entryFor(providerId)
	if (seq !== entry.issued) {
		return
	}
	entry.response = response
	for (const listener of [...entry.listeners]) {
		listener()
	}
}

/**
 * Writes one provider's entry, named explicitly rather than taken from whatever
 * a hook is bound to.
 *
 * Loading a profile is the case that needs this: `useProviderConfig` binds to
 * the provider the panel is *currently* showing, and a profile that also
 * switches provider carries a config for a different one. Sending it through
 * the bound hook wrote the incoming profile's context window onto the outgoing
 * provider's entry — corrupting the provider being left, while the profile's
 * own entry kept the number it already had. Reported as a profile whose context
 * window "still matches what's in the main profile", which is exactly what it
 * would look like from the outside.
 *
 * `commitModelSelection` on the hook throws when the provider does not match,
 * for the same reason; the config write had no such guard.
 */
export async function writeProviderConfigFor(
	providerId: string,
	patch: ProviderConfigWritePatch,
): Promise<ProviderConfigResponse | undefined> {
	const seq = issueRequest(providerId)
	const response = await ModelsServiceClient.writeProviderConfig(
		WriteProviderConfigRequest.create({
			providerId,
			patch: toWriteProviderConfigPatch(patch),
		}),
	)
	publishConfig(providerId, seq, response)
	return response
}

/** Test-only: the entries outlive any one hook, which is the point of them. */
export function __resetProviderConfigEntries(): void {
	providerConfigEntries.clear()
	nextRequestSeq = 0
}

export function useProviderConfig(requestedProviderId: ProviderId) {
	// Which providers.json entry this panel is bound to. The Vision tab owns its
	// own, so its base URL, context window, sampler and model selection stop
	// landing on the entry Plan and Act read.
	const scope = useApiConfigurationScope()
	const providerId = requestedProviderId
	const config = useSyncExternalStore(
		useCallback(
			(onStoreChange: () => void) => {
				const entry = entryFor(providerId)
				entry.listeners.add(onStoreChange)
				return () => entry.listeners.delete(onStoreChange)
			},
			[providerId],
		),
		useCallback(() => entryFor(providerId).response, [providerId]),
	)

	// A scoped panel reads what the scope holds rather than the shared entry, so
	// the picker shows what it just committed instead of falling back to the
	// first model in the list.
	const scopedConfig = scope?.ownsProviderSettings
		? ({
				...(scope.providerSettings ?? {}),
				actSelection: scope.providerSettings?.selectedModelId
					? { modelId: scope.providerSettings.selectedModelId }
					: undefined,
				planSelection: scope.providerSettings?.selectedModelId
					? { modelId: scope.providerSettings.selectedModelId }
					: undefined,
			} as unknown as ProviderConfigResponse)
		: undefined

	const read = useCallback(async () => {
		const seq = issueRequest(providerId)
		const response = await ModelsServiceClient.readProviderConfig(StringRequest.create({ value: providerId }))
		publishConfig(providerId, seq, response)
		return response
	}, [providerId])

	useEffect(() => {
		void read()
	}, [read])

	const write = useCallback(
		async (patch: ProviderConfigWritePatch) => {
			if (scope?.writeProviderSettings) {
				await scope.writeProviderSettings(patch as Record<string, unknown>)
				return undefined
			}
			const seq = issueRequest(providerId)
			try {
				const response = await ModelsServiceClient.writeProviderConfig(
					WriteProviderConfigRequest.create({
						providerId,
						patch: toWriteProviderConfigPatch(patch),
					}),
				)
				publishConfig(providerId, seq, response)
				return response
			} catch (error) {
				// A failed write may still have partially applied host-side, and
				// its failure means no response will ever apply for this seq —
				// without a re-read, older dropped responses could leave config
				// stale (or undefined) forever. Re-read to converge on the
				// backend's actual state, but only if this write is still the
				// latest request: when a newer request is already in flight, its
				// response (or its own failure recovery) supersedes this one,
				// and a recovery read issued now could race ahead of the newer
				// write host-side and pin a pre-write snapshot as the latest.
				if (seq === entryFor(providerId).issued) {
					void read().catch(() => {})
				}
				throw error
			}
		},
		[providerId, read, scope],
	)

	const commitSelection = useCallback(
		async (mode: "plan" | "act", selection: ProviderModelSelection) => {
			if (selection.providerId !== providerId) {
				throw new Error(`selection providerId ${selection.providerId} does not match hook providerId ${providerId}`)
			}
			// A scoped panel keeps its own settings; the host's commitSelection
			// writes the session's global provider and model keys as well as
			// providers.json, so routing a second configuration through it
			// overwrites the one it is meant to sit beside.
			if (scope?.commitModelSelection) {
				await scope.commitModelSelection(selection.modelId)
				return
			}

			await ModelsServiceClient.commitModelSelection(
				CommitModelSelectionRequest.create({
					providerId,
					mode,
					modelId: selection.modelId,
					overrides:
						selection.overrides !== undefined ? toProtobufProviderModelOverrides(selection.overrides) : undefined,
				}),
			)
			await read()
		},
		[providerId, read, scope],
	)

	return { config: scopedConfig ?? config, write, commitSelection }
}

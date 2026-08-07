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
import { useCallback, useEffect, useRef, useState } from "react"
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

export function useProviderConfig(requestedProviderId: ProviderId) {
	// Which providers.json entry this panel is bound to. The Vision tab owns its
	// own, so its base URL, context window, sampler and model selection stop
	// landing on the entry Plan and Act read.
	const scope = useApiConfigurationScope()
	const providerId = requestedProviderId
	const [config, setConfig] = useState<ProviderConfigResponse | undefined>(undefined)

	// Reads and writes resolve asynchronously and can complete out of order
	// (e.g. a slow initial read landing after a user-triggered write). Only
	// the latest issued request may apply its response; anything older is
	// stale and would roll the UI state back.
	const requestSeqRef = useRef(0)
	const applyConfig = useCallback((seq: number, response: ProviderConfigResponse) => {
		if (seq !== requestSeqRef.current) {
			return
		}
		setConfig(response)
	}, [])

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
		const seq = ++requestSeqRef.current
		const response = await ModelsServiceClient.readProviderConfig(StringRequest.create({ value: providerId }))
		applyConfig(seq, response)
		return response
	}, [providerId, applyConfig])

	useEffect(() => {
		void read()
	}, [read])

	const write = useCallback(
		async (patch: ProviderConfigWritePatch) => {
			if (scope?.writeProviderSettings) {
				await scope.writeProviderSettings(patch as Record<string, unknown>)
				return undefined
			}
			const seq = ++requestSeqRef.current
			try {
				const response = await ModelsServiceClient.writeProviderConfig(
					WriteProviderConfigRequest.create({
						providerId,
						patch: toWriteProviderConfigPatch(patch),
					}),
				)
				applyConfig(seq, response)
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
				if (seq === requestSeqRef.current) {
					void read().catch(() => {})
				}
				throw error
			}
		},
		[providerId, applyConfig, read, scope],
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

import type { ApiConfiguration } from "@shared/api"
import {
	type ApiConfigurationProfile,
	findApiConfigurationProfile,
	parseApiConfigurationProfiles,
	parseApiConfigurationSnapshot,
	proposeProfileName,
	removeApiConfigurationProfile,
	serializeApiConfigurationProfiles,
	upsertApiConfigurationProfile,
} from "@shared/api-config-profiles"
import {
	type ApiConfigurationSnapshot,
	apiConfigurationSnapshotsEqual,
	applyApiConfigurationSnapshot,
	captureApiConfigurationSnapshot,
	captureProviderConfigSnapshot,
} from "@shared/api-config-snapshot"
import { CommitModelSelectionRequest } from "@shared/proto/cline/models"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import type { Mode } from "@shared/storage/types"
import { useCallback, useMemo } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { getActiveProviderAndModelId } from "@/hooks/useNormalizedApiConfiguration"
import { useProviderConfig, writeProviderConfigFor } from "@/hooks/useProviderConfig"
import { ModelsServiceClient, StateServiceClient } from "@/services/grpc-client"
import { useApiConfigurationHandlers } from "./useApiConfigurationHandlers"

const EMPTY_SNAPSHOT: ApiConfigurationSnapshot = { global: {}, mode: {} }

/**
 * Which configuration the bar is looking at.
 *
 * There is one list of profiles for the whole panel; this is only about where a
 * load lands and where a save reads from. The Vision and Agents tabs each hold
 * a configuration of their own, so a bar on either that wrote to Plan or Act
 * would save the wrong settings under a name the user chose for something else.
 */
export type ApiConfigurationProfileScope = { kind: "mode"; mode: Mode } | { kind: "vision" } | { kind: "agents" }

/**
 * The scopes that keep their own snapshot rather than reading the live panel.
 *
 * `providers.json` holds one entry per provider, and the session's own model
 * owns it — so a second and a third configuration on that provider cannot live
 * there without overwriting the first. Each of these keeps its settings, its
 * model and its context window in a settings string of its own instead
 * (`visionModeApiConfiguration`, `agentsModeApiConfiguration`), which is what
 * makes four separate context windows possible at all.
 */
type SnapshotScopeKind = "vision" | "agents"

export interface ApiConfigurationProfilesState {
	profiles: ApiConfigurationProfile[]
	/** Name of the loaded profile, or "" when the panel matches no profile. */
	activeName: string
	/** The panel has been edited since the active profile was loaded or saved. */
	isDirty: boolean
	/** A name to offer when saving what is currently in the panel. */
	suggestedName: string
	loadProfile: (name: string) => Promise<void>
	saveProfile: (name: string) => Promise<void>
	deleteProfile: (name: string) => Promise<void>
}

/**
 * The profile list behind the API configuration panel.
 *
 * One list, shared by every tab: a profile saved from the Act tab can be loaded
 * into Plan, or into Vision, because what it holds is a provider and a model
 * and the settings around them — nothing about which tab it came from.
 *
 * With separate models for Plan and Act turned off the two modes are kept
 * identical, so a load has to write both; otherwise picking a profile would
 * leave the other mode pointed at the previous model.
 */
export function useApiConfigurationProfiles(scope: ApiConfigurationProfileScope): ApiConfigurationProfilesState {
	const {
		apiConfiguration,
		apiConfigurationProfiles,
		activeApiConfigurationProfile,
		visionModeApiConfiguration,
		agentsModeApiConfiguration,
		planActSeparateModelsSetting,
	} = useExtensionState()
	const { handleFieldsChange } = useApiConfigurationHandlers()

	// A tab that keeps its own snapshot, and the snapshot it keeps. `undefined`
	// on Plan and Act, which read the panel's live configuration instead.
	const snapshotKind: SnapshotScopeKind | undefined = scope.kind === "mode" ? undefined : scope.kind
	const storedSnapshot = snapshotKind === "agents" ? agentsModeApiConfiguration : visionModeApiConfiguration

	// The provider whose providers.json entry this bar saves and loads. Read from
	// the configuration in view rather than the panel's tab, so the Vision bar
	// carries the vision model's provider and not the one Act happens to be on.
	const scopeMode: Mode = scope.kind === "mode" ? scope.mode : "act"
	const activeProviderId = useMemo(() => {
		const configuration = snapshotKind
			? (applyApiConfigurationSnapshot(parseApiConfigurationSnapshot(storedSnapshot) ?? EMPTY_SNAPSHOT, [
					"act",
				]) as ApiConfiguration)
			: apiConfiguration
		return getActiveProviderAndModelId(configuration, scopeMode).provider
	}, [snapshotKind, apiConfiguration, storedSnapshot, scopeMode])
	const { config: providerConfig, write: writeProviderConfig, commitSelection } = useProviderConfig(activeProviderId as never)

	const profiles = useMemo(() => parseApiConfigurationProfiles(apiConfigurationProfiles), [apiConfigurationProfiles])

	// What the tab in view currently holds, in the same shape a profile stores.
	const currentSnapshot = useMemo(() => {
		if (snapshotKind) {
			// Provider settings included, straight out of the snapshot. A tab that
			// owns its own (`ownsProviderSettings` on its scope context) never
			// writes them to providers.json, so reading them back from there saved
			// the *session's* context window under a name the user chose for the
			// vision or agents model — and left the dirty check comparing this tab
			// against the shared entry, which is a tab that looks unsaved whenever
			// the main model's window differs from its own.
			return parseApiConfigurationSnapshot(storedSnapshot) ?? EMPTY_SNAPSHOT
		}
		const base = captureApiConfigurationSnapshot(apiConfiguration, scopeMode)
		const captured = captureProviderConfigSnapshot(providerConfig)
		return captured === undefined ? base : { ...base, providerConfig: captured }
	}, [snapshotKind, apiConfiguration, scopeMode, storedSnapshot, providerConfig])

	// The active profile is per scope: loading one into Vision says nothing
	// about what Plan, Act and Agents are holding, so a single stored name would
	// show the wrong one on three tabs out of four.
	const activeNames = useMemo(() => parseActiveNames(activeApiConfigurationProfile), [activeApiConfigurationProfile])
	const scopeKey = snapshotKind ?? scopeMode
	const activeProfile = useMemo(
		() => findApiConfigurationProfile(profiles, activeNames[scopeKey] ?? ""),
		[profiles, activeNames, scopeKey],
	)

	const isDirty = useMemo(
		() => !!activeProfile && !apiConfigurationSnapshotsEqual(activeProfile.snapshot, currentSnapshot),
		[activeProfile, currentSnapshot],
	)

	const suggestedName = useMemo(() => {
		// An unchanged profile suggests its own name, so "Update" and "Save as"
		// agree about what the user is looking at.
		if (activeProfile && !isDirty) {
			return activeProfile.name
		}
		const configuration = snapshotKind
			? (applyApiConfigurationSnapshot(currentSnapshot, ["act"]) as ApiConfiguration)
			: apiConfiguration
		const { provider, modelId } = getActiveProviderAndModelId(configuration, scopeMode)
		return proposeProfileName(provider, modelId, profiles)
	}, [snapshotKind, scopeMode, apiConfiguration, currentSnapshot, profiles, activeProfile, isDirty])

	const writeActiveNames = useCallback(async (next: Record<string, string>, profileList?: ApiConfigurationProfile[]) => {
		await StateServiceClient.updateSettings(
			UpdateSettingsRequest.create({
				activeApiConfigurationProfile: JSON.stringify(next),
				...(profileList ? { apiConfigurationProfiles: serializeApiConfigurationProfiles(profileList) } : {}),
			}),
		)
	}, [])

	/** Writes a snapshot into whichever configuration this bar is looking at. */
	const applySnapshot = useCallback(
		async (snapshot: ApiConfigurationSnapshot) => {
			// Which model the profile is for. The settings snapshot records it
			// (`ollamaModelId` and friends), but that is not where the panel or the
			// session read it from — both go to the provider store's per-mode
			// selection. A load that wrote only the settings left the two disagreeing:
			// measured on a live install, providers.json still said
			// `v7-coder_tb:cd-q2_k` while the settings copy said
			// `a3b-coder_tb:vision-cd-iq2_xs`. The picker did not move, the session
			// would have run the old model, and because the dirty check reads the
			// settings copy, nothing even looked unsaved.
			const selection = getActiveProviderAndModelId(
				applyApiConfigurationSnapshot(snapshot, [scopeMode]) as ApiConfiguration,
				scopeMode,
			)

			if (snapshotKind) {
				// Into this tab's own snapshot and nowhere else. Writing the
				// profile's provider settings to providers.json as well put its
				// context window onto the entry the *session's* model reads, so
				// loading a profile into Vision resized Plan and Act — the one
				// window between them that having a snapshot per tab exists to end.
				const providerConfig = {
					...((snapshot.providerConfig as Record<string, unknown> | undefined) ?? {}),
					// The tab keeps its selection inside the snapshot, under the key
					// its picker reads.
					...(selection.modelId ? { selectedModelId: selection.modelId } : {}),
				}
				const stored = JSON.stringify(Object.keys(providerConfig).length > 0 ? { ...snapshot, providerConfig } : snapshot)
				// Spelled out per scope rather than written under a computed key: a
				// computed key widens the object to an index signature, and the
				// request builder then accepts it without checking the field exists.
				await StateServiceClient.updateSettings(
					UpdateSettingsRequest.create(
						snapshotKind === "agents"
							? { agentsModeApiConfiguration: stored }
							: { visionModeApiConfiguration: stored },
					),
				)
				return
			}

			const targetModes: Mode[] = planActSeparateModelsSetting ? [scopeMode] : ["plan", "act"]
			await handleFieldsChange(applyApiConfigurationSnapshot(snapshot, targetModes))

			// providers.json after the settings copy and before the model. It holds
			// the context window and the sampler, so it has to land before anything
			// can start a turn on the old sampler — but the store also mirrors the
			// context window into the legacy settings key, and writing it first let
			// the profile's own (older, or absent) copy of that key overwrite the
			// mirror on its way past.
			//
			// Onto the profile's provider, not the panel's. The hook is bound to
			// the provider being left, so a profile that also switches provider
			// wrote its context window onto the wrong entry: the provider being
			// left got a number that was never meant for it, and the profile's own
			// entry kept whatever it had — which is a profile that "still matches
			// the main profile" from the outside.
			const configTarget = selection.provider ?? activeProviderId
			if (snapshot.providerConfig) {
				if (configTarget === activeProviderId) {
					await writeProviderConfig(snapshot.providerConfig as never)
				} else {
					await writeProviderConfigFor(configTarget, snapshot.providerConfig as never)
				}
			} else {
				// A profile that carries no context window must not inherit the one
				// the last profile left behind — that is the same value showing up
				// under a different name. Cleared, so the window falls back to what
				// the model itself declares (`/api/show` for Ollama) rather than to
				// whoever was loaded before.
				//
				// `0`, not `undefined`. The patch reader treats an absent field as
				// "leave this alone" and only a value at or below zero as a clear
				// (`toProviderConfigPatch`: `contextWindow > 0 ? value : null`), so
				// sending `undefined` here was a no-op that read like a fix. The
				// Ollama panel's own field has always sent `numCtx ?? 0` for this.
				const clearContextWindow = { contextWindow: 0 } as never
				if (configTarget === activeProviderId) {
					await writeProviderConfig(clearContextWindow)
				} else {
					await writeProviderConfigFor(configTarget, clearContextWindow)
				}
			}

			if (!selection.modelId) {
				return
			}
			for (const mode of targetModes) {
				if (selection.provider === activeProviderId) {
					// Same provider: this re-reads the store, so the picker shows the
					// loaded model without waiting for a remount.
					await commitSelection(mode, { providerId: selection.provider as never, modelId: selection.modelId })
					continue
				}
				// A profile that also switches provider cannot go through the hook,
				// which is bound to the provider the panel was showing. The switch
				// rebinds it, and it re-reads on its own.
				await ModelsServiceClient.commitModelSelection(
					CommitModelSelectionRequest.create({
						providerId: selection.provider,
						mode,
						modelId: selection.modelId,
					}),
				)
			}
		},
		[
			snapshotKind,
			scopeMode,
			planActSeparateModelsSetting,
			handleFieldsChange,
			writeProviderConfig,
			commitSelection,
			activeProviderId,
		],
	)

	const loadProfile = useCallback(
		async (name: string) => {
			const profile = findApiConfigurationProfile(profiles, name)
			if (!profile) {
				return
			}
			await applySnapshot(profile.snapshot)
			await writeActiveNames({ ...activeNames, [scopeKey]: profile.name })
		},
		[profiles, applySnapshot, activeNames, scopeKey, writeActiveNames],
	)

	const saveProfile = useCallback(
		async (name: string) => {
			const trimmed = name.trim()
			if (!trimmed) {
				return
			}
			const profile: ApiConfigurationProfile = { name: trimmed, updatedAt: Date.now(), snapshot: currentSnapshot }
			await writeActiveNames({ ...activeNames, [scopeKey]: trimmed }, upsertApiConfigurationProfile(profiles, profile))
		},
		[currentSnapshot, profiles, activeNames, scopeKey, writeActiveNames],
	)

	const deleteProfile = useCallback(
		async (name: string) => {
			const remaining = removeApiConfigurationProfile(profiles, name)
			// Deleting a profile leaves every panel exactly as it is; only the
			// association with a saved name goes away, on whichever tabs had it.
			const nextNames: Record<string, string> = {}
			for (const [key, value] of Object.entries(activeNames)) {
				if (findApiConfigurationProfile(remaining, value)) {
					nextNames[key] = value
				}
			}
			await writeActiveNames(nextNames, remaining)
		},
		[profiles, activeNames, writeActiveNames],
	)

	return {
		profiles,
		activeName: activeProfile?.name ?? "",
		isDirty,
		suggestedName,
		loadProfile,
		saveProfile,
		deleteProfile,
	}
}

/**
 * Reads the per-scope active names.
 *
 * Stored as JSON keyed by scope. Earlier builds stored a bare profile name, and
 * that is still readable: it is taken as the name for every scope, which is
 * what it meant when there was only one.
 */
function parseActiveNames(raw: string | undefined): Record<string, string> {
	if (!raw) {
		return {}
	}
	try {
		const parsed = JSON.parse(raw)
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const names: Record<string, string> = {}
			for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof value === "string") {
					names[key] = value
				}
			}
			return names
		}
	} catch {
		// Not JSON: a bare name from an earlier build.
	}
	return { plan: raw, act: raw, vision: raw }
}

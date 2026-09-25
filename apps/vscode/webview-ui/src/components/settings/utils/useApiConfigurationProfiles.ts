import { PRIMARY_AGENT_NODE_ID, parseAgentNodes, serializeAgentNodes, setAgentNodeSnapshot } from "@shared/agent-nodes"
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
	PROVIDER_CONFIG_MODEL_OVERRIDES_KEY,
	profileProviderConfigFromScope,
	providerConfigPatchForProfile,
	SCOPED_MODEL_OVERRIDES_KEY,
	scopedProviderConfigFromProfile,
} from "@shared/api-config-snapshot"
import { CommitModelSelectionRequest } from "@shared/proto/cline/models"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import type { Mode } from "@shared/storage/types"
import { useCallback, useMemo } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { getActiveProviderAndModelId } from "@/hooks/useNormalizedApiConfiguration"
import {
	readProviderConfig,
	toProtobufProviderModelOverrides,
	useProviderConfig,
	writeProviderConfigFor,
} from "@/hooks/useProviderConfig"
import { ModelsServiceClient, StateServiceClient } from "@/services/grpc-client"
import { discardPendingEdits, flushPendingEdits } from "./pendingEdits"
import { SCOPED_MODEL_SETTINGS, scopedSettingsPatch } from "./scopedSettingsPatch"
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
export type ApiConfigurationProfileScope =
	| { kind: "mode"; mode: Mode }
	| { kind: "vision" }
	| { kind: "agents"; nodeId?: string }
	| { kind: "escalation" }

/**
 * The scopes that keep their own snapshot rather than reading the live panel.
 *
 * `providers.json` holds one entry per provider, and the session's own model
 * owns it — so a second and a third configuration on that provider cannot live
 * there without overwriting the first. Each of these keeps its settings, its
 * model and its context window in a settings string of its own instead
 * (`visionModeApiConfiguration`, `agentsModeApiConfiguration`,
 * `escalationModeApiConfiguration`), which is what makes five separate context
 * windows possible at all.
 */
type SnapshotScopeKind = "vision" | "agents" | "escalation"

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
		escalationModeApiConfiguration,
		agentNodes,
		planActSeparateModelsSetting,
	} = useExtensionState()
	const { handleFieldsChange } = useApiConfigurationHandlers()

	// A tab that keeps its own snapshot, and the snapshot it keeps. `undefined`
	// on Plan and Act, which read the panel's live configuration instead.
	const snapshotKind: SnapshotScopeKind | undefined = scope.kind === "mode" ? undefined : scope.kind
	// Which agent node the Agents bar is standing on. Node1's configuration is
	// `agentsModeApiConfiguration` itself; the rest live in the `agentNodes`
	// list. Without this the bar reads and writes Node1 whatever tab is
	// showing, so loading a profile onto Node2 silently replaced Node1.
	const agentNodeId = scope.kind === "agents" ? (scope.nodeId ?? PRIMARY_AGENT_NODE_ID) : undefined
	const onSecondaryAgentNode = agentNodeId !== undefined && agentNodeId !== PRIMARY_AGENT_NODE_ID
	const secondaryAgentNodes = useMemo(
		() => (onSecondaryAgentNode ? parseAgentNodes(agentNodes) : undefined),
		[onSecondaryAgentNode, agentNodes],
	)
	const storedSnapshot =
		snapshotKind === "agents"
			? onSecondaryAgentNode
				? (secondaryAgentNodes?.find((node) => node.id === agentNodeId)?.snapshot ?? "")
				: agentsModeApiConfiguration
			: snapshotKind === "escalation"
				? escalationModeApiConfiguration
				: visionModeApiConfiguration

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
		const captured = captureProviderConfigSnapshot(providerConfig, scopeMode)
		return captured === undefined ? base : { ...base, providerConfig: captured }
	}, [snapshotKind, apiConfiguration, scopeMode, storedSnapshot, providerConfig])

	// The active profile is per scope: loading one into Vision says nothing
	// about what Plan, Act, Agents and Escalation are holding, so a single
	// stored name would show the wrong one on four tabs out of five.
	const activeNames = useMemo(() => parseActiveNames(activeApiConfigurationProfile), [activeApiConfigurationProfile])
	// Per scope, and on the Agents tab per node: two nodes are two
	// configurations, so one stored name would show the wrong profile on both.
	const scopeKey = onSecondaryAgentNode ? `agents::${agentNodeId}` : (snapshotKind ?? scopeMode)
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

			// The per-turn output cap rides with the model selection rather than
			// with the provider's own fields, so it comes back out here: what is
			// left goes to providers.json, and the overrides go to the commit
			// below. A profile that carries none clears them — the same rule the
			// context window already follows, and for the same reason. Inheriting
			// the last profile's per-turn cap is that number showing up under a
			// name that never chose it.
			const profileProviderConfig = snapshot.providerConfig as Record<string, unknown> | undefined
			// Under either spelling: a profile saved from a scoped tab by an
			// earlier build carries its overrides as `selectedModelOverrides`.
			const modelOverrides = (profileProviderConfig?.[PROVIDER_CONFIG_MODEL_OVERRIDES_KEY] ??
				profileProviderConfig?.[SCOPED_MODEL_OVERRIDES_KEY] ??
				{}) as Record<string, unknown>
			// Everything the profile carries, plus a clear for every field it does
			// not — a patch only changes what it names, so the fields left out are
			// how the previous profile's values ended up under this profile's name.
			const providerPatch = providerConfigPatchForProfile(profileProviderConfig)

			if (snapshotKind) {
				// Into this tab's own snapshot and nowhere else. Writing the
				// profile's provider settings to providers.json as well put its
				// context window onto the entry the *session's* model reads, so
				// loading a profile into Vision resized Plan and Act — the one
				// window between them that having a snapshot per tab exists to end.
				//
				// Under the keys the tab reads, not the profile's: a profile files
				// the model's overrides as `modelOverrides` and the tab's panel reads
				// `selectedModelOverrides`, so a window carried only there was
				// stored where nothing on the tab looked -- the box showed a default
				// and the agents ran on the catalog's number.
				const providerConfig = {
					...scopedProviderConfigFromProfile(snapshot.providerConfig as Record<string, unknown> | undefined),
					// The tab keeps its selection inside the snapshot, under the key
					// its picker reads.
					...(selection.modelId ? { selectedModelId: selection.modelId } : {}),
				}
				const stored = JSON.stringify(Object.keys(providerConfig).length > 0 ? { ...snapshot, providerConfig } : snapshot)
				if (onSecondaryAgentNode && agentNodeId) {
					// Into the node, not into the shared key. This is the write
					// that made a profile load onto Node2 overwrite Node1.
					await StateServiceClient.updateSettings(
						UpdateSettingsRequest.create({
							agentNodes: serializeAgentNodes(
								setAgentNodeSnapshot(parseAgentNodes(agentNodes), agentNodeId, stored),
							),
						}),
					)
					return
				}
				// Through the same map the tab's own writes go through: a computed
				// key would widen the object to an index signature, and the request
				// builder then accepts it without checking the field exists.
				await StateServiceClient.updateSettings(
					UpdateSettingsRequest.create(scopedSettingsPatch(SCOPED_MODEL_SETTINGS[snapshotKind], stored)),
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
			// A profile that carries no context window must not inherit the one the
			// last profile left behind — that is the same value showing up under a
			// different name — and the tool-result cap and the sampler are no
			// different. Cleared, they fall back to what the model itself declares
			// (`/api/show` for Ollama) rather than to whoever was loaded before.
			//
			// The clears are `0` and `{}`, not `undefined`. The patch reader treats
			// an absent field as "leave this alone" and only a documented sentinel
			// as a clear (`toProviderConfigPatch`: `contextWindow > 0 ? value :
			// null`), so sending `undefined` was a no-op that read like a fix.
			const configTarget = selection.provider ?? activeProviderId
			if (configTarget === activeProviderId) {
				await writeProviderConfig(providerPatch as never)
			} else {
				await writeProviderConfigFor(configTarget, providerPatch as never)
			}

			if (!selection.modelId) {
				return
			}
			for (const mode of targetModes) {
				if (selection.provider === activeProviderId) {
					// Same provider: this re-reads the store, so the picker shows the
					// loaded model without waiting for a remount.
					await commitSelection(mode, {
						providerId: selection.provider as never,
						modelId: selection.modelId,
						overrides: modelOverrides as never,
					})
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
						overrides: toProtobufProviderModelOverrides(modelOverrides as never),
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

	/**
	 * The scopes a load actually writes to.
	 *
	 * With Plan and Act sharing a model, `applySnapshot` writes the snapshot to
	 * both — so recording the profile against only the tab it was loaded from
	 * left the other scope pointing at whatever was loaded before it, or at
	 * nothing. That is not cosmetic: the session reads its provider settings
	 * from the profile named for *its* mode, so Plan and Act could resolve two
	 * different context windows from one load, and a machine that had only ever
	 * loaded profiles from the Act tab had no `plan` entry at all.
	 */
	const loadedScopes = useMemo(
		() => (snapshotKind ? [scopeKey] : planActSeparateModelsSetting ? [scopeMode] : ["plan", "act"]),
		[snapshotKind, scopeKey, planActSeparateModelsSetting, scopeMode],
	)

	const loadProfile = useCallback(
		async (name: string) => {
			const profile = findApiConfigurationProfile(profiles, name)
			if (!profile) {
				return
			}
			// Dropped, not saved: this is also the Revert button, and a field
			// whose debounce fires after the profile has been re-applied writes
			// the value the user just asked to discard straight back over it.
			discardPendingEdits()
			await applySnapshot(profile.snapshot)
			const next = { ...activeNames }
			for (const scope of loadedScopes) {
				next[scope] = profile.name
			}
			await writeActiveNames(next)
		},
		[profiles, applySnapshot, activeNames, loadedScopes, writeActiveNames],
	)

	/**
	 * The panel as it stands, read after the fields have been made to save.
	 *
	 * `currentSnapshot` is a memo, so it holds what the last render saw. Every
	 * numeric field in the sampler waits 800ms before it writes, and a save
	 * inside that window captured the configuration from before the values were
	 * typed -- while the values themselves reached providers.json a moment
	 * later, where only the running session could see them. Measured: a session
	 * running `temp 0.700 / repeat_penalty 1.250 / presence_penalty 0.150` on
	 * the server's own sampler dump, and three profiles saved that afternoon
	 * carrying no sampler at all.
	 *
	 * So: end the wait, wait for the writes, then read the store directly
	 * rather than the memo that predates them. The settings half still comes
	 * from `apiConfiguration`; its fields write through the same flush, and the
	 * provider half is where the sampler lives.
	 */
	const captureSettledSnapshot = useCallback(async (): Promise<ApiConfigurationSnapshot> => {
		await flushPendingEdits()
		if (snapshotKind) {
			// Without the tab's own picker key: the profile is the same one Plan
			// and Act load, and a key only this kind of tab writes made it read as
			// changed there. A load puts it back (`applySnapshot`).
			//
			// And in the profile's spelling: the window under `contextWindow`
			// whichever field the tab held it in, the overrides under
			// `modelOverrides`, so the profile loads into Plan or Act with both.
			const providerConfig = currentSnapshot.providerConfig as Record<string, unknown> | undefined
			return providerConfig
				? { ...currentSnapshot, providerConfig: profileProviderConfigFromScope(providerConfig) }
				: currentSnapshot
		}
		const base = captureApiConfigurationSnapshot(apiConfiguration, scopeMode)
		const captured = captureProviderConfigSnapshot(readProviderConfig(activeProviderId as string), scopeMode)
		return captured === undefined ? base : { ...base, providerConfig: captured }
	}, [snapshotKind, currentSnapshot, apiConfiguration, scopeMode, activeProviderId])

	const saveProfile = useCallback(
		async (name: string) => {
			const trimmed = name.trim()
			if (!trimmed) {
				return
			}
			const snapshot = await captureSettledSnapshot()
			const profile: ApiConfigurationProfile = { name: trimmed, updatedAt: Date.now(), snapshot }
			// The same scopes a load writes: saving from the Act tab while Plan
			// shares its model has named the profile for both, and leaving Plan
			// on the previous name would make the next Plan session resolve from
			// a profile the user has replaced.
			const next = { ...activeNames }
			for (const scope of loadedScopes) {
				next[scope] = trimmed
			}
			await writeActiveNames(next, upsertApiConfigurationProfile(profiles, profile))
		},
		[captureSettledSnapshot, profiles, activeNames, loadedScopes, writeActiveNames],
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

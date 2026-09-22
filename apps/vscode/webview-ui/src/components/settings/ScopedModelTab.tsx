import type { ApiConfiguration } from "@shared/api"
import { parseApiConfigurationSnapshot } from "@shared/api-config-profiles"
import { applyApiConfigurationSnapshot, captureApiConfigurationSnapshot } from "@shared/api-config-snapshot"
import { UpdateApiConfigurationRequest } from "@shared/proto/cline/models"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { convertApiConfigurationToProto } from "@shared/proto-conversions/models/api-configuration-conversion"
import { SecretKeys } from "@shared/storage/state-keys"
import { useCallback, useMemo, useRef } from "react"
import { ExtensionStateContext, useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient, StateServiceClient } from "@/services/grpc-client"
import ApiOptions from "./ApiOptions"
import { ApiConfigurationScopeContext, type ScopedModelSelection } from "./utils/ApiConfigurationScopeContext"
import { type ScopedModelSetting, scopedSettingsPatch } from "./utils/scopedSettingsPatch"
import { createScopedSnapshotWriter, scopedSnapshotPatches } from "./utils/scopedSnapshotWriter"

const EMPTY_SNAPSHOT = { global: {}, mode: {} }

/**
 * The API configuration panel, pointed at a model that is not the session's.
 *
 * Three of these exist: the vision model, which turns images into text for a
 * primary model that cannot read them; the agents model, which subagents and
 * teammates run on instead of the lead's; and the escalation model, the expert
 * a stuck session hands the task to. All three need the same settings as any
 * other model, so this renders the same panel rather than a reduced copy of it — the panel is shown an overridden extension state to read from and a
 * scope to write to, and never learns it is being used for something else.
 *
 * The configuration is kept in a settings string of its own rather than in
 * `providers.json`, which holds one entry per provider: a second and a third
 * configuration on the same provider have nowhere to go there without
 * overwriting the first. That is what lets Plan, Act, Vision, Agents and
 * Escalation each hold a context window of their own.
 *
 * There is no Plan/Act distinction here, so both modes are written with the
 * same values and the panel is shown the configuration as if the separate-model
 * setting were off.
 *
 * Every write goes through one {@link createScopedSnapshotWriter}. The settings
 * string arrives as a prop, a round trip behind, and using it as the base for a
 * write is what made this tab lose edits — see that file for the measurement.
 */
const ScopedModelTab = ({
	setting,
	storedSnapshot,
	writeSnapshot,
	scopeKey,
}: {
	setting: ScopedModelSetting
	storedSnapshot: string
	/**
	 * Where this panel's configuration is stored, when it is not the settings
	 * key. Agent nodes past Node1 keep theirs inside the `agentNodes` list, so
	 * a second and a third agents configuration have somewhere to live —
	 * `setting` still says which *kind* of tab this is, which is what the
	 * profile bar and the sampler read.
	 */
	writeSnapshot?: (json: string) => Promise<void>
	/**
	 * What the sampler's stored entry is keyed on. Two nodes on one provider
	 * are two different configurations, and sharing a key makes the second
	 * overwrite the first.
	 */
	scopeKey?: string
}) => {
	const state = useExtensionState()
	const { apiConfiguration } = state

	const persist = useCallback(
		async (snapshot: unknown) => {
			const json = JSON.stringify(snapshot)
			if (writeSnapshot) {
				await writeSnapshot(json)
				return
			}
			await StateServiceClient.updateSettings(UpdateSettingsRequest.create(scopedSettingsPatch(setting, json)))
		},
		[setting, writeSnapshot],
	)

	const writerRef = useRef<ReturnType<typeof createScopedSnapshotWriter> | undefined>(undefined)
	if (!writerRef.current) {
		writerRef.current = createScopedSnapshotWriter(parseApiConfigurationSnapshot(storedSnapshot) ?? EMPTY_SNAPSHOT, persist)
	}
	const writer = writerRef.current

	// What the panel renders from. `storedSnapshot` is the signal that the held
	// snapshot may have moved; the value itself comes from the writer, so a
	// field re-rendered before its write is acknowledged still shows the edit.
	//
	// A snapshot arriving from anywhere else — a profile load, another window —
	// is adopted here, in the same pass that reads it, and taken only when none
	// of our own writes are still in flight: mid-flight the prop is the state
	// from before the edit.
	//
	// Adopting in an effect instead is what made a profile load do nothing.
	// Effects run after render, so the read below was a render ahead of the
	// adoption, and the writer keeps its snapshot in a closure variable rather
	// than in state — so nothing re-rendered to correct it. The configuration
	// appeared only once something else forced a render, which on the Agents
	// tab meant switching to another node and back. `adopt` is a no-op for an
	// unchanged value, so running it during render costs nothing and repeats
	// safely.
	const heldSnapshot = useMemo(() => {
		writer.adopt(parseApiConfigurationSnapshot(storedSnapshot) ?? EMPTY_SNAPSHOT)
		return writer.current()
	}, [storedSnapshot, writer])

	const scopedConfiguration = useMemo(() => {
		const settings = applyApiConfigurationSnapshot(heldSnapshot, ["plan", "act"])
		// API keys are not part of a snapshot: they are stored per provider and
		// shared with the rest of the app. Carrying the live ones in means the
		// panel shows the key it will actually use.
		const secrets: Record<string, unknown> = {}
		for (const key of SecretKeys as readonly string[]) {
			secrets[key] = (apiConfiguration as Record<string, unknown>)?.[key]
		}
		return { ...secrets, ...settings } as ApiConfiguration
	}, [heldSnapshot, apiConfiguration])

	// The provider settings this tab holds, kept in its own snapshot rather than
	// in providers.json. The host's store writes the session's global provider
	// and model keys alongside the file, so a second configuration cannot live
	// there without overwriting the first.
	const storedProviderSettings = useMemo(() => heldSnapshot.providerConfig ?? {}, [heldSnapshot])

	const scope = useMemo(
		() => ({
			ownsProviderSettings: true,
			providerSettings: storedProviderSettings,
			scopeKey: scopeKey ?? setting,
			writeProviderSettings: async (patch: Record<string, unknown>) => {
				await writer.mutate(scopedSnapshotPatches.providerSettings(patch))
			},
			// Stored beside the id so the panel reads back what it committed:
			// Per-Turn Max Output Tokens travels in `overrides`.
			commitModelSelection: async (selection: ScopedModelSelection) => {
				await writer.mutate(scopedSnapshotPatches.modelSelection(selection))
			},
			save: async (updated: ApiConfiguration) => {
				await writer.mutate(scopedSnapshotPatches.settings(captureApiConfigurationSnapshot(updated, "act")))
				// An API key typed on this tab belongs to its provider, not to this
				// tab, and is stored where every other part of the app looks for it.
				// Without this it would be dropped on the way into the snapshot.
				const changedSecrets: Record<string, unknown> = {}
				for (const key of SecretKeys as readonly string[]) {
					const next = (updated as Record<string, unknown>)[key]
					if (next !== undefined && next !== (apiConfiguration as Record<string, unknown>)?.[key]) {
						changedSecrets[key] = next
					}
				}
				if (Object.keys(changedSecrets).length > 0) {
					await ModelsServiceClient.updateApiConfigurationProto(
						UpdateApiConfigurationRequest.create({
							apiConfiguration: convertApiConfigurationToProto({
								...apiConfiguration,
								...changedSecrets,
							} as ApiConfiguration),
						}),
					)
				}
			},
		}),
		[apiConfiguration, setting, scopeKey, storedProviderSettings, writer],
	)

	const scopedState = useMemo(
		() => ({
			...state,
			apiConfiguration: scopedConfiguration,
			planActSeparateModelsSetting: false,
		}),
		[state, scopedConfiguration],
	)

	return (
		<ExtensionStateContext.Provider value={scopedState}>
			<ApiConfigurationScopeContext.Provider value={scope}>
				<ApiOptions currentMode="act" showModelOptions={true} />
			</ApiConfigurationScopeContext.Provider>
		</ExtensionStateContext.Provider>
	)
}

export default ScopedModelTab

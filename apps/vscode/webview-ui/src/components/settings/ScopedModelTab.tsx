import type { ApiConfiguration } from "@shared/api"
import { parseApiConfigurationSnapshot } from "@shared/api-config-profiles"
import { applyApiConfigurationSnapshot, captureApiConfigurationSnapshot } from "@shared/api-config-snapshot"
import { UpdateApiConfigurationRequest } from "@shared/proto/cline/models"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { convertApiConfigurationToProto } from "@shared/proto-conversions/models/api-configuration-conversion"
import { SecretKeys } from "@shared/storage/state-keys"
import { useCallback, useMemo } from "react"
import { ExtensionStateContext, useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient, StateServiceClient } from "@/services/grpc-client"
import ApiOptions from "./ApiOptions"
import { ApiConfigurationScopeContext } from "./utils/ApiConfigurationScopeContext"

const EMPTY_SNAPSHOT = { global: {}, mode: {} }

/** The settings string a scoped tab stores its whole configuration in. */
export type ScopedModelSetting = "visionModeApiConfiguration" | "agentsModeApiConfiguration"

/**
 * The API configuration panel, pointed at a model that is not the session's.
 *
 * Two of these exist: the vision model, which turns images into text for a
 * primary model that cannot read them, and the agents model, which subagents
 * and teammates run on instead of the lead's. Both need the same settings as
 * any other model, so this renders the same panel rather than a reduced copy of
 * it — the panel is shown an overridden extension state to read from and a
 * scope to write to, and never learns it is being used for something else.
 *
 * The configuration is kept in a settings string of its own rather than in
 * `providers.json`, which holds one entry per provider: a second and a third
 * configuration on the same provider have nowhere to go there without
 * overwriting the first. That is what lets Plan, Act, Vision and Agents each
 * hold a context window of their own.
 *
 * There is no Plan/Act distinction here, so both modes are written with the
 * same values and the panel is shown the configuration as if the separate-model
 * setting were off.
 */
const ScopedModelTab = ({ setting, storedSnapshot }: { setting: ScopedModelSetting; storedSnapshot: string }) => {
	const state = useExtensionState()
	const { apiConfiguration } = state

	const scopedConfiguration = useMemo(() => {
		const snapshot = parseApiConfigurationSnapshot(storedSnapshot) ?? EMPTY_SNAPSHOT
		const settings = applyApiConfigurationSnapshot(snapshot, ["plan", "act"])
		// API keys are not part of a snapshot: they are stored per provider and
		// shared with the rest of the app. Carrying the live ones in means the
		// panel shows the key it will actually use.
		const secrets: Record<string, unknown> = {}
		for (const key of SecretKeys as readonly string[]) {
			secrets[key] = (apiConfiguration as Record<string, unknown>)?.[key]
		}
		return { ...secrets, ...settings } as ApiConfiguration
	}, [storedSnapshot, apiConfiguration])

	// The provider settings this tab holds, kept in its own snapshot rather than
	// in providers.json. The host's store writes the session's global provider
	// and model keys alongside the file, so a second configuration cannot live
	// there without overwriting the first.
	const storedProviderSettings = useMemo(() => {
		const snapshot = parseApiConfigurationSnapshot(storedSnapshot)
		const held = (snapshot as { providerConfig?: Record<string, unknown> } | undefined)?.providerConfig
		return held ?? {}
	}, [storedSnapshot])

	// Spelled out per setting rather than computed from `setting`: a computed key
	// widens the object to an index signature and the request builder then takes
	// it without checking that the field exists at all.
	const settingsPatch = useCallback(
		(json: string) =>
			setting === "agentsModeApiConfiguration"
				? { agentsModeApiConfiguration: json }
				: { visionModeApiConfiguration: json },
		[setting],
	)

	const writeSnapshot = useCallback(
		async (next: Record<string, unknown>) => {
			const snapshot = parseApiConfigurationSnapshot(storedSnapshot) ?? EMPTY_SNAPSHOT
			await StateServiceClient.updateSettings(
				UpdateSettingsRequest.create(settingsPatch(JSON.stringify({ ...snapshot, providerConfig: next }))),
			)
		},
		[storedSnapshot, settingsPatch],
	)

	const scope = useMemo(
		() => ({
			ownsProviderSettings: true,
			providerSettings: storedProviderSettings,
			writeProviderSettings: async (patch: Record<string, unknown>) => {
				await writeSnapshot({ ...storedProviderSettings, ...patch })
			},
			commitModelSelection: async (modelId: string) => {
				await writeSnapshot({ ...storedProviderSettings, selectedModelId: modelId })
			},
			save: async (updated: ApiConfiguration) => {
				// The captured snapshot holds only the settings sections, so the
				// provider settings have to be carried across or every edit to any
				// other field would drop the model this tab is pointed at.
				await StateServiceClient.updateSettings(
					UpdateSettingsRequest.create(
						settingsPatch(
							JSON.stringify({
								...captureApiConfigurationSnapshot(updated, "act"),
								...(Object.keys(storedProviderSettings).length > 0
									? { providerConfig: storedProviderSettings }
									: {}),
							}),
						),
					),
				)
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
		[apiConfiguration, storedProviderSettings, writeSnapshot, settingsPatch],
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

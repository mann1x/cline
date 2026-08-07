import type { ApiConfiguration } from "@shared/api"
import { parseApiConfigurationSnapshot } from "@shared/api-config-profiles"
import { applyApiConfigurationSnapshot, captureApiConfigurationSnapshot } from "@shared/api-config-snapshot"
import { UpdateApiConfigurationRequest } from "@shared/proto/cline/models"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { convertApiConfigurationToProto } from "@shared/proto-conversions/models/api-configuration-conversion"
import { SecretKeys } from "@shared/storage/state-keys"
import { useMemo } from "react"
import { ExtensionStateContext, useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient, StateServiceClient } from "@/services/grpc-client"
import ApiOptions from "./ApiOptions"
import { ApiConfigurationScopeContext } from "./utils/ApiConfigurationScopeContext"

const EMPTY_SNAPSHOT = { global: {}, mode: {} }

/**
 * The API configuration panel, pointed at the vision model.
 *
 * The vision model is a second model that reads an image and hands text back to
 * the primary one. It needs the same settings as any other model, so this
 * renders the same panel rather than a reduced copy of it — the panel is shown
 * an overridden extension state to read from and a scope to write to, and never
 * learns it is being used for something else.
 *
 * There is no Plan/Act distinction here, so both modes are written with the
 * same values and the panel is shown the configuration as if the separate-model
 * setting were off.
 */
const VisionModelTab = () => {
	const state = useExtensionState()
	const { visionModeApiConfiguration, apiConfiguration } = state

	const visionConfiguration = useMemo(() => {
		const snapshot = parseApiConfigurationSnapshot(visionModeApiConfiguration) ?? EMPTY_SNAPSHOT
		const settings = applyApiConfigurationSnapshot(snapshot, ["plan", "act"])
		// API keys are not part of a snapshot: they are stored per provider and
		// shared with the rest of the app. Carrying the live ones in means the
		// panel shows the key it will actually use.
		const secrets: Record<string, unknown> = {}
		for (const key of SecretKeys as readonly string[]) {
			secrets[key] = (apiConfiguration as Record<string, unknown>)?.[key]
		}
		return { ...secrets, ...settings } as ApiConfiguration
	}, [visionModeApiConfiguration, apiConfiguration])

	const scope = useMemo(
		() => ({
			save: async (updated: ApiConfiguration) => {
				await StateServiceClient.updateSettings(
					UpdateSettingsRequest.create({
						visionModeApiConfiguration: JSON.stringify(captureApiConfigurationSnapshot(updated, "act")),
					}),
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
		[apiConfiguration],
	)

	const scopedState = useMemo(
		() => ({
			...state,
			apiConfiguration: visionConfiguration,
			planActSeparateModelsSetting: false,
		}),
		[state, visionConfiguration],
	)

	return (
		<ExtensionStateContext.Provider value={scopedState}>
			<ApiConfigurationScopeContext.Provider value={scope}>
				<ApiOptions currentMode="act" showModelOptions={true} />
			</ApiConfigurationScopeContext.Provider>
		</ExtensionStateContext.Provider>
	)
}

export default VisionModelTab

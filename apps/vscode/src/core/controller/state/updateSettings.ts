import { setCompactionStrategyGlobally } from "@cline/core"
import { Empty } from "@shared/proto/cline/common"
import { PlanActMode, McpDisplayMode as ProtoMcpDisplayMode, UpdateSettingsRequest } from "@shared/proto/cline/state"
import { convertProtoToApiProvider } from "@shared/proto-conversions/models/api-configuration-conversion"
import { OpenaiReasoningEffort } from "@shared/storage/types"
import { TelemetrySetting } from "@shared/TelemetrySetting"
import { ClineEnv } from "@/config"
import { fetchRemoteConfig } from "@/core/storage/remote-config/fetch"
import { clearRemoteConfig } from "@/core/storage/remote-config/utils"
import { updateQaCredentials } from "@/sdk/qa-credentials-store"
import { McpDisplayMode } from "@/shared/McpDisplayMode"
import { Logger } from "@/shared/services/Logger"
import { telemetryService } from "../../../services/telemetry"
import { BrowserSettings as SharedBrowserSettings } from "../../../shared/BrowserSettings"
import { Controller } from ".."
import { accountLogoutClicked } from "../account/accountLogoutClicked"
import { normalizeProviderSwitchModel } from "../models/providerSwitchNormalization"
import { createTaskApiModelShim, resolveActiveModelIdFromApiConfiguration } from "../models/taskApiModel"

/**
 * Updates multiple extension settings in a single request
 * @param controller The controller instance
 * @param request The request containing the settings to update
 * @returns An empty response
 */
export async function updateSettings(controller: Controller, request: UpdateSettingsRequest): Promise<Empty> {
	try {
		if (request.clineEnv !== undefined && request.clineEnv !== "") {
			ClineEnv.setEnvironment(request.clineEnv)
			await accountLogoutClicked(controller, Empty.create())
		}

		if (request.apiConfiguration) {
			const protoApiConfiguration = request.apiConfiguration

			const convertedApiConfigurationFromProto = {
				...protoApiConfiguration,
				// Convert proto ApiProvider enums to native string types
				planModeApiProvider: protoApiConfiguration.planModeApiProvider
					? convertProtoToApiProvider(protoApiConfiguration.planModeApiProvider)
					: undefined,
				actModeApiProvider: protoApiConfiguration.actModeApiProvider
					? convertProtoToApiProvider(protoApiConfiguration.actModeApiProvider)
					: undefined,
				planModeReasoningEffort: protoApiConfiguration.planModeReasoningEffort as OpenaiReasoningEffort | undefined,
				actModeReasoningEffort: protoApiConfiguration.actModeReasoningEffort as OpenaiReasoningEffort | undefined,
			}

			const previousApiConfiguration = controller.stateManager.getApiConfiguration()
			const normalizedApiConfiguration = normalizeProviderSwitchModel(
				controller.getProviderConfigStore(),
				previousApiConfiguration,
				convertedApiConfigurationFromProto,
			)

			controller.stateManager.setApiConfiguration(normalizedApiConfiguration)

			if (controller.task) {
				const currentMode = controller.stateManager.getGlobalSettingsKey("mode")
				const modelId = resolveActiveModelIdFromApiConfiguration(normalizedApiConfiguration, currentMode)
				controller.task.api = createTaskApiModelShim(modelId)
			}
			controller.handleApiConfigurationChanged(previousApiConfiguration, normalizedApiConfiguration)
		}

		// Update telemetry setting
		if (request.telemetrySetting) {
			await controller.updateTelemetrySetting(request.telemetrySetting as TelemetrySetting)
		}

		// Update plan/act separate models setting
		if (request.planActSeparateModelsSetting !== undefined) {
			controller.stateManager.setGlobalState("planActSeparateModelsSetting", request.planActSeparateModelsSetting)
		}

		// Vision model: a second model that reads images for a primary one that
		// cannot. The configuration and the profile list travel as JSON strings;
		// see `@shared/api-config-snapshot` for why they are not proto messages.
		if (request.visionModelEnabled !== undefined) {
			controller.stateManager.setGlobalState("visionModelEnabled", request.visionModelEnabled)
		}
		if (request.visionModeApiConfiguration !== undefined) {
			controller.stateManager.setGlobalState("visionModeApiConfiguration", request.visionModeApiConfiguration)
		}
		// Delegated agents: the same arrangement, for the model subagents and
		// teammates run on rather than the one driving the session.
		if (request.agentsModelEnabled !== undefined) {
			controller.stateManager.setGlobalState("agentsModelEnabled", request.agentsModelEnabled)
		}
		if (request.agentsModeApiConfiguration !== undefined) {
			controller.stateManager.setGlobalState("agentsModeApiConfiguration", request.agentsModeApiConfiguration)
		}
		if (request.apiConfigurationProfiles !== undefined) {
			controller.stateManager.setGlobalState("apiConfigurationProfiles", request.apiConfigurationProfiles)
		}
		if (request.activeApiConfigurationProfile !== undefined) {
			controller.stateManager.setGlobalState("activeApiConfigurationProfile", request.activeApiConfigurationProfile)
		}

		// Update checkpoints setting
		if (request.enableCheckpointsSetting !== undefined) {
			controller.stateManager.setGlobalState("enableCheckpointsSetting", request.enableCheckpointsSetting)
		}

		// Update MCP responses collapsed setting
		if (request.mcpResponsesCollapsed !== undefined) {
			controller.stateManager.setGlobalState("mcpResponsesCollapsed", request.mcpResponsesCollapsed)
		}

		// Update MCP display mode setting
		if (request.mcpDisplayMode !== undefined) {
			// Convert proto enum to string type
			let displayMode: McpDisplayMode
			switch (request.mcpDisplayMode) {
				case ProtoMcpDisplayMode.RICH:
					displayMode = "rich"
					break
				case ProtoMcpDisplayMode.PLAIN:
					displayMode = "plain"
					break
				case ProtoMcpDisplayMode.MARKDOWN:
					displayMode = "markdown"
					break
				default:
					throw new Error(`Invalid MCP display mode value: ${request.mcpDisplayMode}`)
			}
			controller.stateManager.setGlobalState("mcpDisplayMode", displayMode)
		}

		if (request.mode !== undefined) {
			const mode = request.mode === PlanActMode.PLAN ? "plan" : "act"
			controller.stateManager.setGlobalState("mode", mode)
		}

		if (request.preferredLanguage !== undefined) {
			controller.stateManager.setGlobalState("preferredLanguage", request.preferredLanguage)
		}

		// Update terminal timeout setting
		if (request.shellIntegrationTimeout !== undefined) {
			controller.stateManager.setGlobalState("shellIntegrationTimeout", Number(request.shellIntegrationTimeout))
			controller.terminalManager?.setShellIntegrationTimeout(Number(request.shellIntegrationTimeout))
		}

		// How much of a single tool result survives into the provider request.
		// Zero clears the override and hands the decision back to the SDK.
		if (request.maxToolResultChars !== undefined) {
			const requested = Number(request.maxToolResultChars)
			controller.stateManager.setGlobalState(
				"maxToolResultChars",
				Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0,
			)
		}

		// Update terminal reuse setting
		if (request.terminalReuseEnabled !== undefined) {
			controller.stateManager.setGlobalState("terminalReuseEnabled", request.terminalReuseEnabled)
			controller.terminalManager?.setTerminalReuseEnabled(!!request.terminalReuseEnabled)
		}

		if (request.vscodeTerminalExecutionMode !== undefined && request.vscodeTerminalExecutionMode !== "") {
			const previousMode = controller.stateManager.getGlobalStateKey("vscodeTerminalExecutionMode")
			const nextMode = request.vscodeTerminalExecutionMode === "backgroundExec" ? "backgroundExec" : "vscodeTerminal"
			controller.stateManager.setGlobalState("vscodeTerminalExecutionMode", nextMode)
			controller.handleTerminalExecutionModeChanged(previousMode, nextMode)
		}

		if (request.hooksEnabled !== undefined) {
			const wasEnabled = controller.stateManager.getGlobalSettingsKey("hooksEnabled") ?? true
			const isEnabled = !!request.hooksEnabled
			controller.stateManager.setGlobalState("hooksEnabled", isEnabled)
			if (controller.task && wasEnabled !== isEnabled) {
				telemetryService.captureFeatureToggle(controller.task.ulid, "hooks", isEnabled, controller.task.api.getModel().id)
			}
		}
		// Update yolo mode setting
		if (request.yoloModeToggled !== undefined) {
			if (controller.task) {
				telemetryService.captureYoloModeToggle(controller.task.ulid, request.yoloModeToggled)
			}
			controller.stateManager.setGlobalState("yoloModeToggled", request.yoloModeToggled)
		}

		// Update worktrees setting
		if (request.worktreesEnabled !== undefined) {
			controller.stateManager.setGlobalState("worktreesEnabled", request.worktreesEnabled)
		}

		// Update subagents setting
		if (request.subagentsEnabled !== undefined) {
			const wasEnabled = controller.stateManager.getGlobalSettingsKey("subagentsEnabled") ?? false
			const isEnabled = !!request.subagentsEnabled
			controller.stateManager.setGlobalState("subagentsEnabled", isEnabled)

			// Capture telemetry when setting changes
			if (wasEnabled !== isEnabled) {
				telemetryService.captureSubagentToggle(isEnabled)
			}
		}

		// Update auto-condense setting
		if (request.compactionPrompt !== undefined) {
			controller.stateManager.setGlobalState("compactionPrompt", request.compactionPrompt)
		}

		if (request.thinkingCompactionEnabled !== undefined) {
			controller.stateManager.setGlobalState("thinkingCompactionEnabled", request.thinkingCompactionEnabled)
		}

		if (request.thinkingCompactionPrompt !== undefined) {
			controller.stateManager.setGlobalState("thinkingCompactionPrompt", request.thinkingCompactionPrompt)
		}

		if (request.cappedThinkingEnabled !== undefined) {
			controller.stateManager.setGlobalState("cappedThinkingEnabled", request.cappedThinkingEnabled)
		}

		if (request.cappedThinkingPrompt !== undefined) {
			controller.stateManager.setGlobalState("cappedThinkingPrompt", request.cappedThinkingPrompt)
		}

		if (request.useAutoCondense !== undefined) {
			if (controller.task) {
				telemetryService.captureAutoCondenseToggle(
					controller.task.ulid,
					request.useAutoCondense,
					controller.task.api.getModel().id,
				)
			}
			controller.stateManager.setGlobalState("useAutoCondense", request.useAutoCondense)
		}

		if (request.compactionStrategy !== undefined) {
			const strategy = request.compactionStrategy
			if (strategy !== "basic" && strategy !== "agentic") {
				throw new Error(`Invalid compaction strategy value: ${strategy}`)
			}
			setCompactionStrategyGlobally(strategy)
		}

		// Update browser settings
		if (request.browserSettings !== undefined) {
			// Get current browser settings to preserve fields not in the request
			const currentSettings = controller.stateManager.getGlobalSettingsKey("browserSettings")

			// Convert from protobuf format to shared format, merging with existing settings
			const newBrowserSettings: SharedBrowserSettings = {
				...currentSettings, // Start with existing settings (and defaults)
				viewport: {
					// Apply updates from request
					width: request.browserSettings.viewport?.width || currentSettings.viewport.width,
					height: request.browserSettings.viewport?.height || currentSettings.viewport.height,
				},
				// Explicitly handle optional boolean and string fields from the request
				remoteBrowserEnabled:
					request.browserSettings.remoteBrowserEnabled === undefined
						? currentSettings.remoteBrowserEnabled
						: request.browserSettings.remoteBrowserEnabled,
				remoteBrowserHost:
					request.browserSettings.remoteBrowserHost === undefined
						? currentSettings.remoteBrowserHost
						: request.browserSettings.remoteBrowserHost,
				chromeExecutablePath:
					// If chromeExecutablePath is explicitly in the request (even as ""), use it.
					// Otherwise, fall back to mergedWithDefaults.
					"chromeExecutablePath" in request.browserSettings
						? request.browserSettings.chromeExecutablePath
						: currentSettings.chromeExecutablePath,
				disableToolUse:
					request.browserSettings.disableToolUse === undefined
						? currentSettings.disableToolUse
						: request.browserSettings.disableToolUse,
				customArgs:
					"customArgs" in request.browserSettings ? request.browserSettings.customArgs : currentSettings.customArgs,
			}

			// Update global state with new settings
			controller.stateManager.setGlobalState("browserSettings", newBrowserSettings)
		}

		// Update default terminal profile
		if (request.defaultTerminalProfile !== undefined) {
			controller.stateManager.setGlobalState("defaultTerminalProfile", request.defaultTerminalProfile)
			// Update the live terminal manager so new terminals use the new profile.
			// Existing terminals are left open — they're keyed by effective shell
			// and reused when compatible, or skipped when not. No session rebuild
			// is needed: the run_commands tool re-reads the profile each time a
			// model request is built, so the description and execution both pick
			// up the new shell at the next request boundary.
			controller.terminalManager?.setDefaultTerminalProfile(request.defaultTerminalProfile)
		}

		if (request.backgroundEditEnabled !== undefined) {
			controller.stateManager.setGlobalState("backgroundEditEnabled", !!request.backgroundEditEnabled)
		}

		if (request.multiRootEnabled !== undefined) {
			controller.stateManager.setGlobalState("multiRootEnabled", !!request.multiRootEnabled)
		}

		if (request.optOutOfRemoteConfig !== undefined) {
			const hadOptedOut = controller.stateManager.getGlobalSettingsKey("optOutOfRemoteConfig")
			const isOptingOut = !!request.optOutOfRemoteConfig
			const isReenablingRemoteConfig = !isOptingOut && hadOptedOut

			// Update now so any subsequent function can access the updated value
			controller.stateManager.setGlobalState("optOutOfRemoteConfig", isOptingOut)

			if (isOptingOut && !hadOptedOut) {
				clearRemoteConfig()
			} else if (isReenablingRemoteConfig) {
				// Fire-and-forget: We don't need to await here
				// The function catches any errors and posts the updated state to the webview
				// The immediate state update below shows the user's intent (opted-in),
				// and we apply the actual config afterwards without blocking the settings update
				fetchRemoteConfig(controller)
			}
		}

		if (request.showFeatureTips !== undefined) {
			controller.stateManager.setGlobalState("showFeatureTips", request.showFeatureTips)
		}

		// Merged onto the stored value rather than assigned: the settings UI sends
		// only the field it changed, and proto3 gives an absent number the same
		// wire form as zero — assigning the request wholesale would reset the
		// reminder interval to 0 (i.e. remind on every message) whenever the
		// toggle is flipped.
		// The QA guard's insistence. Stored whole rather than merged: `mode` is
		// the only field, and an unknown value would leave the guard in a state
		// nothing downstream knows how to read.
		if (request.editVerificationSettings !== undefined) {
			const mode = request.editVerificationSettings.mode
			if (mode === "off" || mode === "nudge" || mode === "require") {
				controller.stateManager.setGlobalState("editVerificationSettings", { mode })
			}
		}

		// The change protocol. Merged onto what is stored rather than assigned:
		// proto3 gives an absent number the same wire form as zero, so a request
		// that carries only the mode would otherwise set the change limit to zero
		// and arm the protocol to a combination the user never chose.
		if (request.atomicProtocolSettings !== undefined) {
			const stored = controller.stateManager.getGlobalSettingsKey("atomicProtocolSettings")
			const mode = request.atomicProtocolSettings.mode
			const maxChanges = request.atomicProtocolSettings.maxChanges
			const maxTransactions = request.atomicProtocolSettings.maxTransactions
			controller.stateManager.setGlobalState("atomicProtocolSettings", {
				...stored,
				...(mode === "off" || mode === "auto" || mode === "always" ? { mode } : {}),
				...(request.atomicProtocolSettings.oracleCommand !== undefined
					? { oracleCommand: request.atomicProtocolSettings.oracleCommand }
					: {}),
				...(maxChanges > 0 ? { maxChanges } : {}),
				...(maxTransactions > 0 ? { maxTransactions } : {}),
			})
		}

		// QA credentials. A delta, because the settings view knows the names and
		// never the values, so it has nothing to send back for one the user did
		// not touch. Rejected entries are logged by name in the store; nothing
		// here echoes a value anywhere, and none of it reaches `state_json`.
		if (request.qaCredentials !== undefined) {
			updateQaCredentials({
				set: request.qaCredentials.set.map((credential) => ({
					name: credential.name,
					value: credential.value,
				})),
				remove: request.qaCredentials.remove,
			})
		}

		if (request.focusChainSettings !== undefined) {
			const current = controller.stateManager.getGlobalSettingsKey("focusChainSettings")
			const remindClineInterval = request.focusChainSettings.remindClineInterval
			controller.stateManager.setGlobalState("focusChainSettings", {
				enabled: request.focusChainSettings.enabled,
				remindClineInterval: remindClineInterval > 0 ? remindClineInterval : current.remindClineInterval,
			})
		}

		// Post updated state to webview
		await controller.postStateToWebview()

		return Empty.create()
	} catch (error) {
		Logger.error("Failed to update settings:", error)
		throw error
	}
}

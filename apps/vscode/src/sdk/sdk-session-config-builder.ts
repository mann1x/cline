import type { CoreSessionConfig } from "@cline/core"
import { type AgentHooks, type AgentTool, createTool } from "@cline/shared"
import type { StateManager } from "@/core/storage/StateManager"
import { buildSessionConfig, composeSessionHooks, type SessionConfigInput } from "./cline-session-factory"
import { buildAgentHooks, type HookMessageEmitter } from "./hooks-adapter"

export const SWITCH_TO_ACT_MODE_TOOL_NAME = "switch_to_act_mode"

/**
 * Exported so `default.md` can carry it verbatim and a test can prove it does.
 *
 * This tool is built here rather than in the SDK, which means core has no way
 * to construct one and compare — the same position `check_file` and
 * `code_intel` are in, and they are handled the same way.
 */
export const SWITCH_TO_ACT_MODE_TOOL_DESCRIPTION =
	"Switch from plan mode to act mode. Switching to act mode immediately starts executing the plan, so only call this after the user has explicitly approved the plan in a message sent AFTER you presented it (e.g. 'looks good', 'go ahead', 'switch to act mode'). " +
	"Never call this in the same turn you present a plan, never call it proactively, and never treat the original task request as approval. " +
	"Output: a one-line confirmation, as plain text. This call ends the current run and the next one starts in act mode with the file and command tools available, so it is a handover, not a failure — carry on with the plan there."

export interface SdkSessionConfigBuilderOptions {
	stateManager: StateManager
	emitHookMessage: HookMessageEmitter
	onSwitchToActMode: () => void
	shouldStopAfterModeSwitch?: () => boolean
	onConsecutiveMistakeLimitReached?: CoreSessionConfig["onConsecutiveMistakeLimitReached"]
}

/**
 * Unlike the CLI interactive runtime, plan-mode sessions do NOT expose a
 * switch_to_act_mode tool: matching the legacy extension, the model cannot
 * switch modes itself and must ask the user to flip the Plan/Act toggle. The
 * plan-mode system prompt (planModeSwitchTool: false in the session factory)
 * carries the matching instructions.
 */
export class SdkSessionConfigBuilder {
	constructor(private readonly options: SdkSessionConfigBuilderOptions) {}

	async build(input: SessionConfigInput): Promise<Awaited<ReturnType<typeof buildSessionConfig>>> {
		const config = await buildSessionConfig(input)
		if (this.options.onConsecutiveMistakeLimitReached) {
			config.onConsecutiveMistakeLimitReached = this.options.onConsecutiveMistakeLimitReached
		}

		// `buildSessionConfig` already built a hook stack, but on a file-hook
		// layer that has no message emitter — this class is the only place that
		// has one. Rebuild the whole stack rather than assigning `config.hooks`
		// directly: a direct assignment silently dropped every other layer,
		// which is how the editor-diagnostics hooks ran in the unit tests and
		// never once in a real session.
		const baseHooks = buildAgentHooks(this.options.stateManager, this.options.emitHookMessage, input.cwd)
		const fileHooks: AgentHooks = {
			...baseHooks,
			beforeModel: async (ctx) => {
				const baseControl = await baseHooks.beforeModel?.(ctx)
				if (this.options.shouldStopAfterModeSwitch?.()) {
					return {
						...baseControl,
						stop: true,
					}
				}
				return baseControl
			},
		}
		config.hooks = composeSessionHooks(fileHooks, input.cwd)
		if (input.mode === "plan") {
			// Match the CLI interactive runtime: plan-mode sessions expose a
			// switch_to_act_mode tool in addition to the read-only planning tools.
			config.extraTools = [...(config.extraTools ?? []), this.createSwitchToActModeTool()]
		} else {
			// The switch tool is plan-only in the CLI and should disappear after
			// rebuilding the session in act mode.
			config.extraTools = config.extraTools?.filter((tool) => tool.name !== "switch_to_act_mode")
		}

		return config
	}

	private createSwitchToActModeTool(): AgentTool {
		return createTool({
			name: SWITCH_TO_ACT_MODE_TOOL_NAME,
			description: SWITCH_TO_ACT_MODE_TOOL_DESCRIPTION,
			inputSchema: {
				type: "object",
				properties: {},
			},
			timeoutMs: 5000,
			retryable: false,
			maxRetries: 0,
			// End the run cleanly right after the tool result instead of letting the
			// loop start another iteration that the beforeModel stop hook would abort.
			// An aborted run leaves a dangling api_req_started spinner behind, which the
			// webview renders as "API Request Cancelled".
			lifecycle: {
				completesRun: true,
			},
			execute: async () => {
				const currentMode = this.options.stateManager.getGlobalSettingsKey("mode")
				if (currentMode === "act") {
					return "Already in act mode."
				}
				this.options.onSwitchToActMode()
				return "You successfully switched to act mode, proceed with the plan. You now have access to editing files and running commands. (The switch_to_act_mode tool is only available in plan mode.)"
			},
		})
	}
}

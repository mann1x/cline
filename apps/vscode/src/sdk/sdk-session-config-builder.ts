import type { CoreSessionConfig } from "@cline/core"
import { type AgentHooks, type AgentTool, createSwitchToActModeTool, withSwitchToActModeTool } from "@cline/shared"
import type { StateManager } from "@/core/storage/StateManager"
import { offerAgentProfileRepair } from "./agent-profile-repair"
import { buildSessionConfig, composeSessionHooks, type SessionConfigInput } from "./cline-session-factory"
import { createEscalationApprover } from "./escalation-approval"
import { buildAgentHooks, type HookMessageEmitter } from "./hooks-adapter"
import type { AskUser } from "./user-choice"

// Built in @cline/shared now, one tool for every host; re-exported for this host's tests and
// the prompt check that proves `default.md` carries the description verbatim.
export { SWITCH_TO_ACT_MODE_TOOL_DESCRIPTION, SWITCH_TO_ACT_MODE_TOOL_NAME } from "@cline/shared"

export interface SdkSessionConfigBuilderOptions {
	stateManager: StateManager
	emitHookMessage: HookMessageEmitter
	onSwitchToActMode: () => void
	shouldStopAfterModeSwitch?: () => boolean
	onConsecutiveMistakeLimitReached?: CoreSessionConfig["onConsecutiveMistakeLimitReached"]
	/**
	 * Puts a question with options into the chat.
	 *
	 * The escalation approval is built in the session factory, which has no
	 * chat to ask in and so can only raise a modal. This is where one is in
	 * hand, so the approver is rebuilt here -- the same reason the hook stack
	 * is rebuilt below rather than assigned.
	 */
	askUser?: AskUser
}

/**
 * Plan-mode sessions offer `switch_to_act_mode`, as the CLI does. The tool
 * queues the switch through `onSwitchToActMode`; the mode coordinator rebuilds
 * the task in act mode once the run ends, and `shouldStopAfterModeSwitch` stops
 * any model call in between.
 */
export class SdkSessionConfigBuilder {
	constructor(private readonly options: SdkSessionConfigBuilderOptions) {}

	async build(input: SessionConfigInput): Promise<Awaited<ReturnType<typeof buildSessionConfig>>> {
		const config = await buildSessionConfig(input)

		// An agent naming a deleted profile fails on its first call, which is
		// well into a task. Checked as the session is built so the offer to
		// repoint it arrives before anything delegates. Deliberately not
		// awaited: a session must start whether or not the agent directory can
		// be read, and the prompt waits on the user.
		void offerAgentProfileRepair(this.options.stateManager.getGlobalSettingsKey("apiConfigurationProfiles"))

		if (this.options.onConsecutiveMistakeLimitReached) {
			config.onConsecutiveMistakeLimitReached = this.options.onConsecutiveMistakeLimitReached
		}

		// Only when the session has an escalation at all: writing the block
		// would tell the runtime an expert is configured when none is.
		if (config.escalation && this.options.askUser) {
			config.escalation.approve = createEscalationApprover(this.options.askUser)
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
		// Plan only: the tool disappears once the session is rebuilt in act mode,
		// and the host's own tools stay either way.
		config.extraTools = withSwitchToActModeTool(
			config.extraTools,
			input.mode === "plan" ? "plan" : "act",
			this.createSwitchToActModeTool(),
		)

		return config
	}

	private createSwitchToActModeTool(): AgentTool {
		return createSwitchToActModeTool({
			isActMode: () => this.options.stateManager.getGlobalSettingsKey("mode") === "act",
			onSwitch: () => this.options.onSwitchToActMode(),
		})
	}
}

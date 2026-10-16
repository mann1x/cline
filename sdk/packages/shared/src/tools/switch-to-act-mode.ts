/**
 * `switch_to_act_mode`: the plan-mode tool that hands an approved plan to act
 * mode, shared by every host.
 *
 * The extension and the CLI each built their own, and the two had drifted:
 * one answered "Already in act mode." as a result, the other as an error, and
 * only the error is right (see `execute` below). automaticum ported a third
 * copy to test against. What a host still owns is how its session is rebuilt
 * in act mode -- the extension restarts the task through its controller, the
 * CLI rebuilds its config between turns -- so this module supplies the tool,
 * its sentences, the plan-only tool list, and the turn wrapper that runs the
 * continuation, and leaves the rebuild to the caller.
 */
import type { AgentTool } from "../agent";
import { createTool } from "./create";

export const SWITCH_TO_ACT_MODE_TOOL_NAME = "switch_to_act_mode";

/** Exported so a shipped prompt can carry it verbatim and a test can prove it does. */
export const SWITCH_TO_ACT_MODE_TOOL_DESCRIPTION =
	"Switch from plan mode to act mode. Switching to act mode immediately starts executing the plan, so only call this after the user has explicitly approved the plan in a message sent AFTER you presented it (e.g. 'looks good', 'go ahead', 'switch to act mode'). " +
	"Never call this in the same turn you present a plan, never call it proactively, and never treat the original task request as approval. " +
	"Output: a one-line confirmation, as plain text. This call ends the current run and the next one starts in act mode with the file and command tools available, so it is a handover, not a failure — carry on with the plan there.";

export const SWITCHED_TO_ACT_MODE_RESULT =
	"You successfully switched to act mode, proceed with the plan. You now have access to editing files and running commands. (The switch_to_act_mode tool is only available in plan mode.)";

export const ALREADY_IN_ACT_MODE_MESSAGE = "Already in act mode.";

/**
 * The synthetic user message that drives the turn after the switch. Hosts
 * filter it out of the chat display.
 */
export const ACT_MODE_CONTINUATION_PROMPT =
	"The user approved switching to act mode. Continue with the approved plan now.";

export interface SwitchToActModeToolOptions {
	/** Whether the session is already in act mode, read at call time. */
	isActMode: () => boolean;
	/** Queue the switch. The host rebuilds the session once the run ends. */
	onSwitch: () => void;
}

export function createSwitchToActModeTool(
	options: SwitchToActModeToolOptions,
): AgentTool {
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
		// The act-mode tools exist only once the session is rebuilt in act mode,
		// which cannot happen mid-run. Ending the run on the result keeps the
		// model from working on with plan-mode tools it was just told it no
		// longer has, and a clean end leaves no aborted request behind (which
		// the extension's chat renders as "API Request Cancelled").
		lifecycle: {
			completesRun: true,
		},
		execute: async () => {
			if (options.isActMode()) {
				// Thrown, not returned: `completesRun` ends the run on a successful
				// result, and nothing has changed for the next run to pick up.
				throw new Error(ALREADY_IN_ACT_MODE_MESSAGE);
			}
			options.onSwitch();
			return SWITCHED_TO_ACT_MODE_RESULT;
		},
	});
}

/**
 * The session's tools for `mode`: the switch tool added in plan mode and
 * dropped in act mode, every other tool kept. Replacing the whole list to add
 * or drop it once took the host's own tools (`browser`, `ask_lsp`) with it for
 * the rest of the session.
 */
export function withSwitchToActModeTool<T extends { name: string }>(
	tools: readonly T[] | undefined,
	mode: "plan" | "act",
	switchTool: T,
): T[] {
	const kept = (tools ?? []).filter(
		(tool) => tool.name !== SWITCH_TO_ACT_MODE_TOOL_NAME,
	);
	return mode === "plan" ? [...kept, switchTool] : kept;
}

export interface AppliedModeSwitch {
	mode: "plan" | "act";
	/**
	 * Who asked. Only the tool means the user approved the plan: a UI toggle
	 * that lands as a turn finishes must not start executing it.
	 */
	source: "tool" | "ui";
}

/**
 * Runs one turn and, when the model ended it by calling switch_to_act_mode,
 * continues the approved plan on the rebuilt act-mode session instead of
 * waiting for the user to prompt again.
 *
 * The continuation fires only for a tool-initiated switch on a turn that
 * finished "completed": a UI toggle mid-run aborts the turn, and even when the
 * toggle races a natural completion its source is "ui", so a toggle can never
 * start executing a plan the user did not approve.
 */
export async function sendTurnWithActModeContinuation<
	T extends { finishReason: string; iterations: number },
>(input: {
	sendInitialTurn: () => Promise<T | undefined>;
	sendContinuationTurn: (prompt: string) => Promise<T | undefined>;
	/** Rebuild the session for a queued switch, and say what was applied. */
	applyPendingModeChange: () => Promise<AppliedModeSwitch | undefined>;
}): Promise<T | undefined> {
	const result = await input.sendInitialTurn();
	const switched = await input.applyPendingModeChange();
	if (
		switched?.mode !== "act" ||
		switched.source !== "tool" ||
		result?.finishReason !== "completed"
	) {
		return result;
	}
	const continuation = await input.sendContinuationTurn(
		ACT_MODE_CONTINUATION_PROMPT,
	);
	// Honour a mode toggle made while the continuation was running.
	await input.applyPendingModeChange();
	if (!continuation) {
		return result;
	}
	return {
		...continuation,
		iterations: result.iterations + continuation.iterations,
	};
}

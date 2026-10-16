import {
	type AppliedModeSwitch,
	createSwitchToActModeTool,
	withSwitchToActModeTool,
} from "@cline/shared";
import type { Config } from "../../utils/types";
import { resolveSystemPrompt } from "../prompt";

export type InteractiveUiMode = "plan" | "act";

/**
 * Pending mode change plus who requested it. The switch_to_act_mode tool and
 * the TUI mode toggle share this slot, but only a tool-initiated switch means
 * "the user approved the plan" -- a UI toggle that lands as a turn finishes
 * must not trigger plan execution.
 */
export type PendingModeChange = {
	current: InteractiveUiMode | null;
	source: "tool" | "ui" | null;
};

export type AppliedModeChange = AppliedModeSwitch;

// The tool, its sentences and the continuation wrapper are in @cline/shared,
// one implementation for the CLI, the extension and automaticum.
export {
	ACT_MODE_CONTINUATION_PROMPT,
	sendTurnWithActModeContinuation,
} from "@cline/shared";

export function createInteractiveModeSwitchTool(input: {
	config: Config;
	pendingModeChange: PendingModeChange;
	tuiModeChanged: { current: ((mode: InteractiveUiMode) => void) | null };
}) {
	return createSwitchToActModeTool({
		isActMode: () => input.config.mode === "act",
		onSwitch: () => {
			input.pendingModeChange.current = "act";
			input.pendingModeChange.source = "tool";
			input.tuiModeChanged.current?.("act");
		},
	});
}

// The tracker moved to @cline/shared so the VSCode extension can share the
// exact round-trip-cancelling semantics; re-exported here to keep the CLI's
// import surface stable.
export {
	createModeSwitchNoticeTracker,
	type ModeSwitchNotice,
} from "@cline/shared";

export async function applyInteractiveModeConfig(input: {
	config: Config;
	mode: InteractiveUiMode;
	switchToActModeTool: NonNullable<Config["extraTools"]>[number];
}): Promise<void> {
	input.config.mode = input.mode;
	input.config.extraTools = withSwitchToActModeTool(
		input.config.extraTools,
		input.mode,
		input.switchToActModeTool,
	);
	input.config.systemPrompt = await resolveSystemPrompt({
		cwd: input.config.cwd,
		providerId: input.config.providerId,
		mode: input.mode,
		// Rebuilt from the same template the session started on. Without this the
		// prompt falls back to the built-in one on the first mode switch.
		basePrompt: input.config.promptTemplateSystem,
	});
}

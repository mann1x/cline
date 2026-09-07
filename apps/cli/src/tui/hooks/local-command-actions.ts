import type { LocalSlashCommandInvocation } from "../utils/skill-command-input";
import type { OpenConfigOptions } from "./use-config-panel";

export interface LocalSlashCommandActionInput {
	name: string;
	isRunning: boolean;
	openAccount: () => void;
	openConfig: (options?: OpenConfigOptions) => void;
	openMcpManager: () => Promise<boolean>;
	openModelSelector: () => void;
	openSkills: (invocation?: LocalSlashCommandInvocation) => void;
	openThemePicker: () => void;
	invocation?: LocalSlashCommandInvocation;
	runCompact: () => void;
	/** Hold a `/compact` asked for mid-turn until the turn finishes. */
	queueCompact: () => void;
	runDelegate: (invocation?: LocalSlashCommandInvocation) => void;
	runDelegateBackground: (invocation?: LocalSlashCommandInvocation) => void;
	runFork: () => void;
	runUndo: () => Promise<void>;
	clearConversation: () => Promise<void>;
	openHelp: () => void;
	openHistory: () => void;
	exitCline: () => void;
}

export function runLocalSlashCommandAction(
	input: LocalSlashCommandActionInput,
): boolean | Promise<boolean> {
	const normalized = input.name;
	if (normalized === "config" || normalized === "settings") {
		input.openConfig();
		return true;
	}
	if (normalized === "plugins") {
		input.openConfig({ initialTab: "plugins" });
		return true;
	}
	if (normalized === "skills") {
		input.openSkills(input.invocation);
		return true;
	}
	if (normalized === "delegate") {
		// Handled whether or not a turn is running: unlike /compact this does not
		// touch the conversation until the delegated agent has finished, and the
		// host refuses it there if a turn is still in flight.
		input.runDelegate(input.invocation);
		return true;
	}
	if (normalized === "delegate-background") {
		// The one that is meant to be used mid-turn: it starts the agent beside
		// the lead and returns, and the report is delivered into the
		// conversation whenever the agent is done with it.
		input.runDelegateBackground(input.invocation);
		return true;
	}
	if (normalized === "mcp") {
		return input.openMcpManager().then(() => true);
	}
	if (normalized === "account") {
		input.openAccount();
		return true;
	}
	if (normalized === "model") {
		input.openModelSelector();
		return true;
	}
	if (normalized === "theme") {
		input.openThemePicker();
		return true;
	}
	if (normalized === "compact") {
		// Compacting mid-turn would race the live agent loop, and /compact owns
		// the shared running state, which the active turn is using. So it waits
		// for the turn instead -- waiting is ours to do, not the user's
		// (mann1x/cline#70). Autocomplete can invoke local commands while a turn
		// is running, which is the other way to arrive here.
		if (input.isRunning) {
			input.queueCompact();
		} else {
			input.runCompact();
		}
		return true;
	}
	if (normalized === "fork") {
		input.runFork();
		return true;
	}
	if (normalized === "undo") {
		return input.runUndo().then(() => true);
	}
	if (normalized === "clear") {
		return input.clearConversation().then(() => true);
	}
	if (normalized === "help") {
		input.openHelp();
		return true;
	}
	if (normalized === "history") {
		input.openHistory();
		return true;
	}
	if (normalized === "quit") {
		setTimeout(input.exitCline, 0);
		return true;
	}
	return false;
}

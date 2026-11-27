import type {
	CreateTeamTaskInput,
	TeamTask,
	TeamTaskListItem,
} from "@cline/shared";

/**
 * Where the team's tasks live when the conversation keeps a task board
 * (task graph phase 4): `team_task` reads and writes the board, so a task a
 * teammate claims is a `T<n>` the lead's `task_view` shows, and the two
 * can never disagree. Without one, the runtime keeps its own list.
 */
export interface TeamTaskBoard {
	create(input: CreateTeamTaskInput): TeamTask;
	claim(taskId: string, agentId: string): TeamTask;
	block(taskId: string, agentId: string, reason: string): TeamTask;
	complete(taskId: string, agentId: string, summary: string): TeamTask;
	get(taskId: string): TeamTask | undefined;
	list(): TeamTaskListItem[];
	/** Told once it is in use: whether a member is running, and how to mail one. */
	attach?(team: {
		isRunning: (agentId: string) => boolean;
		notify: (toAgentId: string, subject: string, body: string) => void;
		leadId: string;
		/** Whether `agentId` is a teammate that can take a task now or later. */
		isTeammate?: (agentId: string) => boolean;
		/**
		 * Start a teammate's run on a task, in the background, as the lead's
		 * async `team_run_task` does. Returns the run's id; throws when the
		 * teammate cannot take it.
		 */
		dispatch?: (agentId: string, message: string, taskId: string) => string;
	}): void;
	/** A teammate joined the team: tasks given to it may start. */
	memberJoined?(agentId: string): void;
	/** A run ended: `run:` gates naming any of `ids` open, or fail. */
	runEnded?(ids: string[], ok: boolean, reason?: string): void;
	/** A teammate's task run ended: its claims end with it. */
	agentStopped?(agentId: string, reason: string): void;
	/** What to tell a teammate as its run starts: the tasks it holds or may claim. */
	briefFor?(agentId: string): string | undefined;
	/** A teammate's run is ending: what to ask about the tasks it still holds. */
	closeOutFor?(agentId: string): string | undefined;
}

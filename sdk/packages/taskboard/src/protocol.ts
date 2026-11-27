/**
 * What the board viewer shows (pipelines plan phase 3, section 9), shared by
 * the extension, which reads it from the workspace, and the webview panel,
 * which draws it.
 *
 * The shapes restate core's (`PipelineFile`, `JournalFold`) rather than
 * importing them: the webview does not depend on `@cline/core`, and a journal
 * outlives the version that wrote it, so the webview reads all of it
 * defensively.
 */

export interface ViewerPipelineNode {
	id: string;
	type: string;
	after?: string[];
	name?: string;
	description?: string;
	[field: string]: unknown;
}

export interface ViewerPipelineDefinition {
	name: string;
	description?: string;
	inputs?: Record<string, unknown>;
	onFailure?: string;
	maxParallel?: number;
	nodes: ViewerPipelineNode[];
}

/** One kept version of a pipeline file (phase 4). */
export interface ViewerVersion {
	hash: string;
	/** "model" for a `pipeline save`, "person" for the person's own. */
	by: string;
	at: string;
	base?: string;
	rejected?: { at: string };
}

export interface ViewerPipeline {
	name: string;
	slug: string;
	path: string;
	hash: string;
	/** The file as it is on disk. */
	text: string;
	valid: boolean;
	errors: string[];
	/** The file on disk is the version that was approved. */
	isApproved: boolean;
	approved?: { hash: string; by?: string; at?: string };
	definition?: ViewerPipelineDefinition;
	/** Who wrote the file's version, when it was kept. */
	author?: string;
	/** The approved version's text, when the file is not it and it was kept: the proposal's diff. */
	approvedText?: string;
	/** Kept versions, newest first. */
	versions?: ViewerVersion[];
}

export interface ViewerNodeOutput {
	items: unknown[];
	port: string;
	exit?: number;
	stdout?: string;
	stderr?: string;
	text?: string;
	error?: string;
	status?: number;
	run?: string;
}

export type ViewerNodeStatus =
	| "pending"
	| "running"
	| "done"
	| "skipped"
	| "failed";

export interface ViewerNodeState {
	status: ViewerNodeStatus;
	attempts: number;
	output?: ViewerNodeOutput;
	error?: string;
	reason?: string;
	startedAt?: number;
	endedAt?: number;
	waitingOn?: string;
	lastError?: string;
	reused?: string;
	/** The person skipped it after it failed; `error` is what it failed with. */
	bypassed?: boolean;
}

/** One line of a run's journal. */
export interface ViewerEvent {
	t: string;
	ts: number;
	node?: string;
	[field: string]: unknown;
}

/** What the person can do to a run from the inspector. */
export type ViewerRunOp = "retry" | "skip" | "rerun" | "stop";

export interface ViewerRun {
	id: string;
	pipeline: string;
	hash: string;
	status: string;
	startedAt?: number;
	endedAt?: number;
	error?: string;
	/** Its task on the conversation's board. */
	task?: string;
	/** A partial re-run: the run it reused outputs from. */
	from?: string;
	/** A sub-run: the run whose node started it. */
	parent?: string;
	inputs: Record<string, unknown>;
	/** The definition it ran, when the journal recorded one. */
	definition?: ViewerPipelineDefinition;
	nodes: Record<string, ViewerNodeState>;
	/** The journal's last events, oldest first. */
	events: ViewerEvent[];
	/** How many events the journal holds in all. */
	eventCount: number;
}

/** What to show first, when the panel was opened for something. */
export interface ViewerFocus {
	pipeline?: string;
	run?: string;
	board?: boolean;
}

/** What a pipeline step can name: the conversation's tools, the configured agents, the expression functions. */
export interface ViewerCatalog {
	tools: string[];
	agents: string[];
	functions: string[];
}

/**
 * A board the Board tab lists (owner, 2026-11-27): this conversation's, the
 * person's three drafts, the recent conversations of this workspace, and
 * the boards saved in Memory. Any of them can be copied to this conversation
 * or a draft; only this conversation and the drafts are changed in place.
 */
export interface ViewerBoardEntry {
	/** `live`, `draft:1` to `draft:3`, `recent:<conversation>`, or `saved:<memory>/<id>`. */
	key: string;
	kind: "conversation" | "draft" | "recent" | "saved";
	label: string;
	/** Where it is from, or when it was saved. */
	detail?: string;
	/** The board, as the task panel's row carries it; absent while it has no tasks. */
	text?: string;
	tasks: number;
	open: number;
	/** Changed in place here: this conversation while its session is live, and the drafts. */
	editable: boolean;
	/** Why it cannot be changed here, when it cannot. */
	readOnly?: string;
}

export interface ViewerData {
	workspace: string;
	/** Every board the tab lists, this conversation's (when one is open) first. */
	boards?: ViewerBoardEntry[];
	/** The open conversation's model is working now: Replace waits until it stops. */
	turnRunning?: boolean;
	/**
	 * The conversation's latest `task_graph` row, as core wrote it. The
	 * webview reads it with the task panel's own parser.
	 */
	boardText?: string;
	/**
	 * No conversation is open: the board shown is the draft the person is
	 * building for the next new conversation.
	 */
	boardDraft?: boolean;
	pipelines: ViewerPipeline[];
	/** Newest first. */
	runs: ViewerRun[];
	/** What the step form completes from. */
	catalog?: ViewerCatalog;
	focus?: ViewerFocus;
}

export const BOARD_VIEWER_DATA = "boardViewer/data";

/** From the extension. */
export interface ViewerDataMessage {
	type: typeof BOARD_VIEWER_DATA;
	data: ViewerData;
}

export const BOARD_VIEWER_REPLY = "boardViewer/reply";

/** From the extension: the answer to a request that carried an `id`. */
export interface ViewerReplyMessage {
	type: typeof BOARD_VIEWER_REPLY;
	id: number;
	ok: boolean;
	/** Validation errors, or why it was refused. */
	errors?: string[];
	/** What the board said back to a task edit. */
	lines?: string[];
	/** The run a run action left running: the same one, or a re-run's new one. */
	run?: string;
	/** The pipeline a request made: the viewer shows it. */
	pipeline?: string;
}

/** A task from the board, as board → pipeline takes it. */
export interface ViewerBoardTask {
	id: string;
	title: string;
	description?: string;
	status?: string;
	parent?: string;
	acceptance?: string[];
	depends?: string[];
	gates?: string[];
}

/** From the panel. Requests with an `id` are answered with a reply. */
export type ViewerRequest =
	| { type: "boardViewer/ready" }
	| { type: "boardViewer/openFile"; path: string }
	| { type: "boardViewer/saveReport"; name: string; text: string }
	/** Check a draft without saving it. */
	| { type: "boardViewer/validate"; id: number; definition: unknown }
	/** The person's edit, saved and approved; `base` is the version the draft started from. */
	| {
			type: "boardViewer/save";
			id: number;
			slug: string;
			base: string;
			definition: unknown;
	  }
	| { type: "boardViewer/approve"; id: number; slug: string; hash: string }
	| { type: "boardViewer/reject"; id: number; slug: string; hash: string }
	/** Save the board as a new pipeline, for the person to read and approve. */
	| {
			type: "boardViewer/boardToPipeline";
			id: number;
			tasks: ViewerBoardTask[];
	  }
	/** Save a pipeline as a task template. */
	| { type: "boardViewer/toTemplate"; id: number; slug: string }
	/** A change to a board, as the task panel sends it (`task_update`'s fields); `board` is its key, default the one shown first. */
	| {
			type: "boardViewer/editTask";
			id: number;
			updates: Record<string, unknown>[];
			board?: string;
	  }
	/** A new task on the board: the conversation's, or the draft when none is open. */
	| {
			type: "boardViewer/addTask";
			id: number;
			title: string;
			parent?: string;
			board?: string;
	  }
	/** The person deletes a task, with its steps; the extension asks first. */
	| { type: "boardViewer/deleteTask"; id: number; task: string; board?: string }
	/** Add tasks from a saved board, a saved plan or a file; write the board to a file. */
	| { type: "boardViewer/loadBoard"; id: number; board?: string }
	| { type: "boardViewer/exportBoard"; id: number; board?: string }
	/** The draft board goes to the next new conversation. */
	| { type: "boardViewer/startFromDraft"; id: number; board?: string }
	| { type: "boardViewer/discardDraft"; id: number; board?: string }
	/** Copy a board's tasks to this conversation or a draft; the extension asks Add or Replace. */
	| { type: "boardViewer/copyBoard"; id: number; from: string; to: string }
	/** Save a board into Memory, or delete one saved there (the extension asks first). */
	| { type: "boardViewer/saveBoardToMemory"; id: number; board: string }
	| { type: "boardViewer/deleteSavedBoard"; id: number; board: string }
	/** A new pipeline, named by the person and saved as theirs (approved). */
	| { type: "boardViewer/newPipeline"; id: number }
	/** The person's Retry, Skip, Re-run from a node, or Stop, on a pipeline run. */
	| {
			type: "boardViewer/runAction";
			id: number;
			op: ViewerRunOp;
			run: string;
			node?: string;
	  };

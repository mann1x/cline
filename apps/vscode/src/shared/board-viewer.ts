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
	id: string
	type: string
	after?: string[]
	name?: string
	description?: string
	[field: string]: unknown
}

export interface ViewerPipelineDefinition {
	name: string
	description?: string
	inputs?: Record<string, unknown>
	onFailure?: string
	maxParallel?: number
	nodes: ViewerPipelineNode[]
}

/** One kept version of a pipeline file (phase 4). */
export interface ViewerVersion {
	hash: string
	/** "model" for a `pipeline save`, "person" for the person's own. */
	by: string
	at: string
	base?: string
	rejected?: { at: string }
}

export interface ViewerPipeline {
	name: string
	slug: string
	path: string
	hash: string
	/** The file as it is on disk. */
	text: string
	valid: boolean
	errors: string[]
	/** The file on disk is the version that was approved. */
	isApproved: boolean
	approved?: { hash: string; by?: string; at?: string }
	definition?: ViewerPipelineDefinition
	/** Who wrote the file's version, when it was kept. */
	author?: string
	/** The approved version's text, when the file is not it and it was kept: the proposal's diff. */
	approvedText?: string
	/** Kept versions, newest first. */
	versions?: ViewerVersion[]
}

export interface ViewerNodeOutput {
	items: unknown[]
	port: string
	exit?: number
	stdout?: string
	stderr?: string
	text?: string
	error?: string
	status?: number
	run?: string
}

export type ViewerNodeStatus = "pending" | "running" | "done" | "skipped" | "failed"

export interface ViewerNodeState {
	status: ViewerNodeStatus
	attempts: number
	output?: ViewerNodeOutput
	error?: string
	reason?: string
	startedAt?: number
	endedAt?: number
	waitingOn?: string
	lastError?: string
	reused?: string
}

/** One line of a run's journal. */
export interface ViewerEvent {
	t: string
	ts: number
	node?: string
	[field: string]: unknown
}

export interface ViewerRun {
	id: string
	pipeline: string
	hash: string
	status: string
	startedAt?: number
	endedAt?: number
	error?: string
	/** Its task on the conversation's board. */
	task?: string
	/** A partial re-run: the run it reused outputs from. */
	from?: string
	/** A sub-run: the run whose node started it. */
	parent?: string
	inputs: Record<string, unknown>
	/** The definition it ran, when the journal recorded one. */
	definition?: ViewerPipelineDefinition
	nodes: Record<string, ViewerNodeState>
	/** The journal's last events, oldest first. */
	events: ViewerEvent[]
	/** How many events the journal holds in all. */
	eventCount: number
}

/** What to show first, when the panel was opened for something. */
export interface ViewerFocus {
	pipeline?: string
	run?: string
	board?: boolean
}

export interface ViewerData {
	workspace: string
	/**
	 * The conversation's latest `task_graph` row, as core wrote it. The
	 * webview reads it with the task panel's own parser.
	 */
	boardText?: string
	pipelines: ViewerPipeline[]
	/** Newest first. */
	runs: ViewerRun[]
	focus?: ViewerFocus
}

export const BOARD_VIEWER_DATA = "boardViewer/data"

/** From the extension. */
export interface ViewerDataMessage {
	type: typeof BOARD_VIEWER_DATA
	data: ViewerData
}

export const BOARD_VIEWER_REPLY = "boardViewer/reply"

/** From the extension: the answer to a request that carried an `id`. */
export interface ViewerReplyMessage {
	type: typeof BOARD_VIEWER_REPLY
	id: number
	ok: boolean
	/** Validation errors, or why it was refused. */
	errors?: string[]
	/** What the board said back to a task edit. */
	lines?: string[]
}

/** A task from the board, as board → pipeline takes it. */
export interface ViewerBoardTask {
	id: string
	title: string
	description?: string
	status?: string
	parent?: string
	acceptance?: string[]
	depends?: string[]
	gates?: string[]
}

/** From the panel. Requests with an `id` are answered with a reply. */
export type ViewerRequest =
	| { type: "boardViewer/ready" }
	| { type: "boardViewer/openFile"; path: string }
	| { type: "boardViewer/saveReport"; name: string; text: string }
	/** Check a draft without saving it. */
	| { type: "boardViewer/validate"; id: number; definition: unknown }
	/** The person's edit, saved and approved; `base` is the version the draft started from. */
	| { type: "boardViewer/save"; id: number; slug: string; base: string; definition: unknown }
	| { type: "boardViewer/approve"; id: number; slug: string; hash: string }
	| { type: "boardViewer/reject"; id: number; slug: string; hash: string }
	/** Save the board as a new pipeline, for the person to read and approve. */
	| { type: "boardViewer/boardToPipeline"; id: number; tasks: ViewerBoardTask[] }
	/** Save a pipeline as a task template. */
	| { type: "boardViewer/toTemplate"; id: number; slug: string }
	/** A change to the conversation's board, as the task panel sends it (`task_update`'s fields). */
	| { type: "boardViewer/editTask"; id: number; updates: Record<string, unknown>[] }

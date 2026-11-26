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

/** From the panel. */
export type ViewerRequest =
	| { type: "boardViewer/ready" }
	| { type: "boardViewer/openFile"; path: string }
	| { type: "boardViewer/saveReport"; name: string; text: string }

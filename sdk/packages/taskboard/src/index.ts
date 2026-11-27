/**
 * @cline/taskboard: the task board (the conversation's plan as a task graph
 * with dependencies, gates and acceptance, and the `task_plan`,
 * `task_update` and `task_view` tools) and pipelines (saved, approved DAGs of
 * commands, tool calls, checks, waits, approvals and agents, run in the
 * background by the `pipeline` tool), for an application to embed.
 *
 * Its only dependency is @cline/shared. @cline/core uses it and re-exports it,
 * so an application on the full SDK gets the same classes.
 */

export {
	type AttachedTaskBoard,
	type AttachTaskBoardOptions,
	attachTaskBoard,
	type PipelineRunControl,
	type TaskBoardControl,
} from "./attach";
export * from "./pipelines";
export * from "./protocol";
export * from "./task-graph";
export type { ToolOperationResult } from "./tool-result";
export {
	type BoardAnswer,
	type BoardBackend,
	type BoardBackendOptions,
	type BoardHostUi,
	createBoardBackend,
} from "./viewer/backend";
export {
	type CollectInput,
	collectViewerData,
	focusForFile,
	VIEWER_MAX_EVENTS,
	VIEWER_MAX_RUNS,
} from "./viewer/collect";
export {
	type BoardEditAction,
	DraftBoard,
	type DraftStorage,
} from "./viewer/draft";
export {
	BOARD_FILE_FORMAT,
	type BoardFile,
	type BoardIoDeps,
	type BoardIoUi,
	type BoardPickItem,
	exportBoard,
	loadBoard,
	type SavedBoardEntry,
	tasksFromBoardFile,
} from "./viewer/io";
export {
	type BoardRef,
	BoardSlots,
	type BoardSlotsDeps,
	DRAFT_COUNT,
	draftKey,
	LIVE_BOARD,
	parseBoardKey,
	RECENT_BOARDS,
	type RecentBoard,
	recentKey,
	SAVED_BOARDS,
	savedKey,
} from "./viewer/slots";

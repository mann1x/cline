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
export * from "./task-graph";
export type { ToolOperationResult } from "./tool-result";

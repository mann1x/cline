/**
 * Every tool this package can hand a session, built rather than listed, for
 * `default.md`'s sync and for the tests that guard the shipped templates.
 *
 * Two hand-kept lists (the sync script's and the test's) once agreed with each
 * other and with nothing else, so a tool the runtime adds outside them never
 * got a section: `task_progress` and `restore_file` until 4.100.289, the task
 * graph's three tools until 4.100.292. (`task_progress` is gone since: the
 * graph replaced the checklist.) One list, built from the factories,
 * read by both.
 */
import { createSessionRevisions } from "../../runtime/atomic/session-revisions";
import { PipelineSession } from "../pipelines/session";
import { createPipelineTool } from "../pipelines/tool";
import {
	createApplyPatchTool,
	createAskQuestionTool,
	createAwkTool,
	createEditorTool,
	createExtractDocumentTool,
	createGrepTool,
	createReadFilesTool,
	createSearchTool,
	createSedTool,
	createShellTool,
	createSkillsTool,
	createSubmitAndExitTool,
	createWebFetchTool,
} from "../tools/definitions";
import { createListFilesTool } from "../tools/list-files";
import { TaskGraphTracker } from "../tools/task-graph/tracker";
import { createReadAgentReportTool } from "../tools/team/agent-reports";
import { createAgentsStatusTool } from "../tools/team/agent-status";
import { createLeadAgentTools } from "../tools/team/lead-agent-tools";
import { createSpawnAgentTool } from "../tools/team/spawn-agent-tool";
import { createAgentTeamsTools } from "../tools/team/team-tools";

/**
 * Descriptions composed per session, kept as `{{DEFAULT}}` in every template:
 * `run_commands` is written against the detected shell, `skills` appends the
 * installed skills, and `task_plan` says one thing in act mode and another in
 * plan mode. Copying any of them would pin one session's answer.
 */
export const COMPUTED_TOOL_NAMES = ["run_commands", "skills", "task_plan"];

/**
 * Contributed by the VS Code host, so nothing here can build one to compare
 * against: their text is guarded by a test in `apps/vscode`, next to the
 * constants it has to match. Listed so a template's section for one is not
 * taken for a tool that no longer exists.
 */
export const HOST_TOOL_NAMES = [
	"check_file",
	"ask_lsp",
	"switch_to_act_mode",
	"browser",
	"generate_image",
	"generate_icon",
	"edit_image",
	"render_image",
	"transform_image",
	"transcribe_audio",
	"synthesize_speech",
	"generate_sound_effect",
	"generate_video",
	"jev",
];

const stubExecutor = (() => {
	throw new Error("not executed");
}) as never;

export function templateToolInventory(): {
	name: string;
	description?: string;
}[] {
	// Only the tools whose description depends on where they run take a cwd;
	// the rest reject this object (narrowed to a timeout of their own).
	const config = { cwd: "/workspace" };
	return [
		createReadFilesTool(stubExecutor),
		createSearchTool(stubExecutor, config),
		createGrepTool(stubExecutor, config),
		createAwkTool(stubExecutor, config),
		createExtractDocumentTool(stubExecutor, config),
		createShellTool(stubExecutor, config),
		createWebFetchTool(stubExecutor),
		createEditorTool(stubExecutor, config),
		createSedTool(stubExecutor, config),
		createApplyPatchTool(stubExecutor, config),
		createSkillsTool(stubExecutor),
		createAskQuestionTool(stubExecutor),
		createSubmitAndExitTool(stubExecutor),
		createSpawnAgentTool({ configProvider: {} as never }),
		createReadAgentReportTool(),
		createAgentsStatusTool({ sessionId: "s" }),
		...createLeadAgentTools({ sessionId: "s" }),
		createListFilesTool({ cwd: "/workspace", createLister: {} as never }),
		...createSessionRevisions({ root: "/workspace" }).tools,
		...createAgentTeamsTools({
			runtime: {} as never,
			requesterId: "lead",
			teammateConfigProvider: {} as never,
		}),
		...new TaskGraphTracker().tools(),
		createPipelineTool(
			new PipelineSession({
				workspaceRoot: "/workspace",
				sessionId: "s",
				tools: () => [],
			}),
			"/workspace",
		),
	] as { name: string; description?: string }[];
}

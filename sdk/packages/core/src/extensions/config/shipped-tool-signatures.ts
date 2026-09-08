/**
 * The call shapes of the shipped tools, for whoever is generating a template.
 *
 * A model asked to rewrite a prompt template writes example calls into it, and
 * an example is copied far more readily than a schema is read — so an example
 * with the wrong envelope does not just fail to help, it actively teaches the
 * wrong thing to every session that template is then applied to. The generator
 * audits examples against these signatures for exactly that reason, and it can
 * only do that if it has them.
 *
 * The tools are constructed with an executor that throws, because nothing here
 * runs them: `inputSchema` is fixed at construction and is all this needs.
 *
 * Host-contributed tools cannot be built here, so their schemas are restated
 * below and guarded by a test on the host side.
 */

import {
	createApplyPatchTool,
	createAskQuestionTool,
	createEditorTool,
	createReadFilesTool,
	createSearchTool,
	createShellTool,
	createSkillsTool,
	createSubmitAndExitTool,
	createWebFetchTool,
} from "../tools/definitions";
import { createSpawnAgentTool } from "../tools/team/spawn-agent-tool";
import { createAgentTeamsTools } from "../tools/team/team-tools";
import {
	summarizeToolCallSignatures,
	type ToolCallSignature,
} from "./prompt-template-review";

const stubExecutor = (() => {
	throw new Error("Tool built for its schema only; not executable.");
}) as never;

/**
 * The host tools' schemas, restated, because this package cannot build them.
 *
 * `check_file`, `code_intel`, `switch_to_act_mode`, `browser` and
 * `list_files` are
 * contributed by the VS Code extension. The review script runs here and has no way to reach them,
 * and leaving them out would mean the audit never checked the one tool with a
 * closed set of operations — which is precisely the tool a rewrite was
 * observed to gut. `HOST_TOOL_NAMES` in the shipped-templates test is the same
 * compromise for the same reason.
 *
 * A test in `apps/vscode` asserts these match the real schemas, so the copy
 * cannot drift without something failing.
 */
export const HOST_TOOL_INPUT_SCHEMAS: readonly {
	name: string;
	inputSchema: unknown;
}[] = [
	{
		name: "check_file",
		inputSchema: {
			type: "object",
			properties: { paths: { type: "array", items: { type: "string" } } },
			required: ["paths"],
		},
	},
	{
		name: "code_intel",
		inputSchema: {
			type: "object",
			properties: {
				operation: {
					type: "string",
					enum: [
						"definition",
						"references",
						"implementations",
						"type_definition",
						"hover",
						"document_symbols",
						"workspace_symbols",
						"callers",
					],
				},
				path: { type: "string" },
				symbol: { type: "string" },
				line: { type: "number" },
				character: { type: "number" },
			},
			required: ["operation"],
		},
	},
	{
		name: "switch_to_act_mode",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "list_files",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string" },
				pattern: { type: "string" },
				max_results: { type: "number" },
			},
			required: [],
		},
	},
	{
		name: "browser",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["open", "click", "type", "scroll_down", "scroll_up", "close"],
				},
				url: { type: "string" },
				coordinate: { type: "string" },
				text: { type: "string" },
			},
			required: ["action"],
		},
	},
];

let cached: ToolCallSignature[] | undefined;

export function getShippedToolCallSignatures(): readonly ToolCallSignature[] {
	if (cached) {
		return cached;
	}
	// Each factory takes only the slice of config it uses, and none of the
	// slices overlap, so an empty one is what they all accept. Nothing here
	// depends on a value: a schema is fixed at construction.
	const config = {};
	cached = summarizeToolCallSignatures([
		createReadFilesTool(stubExecutor, config),
		createSearchTool(stubExecutor, config),
		createShellTool(stubExecutor, config),
		createWebFetchTool(stubExecutor, config),
		createEditorTool(stubExecutor, config),
		createApplyPatchTool(stubExecutor, config),
		createSkillsTool(stubExecutor, config),
		createAskQuestionTool(stubExecutor),
		createSubmitAndExitTool(stubExecutor, config),
		createSpawnAgentTool({ configProvider: {} as never }),
		...createAgentTeamsTools({
			runtime: {} as never,
			requesterId: "lead",
			teammateConfigProvider: {} as never,
		}),
		...HOST_TOOL_INPUT_SCHEMAS,
	]);
	return cached;
}

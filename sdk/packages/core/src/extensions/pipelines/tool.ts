/**
 * `pipeline`: the one tool the model gets for pipelines (plan section 6).
 * Native, not MCP: it shares the session's approvals, tools and board.
 * Offered only with Features → Pipelines on and the provider's tool switch
 * on (`PIPELINE_TOOL_NAME` in its `tools.disabled` takes it away).
 */

import { type AgentTool, createTool } from "@cline/shared";
import type { ToolOperationResult } from "../tools/types";
import { EXPRESSION_FUNCTIONS } from "./expr";
import { foldJournal, readJournal } from "./journal";
import {
	MERGE_MODES,
	NODE_TYPES,
	nodePorts,
	RUNNABLE_NODE_TYPES,
} from "./model";
import type { PipelineSession } from "./session";
import { validatePipeline } from "./validate";
import {
	findPipeline,
	listPipelines,
	PIPELINES_DIR,
	savePipeline,
} from "./workspace";

export const PIPELINE_TOOL_NAME = "pipeline";

export const PIPELINE_ACTIONS = [
	"list",
	"catalog",
	"show",
	"save",
	"validate",
	"run",
	"test",
	"status",
	"stop",
	"resume",
	"runs",
] as const;

export const PIPELINE_TOOL_DESCRIPTION =
	"Pipelines: reusable DAGs of steps kept as JSON in the workspace (" +
	PIPELINES_DIR +
	"), run by Cerebriline in the background while you work. " +
	"Actions: list; catalog (the node types and their fields: read it before writing one); show (name); " +
	"save (pipeline: the JSON; base: the version `show` gave, to replace a file); validate (pipeline); " +
	"run (name, inputs; task: a task id that waits on the run); test (name or pipeline, inputs; pinned, no side effects); " +
	"status, stop, resume (run); runs. " +
	"A saved pipeline is a proposal: only a version the person approved runs; `test` runs any version.";

const CATALOG = [
	'Nodes run after what they list in `after` ("build", or "ok.true" for a branch\'s output). A node whose input did not run is skipped, and so is what follows it.',
	"Every node: id, type, after?, name?, description?, timeout? (s), idempotent? (safe to rerun after a reload), pin? (items a test returns).",
	"- tool: tool, input (any tool of this session, with its approvals). Items: its result.",
	"- command: command, cwd?, allowFailure? (a non-zero exit fails it otherwise). Items: [{exit, stdout, stderr}].",
	"- set: fields {name: value} (once per input item; keepInput? starts from the item) or items (an expression giving a list).",
	"- if: when → outputs true / false. switch: on, cases [names] → one output per case, and default.",
	`- merge: mode ${MERGE_MODES.join(" | ")} (all: every input ran; append: whatever ran; first: the first; by-key: joins on key).`,
	"- loop: over (a list), parallel?, body (one tool, command, set or check node, no id): $item and $index in it. Items: every body's items, in order.",
	"- wait: gate (timer:+10m or an ISO time, commit:<sha>@<branch>, gh-pr:owner/repo#n, gh-run:owner/repo/id, human:<what the person decides>, run:<agent>).",
	"- approval: message → outputs approve / reject (the person answers on the task board).",
	"- check: command (passes on exit 0) or when; message. Fails the run when it does not hold.",
	`Expressions: {{ … }} in any text. Names: $vars (inputs), $node.<id> (items, exit, stdout, stderr, text, port), $input, $item / $json, $index, $run, $env. Functions: ${EXPRESSION_FUNCTIONS.join(", ")}. No JavaScript.`,
	'Top level: {"name", "description"?, "inputs"? {name: {type, default?, required?}}, "maxParallel"? (4), "nodes": [...]}.',
];

function record(input: unknown): Record<string, unknown> {
	return input && typeof input === "object" && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value) as unknown;
			return parsed && typeof parsed === "object"
				? (parsed as Record<string, unknown>)
				: undefined;
		} catch {
			return undefined;
		}
	}
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function createPipelineTool(
	session: PipelineSession,
	workspaceRoot: string,
): AgentTool<unknown, ToolOperationResult[]> {
	return createTool<unknown, ToolOperationResult[]>({
		name: PIPELINE_TOOL_NAME,
		description: PIPELINE_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: [...PIPELINE_ACTIONS] },
				name: { type: "string" },
				pipeline: {
					type: "object",
					description: "The pipeline JSON, for save, validate and test.",
				},
				base: {
					type: "string",
					description:
						"The version `show` gave: save replaces the file only if it is still that.",
				},
				inputs: { type: "object" },
				task: {
					type: "string",
					description:
						"run: a task id that waits on the run (gate pipeline:<run>).",
				},
				run: {
					type: "string",
					description: "A run id, for status, stop and resume.",
				},
				allowSideEffects: {
					type: "boolean",
					description: "test: run unpinned command and tool nodes for real.",
				},
			},
			required: ["action"],
		},
		retryable: false,
		maxRetries: 0,
		execute: async (input) => {
			const args = record(input);
			const action =
				typeof args.action === "string" ? args.action.toLowerCase() : "";
			const answer = (
				lines: string[],
				success = true,
			): ToolOperationResult[] => [
				{ query: `pipeline ${action}`, result: lines.join("\n"), success },
			];
			const name = typeof args.name === "string" ? args.name : "";
			const runId = typeof args.run === "string" ? args.run : "";
			const inputs = asObject(args.inputs) ?? {};
			try {
				switch (action) {
					case "list": {
						const files = listPipelines(workspaceRoot);
						if (files.length === 0)
							return answer([
								`No pipelines yet in ${PIPELINES_DIR}. Write one with \`save\`; read \`catalog\` first.`,
							]);
						return answer(
							files.map(
								(file) =>
									`${file.name} (${file.slug}, version ${file.hash}): ${
										!file.valid
											? `does not validate (${file.errors.length} problems)`
											: file.isApproved
												? "approved"
												: file.approved
													? "changed since approval"
													: "not approved"
									}${file.definition?.description ? ` — ${file.definition.description}` : ""}`,
							),
						);
					}
					case "catalog":
						return answer([
							`Node types: ${[...RUNNABLE_NODE_TYPES].join(", ")}. Not yet available: ${NODE_TYPES.filter((type) => !RUNNABLE_NODE_TYPES.has(type)).join(", ")}.`,
							...CATALOG,
						]);
					case "show": {
						const file = findPipeline(workspaceRoot, name);
						if (!file)
							return answer(
								[`No pipeline "${name}". \`list\` shows them.`],
								false,
							);
						const lines = [
							`${file.name}: version ${file.hash}, ${file.isApproved ? "approved" : file.approved ? `changed since the approved ${file.approved.hash}` : "not approved"}.`,
						];
						if (!file.valid) lines.push(`Problems: ${file.errors.join("; ")}`);
						if (file.definition) {
							lines.push(
								`Nodes: ${file.definition.nodes
									.map(
										(node) =>
											`${node.id} (${node.type}${node.after?.length ? ` after ${node.after.join(", ")}` : ""}${nodePorts(node).length > 1 ? ` → ${nodePorts(node).join("/")}` : ""})`,
									)
									.join("; ")}`,
							);
						}
						lines.push(file.text.trimEnd());
						return answer(lines);
					}
					case "validate": {
						const checked = validatePipeline(
							asObject(args.pipeline) ?? args.pipeline,
						);
						return checked.ok
							? answer([`Valid: ${checked.pipeline?.nodes.length} nodes.`])
							: answer(
									[
										`${checked.errors.length} problems:`,
										...checked.errors.map((error) => `- ${error}`),
									],
									false,
								);
					}
					case "save": {
						const saved = savePipeline(
							workspaceRoot,
							asObject(args.pipeline) ?? args.pipeline,
							typeof args.base === "string" ? args.base : undefined,
						);
						if (!saved.ok)
							return answer(
								["Not saved:", ...saved.errors.map((error) => `- ${error}`)],
								false,
							);
						return answer([
							`${saved.created ? "Created" : "Saved"} ${saved.file.path.replace(`${workspaceRoot}/`, "")}, version ${saved.file.hash}.`,
							saved.file.isApproved
								? "This version is approved."
								: "It is a proposal: the person approves it before it can `run`. `test` runs it now, with pins.",
						]);
					}
					case "run": {
						const run = session.run(
							name,
							inputs,
							typeof args.task === "string" ? args.task : undefined,
						);
						const view = run.view();
						return answer([
							`Started ${run.id}${view.task ? ` (task ${view.task} on the board)` : ""}: ${view.nodes.length} nodes. It runs in the background; carry on with other work.`,
							`\`pipeline status\` with run "${run.id}" shows where it is. A task that needs its result can wait on it with the gate pipeline:${run.id}.`,
						]);
					}
					case "test": {
						const supplied = asObject(args.pipeline);
						let source: Parameters<PipelineSession["test"]>[0];
						if (supplied) {
							const checked = validatePipeline(supplied);
							if (!checked.ok || !checked.pipeline)
								return answer(
									[
										"Not valid:",
										...checked.errors.map((error) => `- ${error}`),
									],
									false,
								);
							source = {
								definition: checked.pipeline,
								text: JSON.stringify(supplied),
							};
						} else {
							const file = findPipeline(workspaceRoot, name);
							if (!file) return answer([`No pipeline "${name}".`], false);
							source = file;
						}
						const run = session.test(
							source,
							inputs,
							args.allowSideEffects === true,
						);
						const result = await run.result();
						const view = run.view();
						return answer(
							[
								`Test ${run.id}: ${result.status}${result.error ? ` — ${result.error}` : ""}.`,
								...view.nodes.map(
									(node) =>
										`- ${node.id}: ${node.status}${node.summary ? `, ${node.summary}` : ""}${node.error ? `, ${node.error}` : ""}${node.reason ? ` (${node.reason})` : ""}`,
								),
							],
							result.status === "done",
						);
					}
					case "status": {
						const live = session.get(runId);
						const view =
							live?.view() ??
							(() => {
								const fold = foldJournal(
									readJournal(`${session.journalDir}/${runId}.jsonl`),
								);
								if (!fold.run) return undefined;
								return {
									run: runId,
									pipeline: fold.run.pipeline,
									status: fold.status,
									error: fold.error,
									nodes: [...fold.nodes.entries()].map(([id, state]) => ({
										id,
										status: state.status,
										summary: state.output
											? `${state.output.items.length} items`
											: undefined,
										error: state.error,
										reason: state.reason,
										waitingOn: state.waitingOn,
									})),
								};
							})();
						if (!view)
							return answer([`No run "${runId}". \`runs\` lists them.`], false);
						return answer([
							`${view.run} (${view.pipeline}): ${view.status}${view.error ? ` — ${view.error}` : ""}.`,
							...view.nodes.map(
								(node) =>
									`- ${node.id}: ${node.status}${node.waitingOn ? `, waiting on ${node.waitingOn}` : ""}${node.summary ? `, ${node.summary}` : ""}${node.error ? `, ${node.error}` : ""}${node.reason ? ` (${node.reason})` : ""}`,
							),
						]);
					}
					case "stop":
						return session.stop(runId, "stopped by the model")
							? answer([
									`Stopping ${runId}. \`resume\` runs it again from where it stopped.`,
								])
							: answer([`${runId} is not running.`], false);
					case "resume": {
						const run = session.resume(runId);
						return answer([`Resumed ${run.id}. \`status\` shows where it is.`]);
					}
					case "runs": {
						const runs = session.runs();
						if (runs.length === 0) return answer(["No runs yet."]);
						return answer(
							runs.map(
								(run) =>
									`${run.run}: ${run.status}${run.live ? " (running now)" : ""}${run.error ? ` — ${run.error}` : ""}`,
							),
						);
					}
					default:
						return answer(
							[
								`Unknown action "${String(args.action)}": one of ${PIPELINE_ACTIONS.join(", ")}.`,
							],
							false,
						);
				}
			} catch (error) {
				return answer([(error as Error).message], false);
			}
		},
	});
}

/** The system prompt's paragraph, with the tool on. */
export const PIPELINE_RULES = [
	"# Pipelines",
	"",
	"This workspace can keep pipelines: reusable DAGs of commands, tool calls, checks, waits and approvals, as JSON under `.cerebriline/pipelines/`, run by the `pipeline` tool in the background.",
	"- When the person asks for repeatable automation (a release, a nightly check, a review flow), write it as a pipeline: read `pipeline catalog`, `save` it, `test` it with pins, and ask the person to approve it before it can `run`.",
	"- A run is a task on the task board; a task that needs its result waits on it with the gate `pipeline:<run>`.",
].join("\n");

export function withPipelineRules(
	systemPrompt: string | undefined,
): string | undefined {
	if (!systemPrompt) return systemPrompt;
	return systemPrompt.includes("# Pipelines")
		? systemPrompt
		: `${systemPrompt}\n\n${PIPELINE_RULES}`;
}

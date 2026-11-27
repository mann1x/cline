/**
 * One conversation: an agent loop with the task board attached.
 *
 * The board is not only three tools. `attachTaskBoard` hands back what the
 * host calls at each point of its own loop, and this is the whole wiring for
 * `@cline/agents`' `Agent`:
 *
 *   system prompt   board.systemPrompt(base)        the board's rules
 *   tools           [...yours, ...board.tools()]    each through board.wrapTool
 *   before a run    board.runStartNote()            the person's edits since
 *   after tools     board.afterToolsReminder()      a gate opened, a task left behind
 *   before the end  board.completionGuard()         open tasks keep the run going
 *
 * Every change to the board is written to `logDir/<id>.tasks.jsonl`, so a
 * conversation's board outlives the process, and the Board tab lists the
 * past ones as recent conversations.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Agent } from "@cline/agents";
import {
	type AgentTool,
	createTool,
	type ToolApprovalRequest,
} from "@cline/shared";
import {
	type AttachedTaskBoard,
	attachTaskBoard,
	SESSION_BOARD_LOG_SUFFIX,
	type TaskGraphSeed,
} from "@cline/taskboard";
import type { ChatLine } from "../shared/wire";

export interface ModelSettings {
	providerId: string;
	modelId: string;
	baseUrl?: string;
	apiKey?: string;
}

export interface ConversationOptions {
	workspaceRoot: string;
	logDir: string;
	model: ModelSettings;
	/** A board the person made in the Board tab, to start from. */
	seed?: TaskGraphSeed;
	/** The chat changed: a line, or running started or stopped. */
	onChat: () => void;
	/** A piece of the agent's answer as it streams. */
	onDelta: (text: string) => void;
	/** The board or a pipeline run changed: draw the Board tab again. */
	onBoard: () => void;
	/** A pipeline step wants to run a tool that asks first. */
	requestApproval: (request: ToolApprovalRequest) => Promise<boolean>;
}

const BASE_PROMPT = `You are a helpful agent working in the folder ${"{workspace}"}.
Plan work on the task board before you start it, keep the board current as you
go, and finish what you planned. Use the file tools for the folder's files.`;

/** The workspace path a tool was given, refused when it leads out of the workspace. */
function inside(workspaceRoot: string, path: string): string {
	const full = resolve(workspaceRoot, path);
	if (full !== workspaceRoot && !full.startsWith(workspaceRoot + sep)) {
		throw new Error(`${path} is outside the workspace.`);
	}
	return full;
}

/**
 * The example's own tools: read, list and write the workspace's files. Each
 * is typed by its input; the list is of plain `AgentTool`s, as an agent takes.
 */
function fileTools(workspaceRoot: string): AgentTool[] {
	const tools = [
		createTool({
			name: "list_files",
			description: "List the files in a folder of the workspace.",
			inputSchema: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Folder, relative to the workspace",
					},
				},
			},
			readOnly: true,
			execute: async (input: { path?: string }) => {
				const dir = inside(workspaceRoot, input.path ?? ".");
				const entries = await readdir(dir, { withFileTypes: true });
				return entries
					.filter((entry) => !entry.name.startsWith("."))
					.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
					.join("\n");
			},
		}),
		createTool({
			name: "read_file",
			description: "Read a file of the workspace.",
			inputSchema: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
			readOnly: true,
			execute: async (input: { path: string }) =>
				readFile(inside(workspaceRoot, input.path), "utf8"),
		}),
		createTool({
			// The name is one the board counts as a write: a file written under no
			// task, or while a task sits untouched, is something it speaks up about.
			name: "write_to_file",
			description: "Write a file of the workspace, replacing what it held.",
			inputSchema: {
				type: "object",
				properties: { path: { type: "string" }, content: { type: "string" } },
				required: ["path", "content"],
			},
			execute: async (input: { path: string; content: string }) => {
				const file = inside(workspaceRoot, input.path);
				await mkdir(dirname(file), { recursive: true });
				await writeFile(file, input.content);
				return `Wrote ${relative(workspaceRoot, file)} (${input.content.length} characters).`;
			},
		}),
	];
	return tools as unknown as AgentTool[];
}

export class Conversation {
	readonly id = `c${Date.now().toString(36)}`;
	readonly board: AttachedTaskBoard;
	readonly lines: ChatLine[] = [];
	running = false;
	private readonly agent: Agent;
	private started = false;

	constructor(private readonly options: ConversationOptions) {
		const { workspaceRoot, logDir, model } = options;
		this.board = attachTaskBoard({
			sessionId: this.id,
			workspaceRoot,
			cwd: workspaceRoot,
			logPath: join(logDir, `${this.id}${SESSION_BOARD_LOG_SUFFIX}`),
			...(options.seed ? { seed: options.seed } : {}),
			onChange: () => options.onBoard(),
			pipelines: {
				tools: () => tools,
				requestApproval: async (request) => ({
					approved: await options.requestApproval(request),
				}),
				approveHow: () =>
					"Ask the person to approve it on the Board tab (the pipeline's Approve button).",
				onRunChange: () => options.onBoard(),
			},
		});
		const board = this.board;
		const tools = [...fileTools(workspaceRoot), ...board.tools()].map((tool) =>
			board.wrapTool(tool),
		);
		// What a pipeline's `tool` step may call: the same tools the model has.
		board.setTools(() => tools);

		this.agent = new Agent({
			...model,
			sessionId: this.id,
			systemPrompt: board.systemPrompt(
				BASE_PROMPT.replace("{workspace}", workspaceRoot),
			),
			tools,
			maxIterations: 60,
			hooks: {
				beforeRun: () => {
					const note = board.runStartNote();
					return note ? { appendContext: note } : undefined;
				},
			},
			completionPolicy: {
				completionGuard: board.completionGuard(),
				afterToolsReminder: () => board.afterToolsReminder(),
			},
		});
		this.agent.subscribe((event) => {
			if (event.type === "assistant-text-delta") options.onDelta(event.text);
			if (event.type === "tool-started") {
				this.lines.push({ role: "tool", text: event.toolCall.toolName });
				options.onChat();
			}
		});
		// A run a crash left half done is marked so, not left running.
		board.recoverInterruptedRuns();
	}

	async send(text: string): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.lines.push({ role: "user", text });
		this.options.onChat();
		try {
			const result = this.started
				? await this.agent.continue(text)
				: await this.agent.run(text);
			this.started = true;
			if (result.outputText.trim())
				this.lines.push({ role: "assistant", text: result.outputText });
		} catch (error) {
			this.lines.push({
				role: "error",
				text: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.running = false;
			this.options.onChat();
			this.options.onBoard();
		}
	}

	stop(): void {
		this.agent.abort("stopped by the person");
	}
}

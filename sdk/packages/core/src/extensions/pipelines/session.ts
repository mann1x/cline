/**
 * Pipelines in one session (plan phase 1): the runs it started, and the host
 * that ties the engine to the session.
 *
 * - A `tool` node calls the session's own tool, under the session's own
 *   policies: a tool switched off stays off, and one that asks for approval
 *   asks the person, as the model's call would.
 * - A `command` node runs in the workspace, under `run_commands`' policy.
 * - A `wait` on a time, a commit or GitHub is decided here; a wait on the
 *   person (`human:`), a run or a command is a gate on the run's task on the
 *   conversation's board, opened where that board's gates are opened (an
 *   answer, the panel's Resolve, the run or command ending).
 * - An `approval` is a `human:` gate on the run's task: Resolve approves,
 *   removing the gate rejects.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
	AgentTool,
	ToolApprovalRequest,
	ToolApprovalResult,
	ToolPolicy,
} from "@cline/shared";
import {
	absoluteGate,
	decideCommitGate,
	decideGitHubGate,
	decideTimerGate,
} from "../tools/task-graph/gates";
import { parseGate } from "../tools/task-graph/model";
import type { TaskGraphStore } from "../tools/task-graph/store";
import { foldJournal, PIPELINE_RUNS_DIR, readJournal } from "./journal";
import type { PipelineDefinition, PipelineNode } from "./model";
import {
	type NodeContext,
	type PipelineHost,
	PipelineRun,
	pipelineHolder,
} from "./runner";
import { pipelineHash } from "./validate";
import { findPipeline, type PipelineFile } from "./workspace";

/** Tools a pipeline does not call: the board is the conversation's, and a pipeline does not start one from inside itself in this phase. */
const NOT_FROM_A_PIPELINE = new Set([
	"pipeline",
	"task_plan",
	"task_update",
	"task_view",
	"ask_question",
	"attempt_completion",
]);

const COMMAND_TOOL = "run_commands";
const OUTPUT_CAP = 256_000;

export interface PipelineSessionOptions {
	workspaceRoot: string;
	sessionId: string;
	/** The conversation's board: a run gets a task on it. */
	board?: TaskGraphStore;
	/** The tools the session offers, for `tool` nodes. */
	tools: () => readonly AgentTool[];
	toolPolicies?: Record<string, ToolPolicy>;
	/** How the session asks the person about a tool call. */
	requestApproval?: (
		request: ToolApprovalRequest,
	) => ToolApprovalResult | Promise<ToolApprovalResult>;
	env?: Record<string, string>;
	/** How often a board gate, a commit or GitHub is looked at (ms). */
	pollMs?: number;
	log?: (line: string) => void;
	/** Each run's journal events, for the host (the panel, the viewer). */
	onRunChange?: (run: PipelineRun) => void;
	/** A run ended: what the conversation's board said (gates opened, "Ready now"). */
	onRunEnded?: (run: PipelineRun, lines: string[]) => void;
}

export interface PipelineRunSummary {
	run: string;
	pipeline: string;
	status: string;
	startedAt?: number;
	endedAt?: number;
	error?: string;
	task?: string;
	live: boolean;
}

function policyFor(
	policies: Record<string, ToolPolicy> | undefined,
	name: string,
): ToolPolicy {
	return { ...(policies?.["*"] ?? {}), ...(policies?.[name] ?? {}) };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason ?? new Error("stopped"));
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("stopped"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** The side-effecting nodes a test run refuses unless pinned or allowed. */
export function unpinnedSideEffects(definition: PipelineDefinition): string[] {
	const effectful = (node: { type: string; pin?: unknown }) =>
		(node.type === "command" || node.type === "tool") &&
		!Array.isArray(node.pin);
	return definition.nodes
		.filter(
			(node) =>
				effectful(node) ||
				(node.type === "loop" &&
					effectful((node as { body: { type: string } }).body)),
		)
		.map((node: PipelineNode) => node.id);
}

export class PipelineSession {
	readonly journalDir: string;
	private readonly options: PipelineSessionOptions;
	private readonly live = new Map<string, PipelineRun>();
	readonly host: PipelineHost;

	constructor(options: PipelineSessionOptions) {
		this.options = options;
		this.journalDir = join(options.workspaceRoot, PIPELINE_RUNS_DIR);
		this.host = {
			callTool: (name, input, context) => this.callTool(name, input, context),
			runCommand: (command, opts, context) =>
				this.runCommand(command, opts, context),
			waitGate: (spec, context) => this.waitGate(spec, context),
			approve: (message, context) => this.approve(message, context),
		};
	}

	private get pollMs(): number {
		return this.options.pollMs ?? 1000;
	}

	// ---------------------------------------------------------------------
	// The host
	// ---------------------------------------------------------------------

	private async askPerson(
		toolName: string,
		input: unknown,
		context: NodeContext,
	): Promise<void> {
		const policy = policyFor(this.options.toolPolicies, toolName);
		if (policy.enabled === false) {
			throw new Error(`${toolName} is switched off for this session`);
		}
		if (policy.autoApprove !== false) return;
		if (!this.options.requestApproval) {
			throw new Error(
				`${toolName} needs the person's approval, and this session cannot ask for it`,
			);
		}
		const answer = await this.options.requestApproval({
			sessionId: this.options.sessionId,
			agentId: pipelineHolder(context.run),
			conversationId: this.options.sessionId,
			iteration: 0,
			toolCallId: `${context.run}:${context.node}`,
			toolName,
			input,
			policy,
		});
		if (!answer.approved) {
			throw new Error(
				`the person did not approve ${toolName}${answer.reason ? `: ${answer.reason}` : ""}`,
			);
		}
	}

	private async callTool(
		name: string,
		input: unknown,
		context: NodeContext,
	): Promise<unknown> {
		if (NOT_FROM_A_PIPELINE.has(name)) {
			throw new Error(`a pipeline does not call ${name}`);
		}
		const tool = this.options.tools().find((entry) => entry.name === name);
		if (!tool) {
			const known = this.options
				.tools()
				.map((entry) => entry.name)
				.filter((entry) => !NOT_FROM_A_PIPELINE.has(entry));
			throw new Error(
				`no tool "${name}" in this session (it has ${known.join(", ")})`,
			);
		}
		await this.askPerson(name, input, context);
		return tool.execute(input as never, {
			sessionId: this.options.sessionId,
			agentId: pipelineHolder(context.run),
			conversationId: this.options.sessionId,
			iteration: 0,
			toolCallId: `${context.run}:${context.node}`,
			signal: context.signal,
		});
	}

	private async runCommand(
		command: string,
		opts: { cwd?: string },
		context: NodeContext,
	): Promise<{ exit: number; stdout: string; stderr: string }> {
		await this.askPerson(COMMAND_TOOL, { commands: [command] }, context);
		const cwd = opts.cwd
			? join(this.options.workspaceRoot, opts.cwd)
			: this.options.workspaceRoot;
		return new Promise((resolve, reject) => {
			const child = spawn(command, { cwd, shell: true, windowsHide: true });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => {
				if (stdout.length < OUTPUT_CAP) stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				if (stderr.length < OUTPUT_CAP) stderr += chunk.toString();
			});
			const onAbort = () => child.kill();
			context.signal.addEventListener("abort", onAbort, { once: true });
			child.on("error", (error) => {
				context.signal.removeEventListener("abort", onAbort);
				reject(error);
			});
			child.on("close", (code) => {
				context.signal.removeEventListener("abort", onAbort);
				resolve({ exit: code ?? 1, stdout, stderr });
			});
		});
	}

	/** Put a gate on the run's conversation task and wait for the board to decide it. */
	private async boardGate(
		spec: string,
		context: NodeContext,
	): Promise<{ open: true } | { failed: string } | { removed: true }> {
		const board = this.options.board;
		const task = context.task;
		if (!board || !task) {
			return {
				failed: `${spec} needs the conversation's task board, and this run has none`,
			};
		}
		board.update(
			{ updates: [{ id: task, gate: [spec] }] },
			{ by: pipelineHolder(context.run) },
		);
		this.options.log?.(
			`[pipelines] ${context.run}: ${context.node} waits on ${spec} (${task})`,
		);
		for (;;) {
			const entry = board
				.getState()
				.tasks.get(task)
				?.gates.find((gate) => gate.spec === spec);
			if (!entry) return { removed: true };
			if (entry.open) return { open: true };
			if (entry.failed) return { failed: entry.failed };
			await delay(this.pollMs, context.signal);
		}
	}

	/** The run's task goes back to active once what it waited on is settled. */
	private resumeTask(context: NodeContext, spec: string): void {
		const board = this.options.board;
		const task = context.task;
		if (!board || !task) return;
		board.update(
			{ updates: [{ id: task, status: "active", gate_remove: [spec] }] },
			{ by: pipelineHolder(context.run) },
		);
	}

	private async waitGate(
		spec: string,
		context: NodeContext,
	): Promise<{ open: true } | { failed: string }> {
		const parsed = parseGate(spec);
		if (!parsed)
			return {
				failed: `"${spec}" is not a gate (timer:, commit:, gh-pr:, gh-run:, human:, run:, command:)`,
			};
		if (parsed.kind === "timer") {
			const gate = { spec: absoluteGate(spec, Date.now()), open: false };
			for (;;) {
				const decision = decideTimerGate(gate, Date.now());
				if (decision) return decision;
				const at = Date.parse(parseGate(gate.spec)?.value ?? "");
				await delay(
					Math.max(50, Math.min(at - Date.now(), 60_000)),
					context.signal,
				);
			}
		}
		if (parsed.kind === "commit") {
			for (;;) {
				const decision = decideCommitGate(
					{ spec, open: false },
					this.options.workspaceRoot,
				);
				if (decision) return decision;
				await delay(Math.max(this.pollMs, 15_000), context.signal);
			}
		}
		if (parsed.kind === "gh-pr" || parsed.kind === "gh-run") {
			for (;;) {
				const decision = await decideGitHubGate(
					{ spec, open: false },
					this.options.workspaceRoot,
				);
				if (decision) return decision;
				await delay(Math.max(this.pollMs, 60_000), context.signal);
			}
		}
		const decided = await this.boardGate(spec, context);
		this.resumeTask(context, spec);
		if ("removed" in decided) return { failed: "the gate was removed" };
		return decided;
	}

	private async approve(
		message: string,
		context: NodeContext,
	): Promise<boolean> {
		const spec = `human:${message.replace(/\s+/g, " ").trim().slice(0, 200)}`;
		const decided = await this.boardGate(spec, context);
		this.resumeTask(context, spec);
		return "open" in decided;
	}

	// ---------------------------------------------------------------------
	// Runs
	// ---------------------------------------------------------------------

	private track(run: PipelineRun): PipelineRun {
		this.live.set(run.id, run);
		void run.result().then(
			(result) => {
				this.live.delete(run.id);
				this.options.log?.(
					`[pipelines] ${run.id} ${result.status}${result.error ? `: ${result.error}` : ""}`,
				);
				this.options.onRunEnded?.(run, result.boardLines);
			},
			(error) => {
				this.live.delete(run.id);
				this.options.log?.(
					`[pipelines] ${run.id} crashed: ${(error as Error).message}`,
				);
			},
		);
		return run;
	}

	private baseOptions(
		definition: PipelineDefinition,
		hash: string,
		host: PipelineHost = this.host,
	) {
		return {
			definition,
			hash,
			host,
			journalDir: this.journalDir,
			...(this.options.board ? { board: this.options.board } : {}),
			...(this.options.env ? { env: this.options.env } : {}),
			onEvent: (_event: unknown, run: PipelineRun) =>
				this.options.onRunChange?.(run),
		};
	}

	/** Start the approved version of a workspace pipeline. */
	run(
		name: string,
		inputs: Record<string, unknown> = {},
		gateTask?: string,
	): PipelineRun {
		const file = findPipeline(this.options.workspaceRoot, name);
		if (!file) throw new Error(`no pipeline "${name}"`);
		if (!file.valid || !file.definition)
			throw new Error(
				`"${file.name}" does not validate: ${file.errors.join("; ")}`,
			);
		if (!file.isApproved) {
			throw new Error(
				file.approved
					? `"${file.name}" changed since the version the person approved (${file.approved.hash}; the file is ${file.hash}). Only an approved version runs: ask the person to approve this one, or run \`pipeline test\`.`
					: `"${file.name}" has not been approved. Only an approved version runs: ask the person to approve it (the /pipelines command, or "Approve pipeline" in VS Code), or run \`pipeline test\`.`,
			);
		}
		const run = this.track(
			PipelineRun.start({
				...this.baseOptions(file.definition, file.hash),
				inputs,
			}),
		);
		if (gateTask && this.options.board) {
			this.options.board.update(
				{ updates: [{ id: gateTask, gate: [`pipeline:${run.id}`] }] },
				{ by: "model" },
			);
		}
		return run;
	}

	/**
	 * A test run: pinned nodes return their pins, and a command or tool node
	 * without one is refused unless `allowSideEffects` -- a test does not push,
	 * deploy or write by accident. Runs the file as it is, approved or not.
	 * Waits open at once and approvals take `approve`: a test does not wait
	 * for a day or for the person.
	 */
	test(
		source: PipelineFile | { definition: PipelineDefinition; text: string },
		inputs: Record<string, unknown> = {},
		allowSideEffects = false,
	): PipelineRun {
		const definition = source.definition;
		if (!definition) throw new Error("the pipeline does not validate");
		const unpinned = unpinnedSideEffects(definition);
		if (unpinned.length > 0 && !allowSideEffects) {
			throw new Error(
				`a test runs nothing with side effects: ${unpinned.join(", ")} would run for real. Give each a \`pin\` (the items it returns in a test), or send \`allowSideEffects: true\``,
			);
		}
		return this.track(
			PipelineRun.start({
				...this.baseOptions(
					{ ...definition, name: `${definition.name}-test` },
					pipelineHash(source.text),
					{
						...this.host,
						waitGate: async () => ({ open: true }),
						approve: async () => true,
					},
				),
				inputs,
				usePins: true,
			}),
		);
	}

	get(run: string): PipelineRun | undefined {
		return this.live.get(run);
	}

	stop(run: string, reason = "stopped"): boolean {
		const live = this.live.get(run);
		if (!live) return false;
		live.stop(reason);
		return true;
	}

	/** Resume a stopped or failed run, or pick up one the host was running when it stopped. */
	resume(runId: string): PipelineRun {
		if (this.live.has(runId)) throw new Error(`${runId} is running`);
		const fold = foldJournal(
			readJournal(join(this.journalDir, `${runId}.jsonl`)),
		);
		if (!fold.run) throw new Error(`no run "${runId}"`);
		const file = findPipeline(
			this.options.workspaceRoot,
			fold.run.pipeline.replace(/-test$/, ""),
		);
		if (!file?.definition)
			throw new Error(
				`the pipeline of ${runId} ("${fold.run.pipeline}") is no longer in the workspace`,
			);
		if (file.hash !== fold.run.hash && !fold.run.pipeline.endsWith("-test")) {
			throw new Error(
				`"${file.name}" changed since ${runId} started (${fold.run.hash} → ${file.hash}); start a new run`,
			);
		}
		const definition = fold.run.pipeline.endsWith("-test")
			? { ...file.definition, name: fold.run.pipeline }
			: file.definition;
		const options = {
			...this.baseOptions(definition, fold.run.hash),
			run: runId,
		};
		const run =
			fold.status === "running" || fold.status === "waiting"
				? PipelineRun.recover(options)
				: PipelineRun.resume(options);
		if (!run) throw new Error(`${runId} cannot be resumed`);
		return this.track(run);
	}

	/** Runs in this workspace, newest first. */
	runs(limit = 20): PipelineRunSummary[] {
		if (!existsSync(this.journalDir)) return [];
		return readdirSync(this.journalDir)
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => {
				const id = file.slice(0, -".jsonl".length);
				const fold = foldJournal(readJournal(join(this.journalDir, file)));
				return {
					run: id,
					pipeline: fold.run?.pipeline ?? "?",
					status: fold.status,
					...(fold.startedAt ? { startedAt: fold.startedAt } : {}),
					...(fold.endedAt ? { endedAt: fold.endedAt } : {}),
					...(fold.error ? { error: fold.error } : {}),
					...(fold.run?.task ? { task: fold.run.task } : {}),
					live: this.live.has(id),
				};
			})
			.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
			.slice(0, limit);
	}

	/** Stop every live run: the session is ending. */
	dispose(): void {
		for (const run of this.live.values()) run.stop("the session ended");
	}
}

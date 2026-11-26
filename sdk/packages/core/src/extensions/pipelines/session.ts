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
 * - An `agent` or `swarm` node calls the session's own `spawn_agent`,
 *   `spawn_swarm` or configured-agent tool, as a `tool` node would.
 * - An `http` node asks the person, unless the `pipeline_http` policy
 *   approves it (phase 2).
 * - A `pipeline` node runs another workspace pipeline's approved version
 *   to its end; a pipeline never runs inside itself, and at most five deep.
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
import {
	appendJournal,
	foldJournal,
	PIPELINE_RUNS_DIR,
	readJournal,
} from "./journal";
import type { PipelineDefinition, PipelineNode } from "./model";
import {
	type HttpRequest,
	type NodeContext,
	type PipelineHost,
	PipelineRun,
	type PipelineRunResult,
	pipelineHolder,
	type SubRunResult,
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
/** The policy an http node's request is asked under: it asks unless set to auto-approve. */
export const PIPELINE_HTTP_POLICY = "pipeline_http";
/** How deep pipelines run inside each other. */
const MAX_DEPTH = 5;

const sameName = (a: string, b: string) =>
	a.trim().toLowerCase() === b.trim().toLowerCase();

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
		(node.type === "command" ||
			node.type === "tool" ||
			node.type === "http" ||
			node.type === "agent" ||
			node.type === "swarm" ||
			node.type === "pipeline") &&
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

/** What the person can do to a run from the board viewer. */
export interface PipelineRunAction {
	op: "retry" | "skip" | "rerun" | "stop";
	run: string;
	/** The node acted on; not needed to stop. */
	node?: string;
}

export interface PipelineActOutcome {
	ok: boolean;
	/** What the person is told. */
	lines: string[];
	/** The run that is now running: the same one, or a re-run's new one. */
	run?: string;
	/** What the model is told, when something changed. */
	tell?: string;
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
			http: (request, context) => this.http(request, context),
			runPipeline: (name, inputs, context) =>
				this.runPipeline(name, inputs, context),
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

	/**
	 * A web request. Asked of the person unless the `pipeline_http` policy
	 * auto-approves it: a request can change something somewhere else, and
	 * approving the pipeline did not approve that.
	 */
	private async http(
		request: HttpRequest,
		context: NodeContext,
	): Promise<{
		status: number;
		headers: Record<string, string>;
		body: string;
	}> {
		const policy = policyFor(this.options.toolPolicies, PIPELINE_HTTP_POLICY);
		if (policy.enabled === false)
			throw new Error(
				`${PIPELINE_HTTP_POLICY} is switched off for this session`,
			);
		if (policy.autoApprove !== true) {
			if (!this.options.requestApproval)
				throw new Error(
					`${request.method} ${request.url} needs the person's approval, and this session cannot ask for it`,
				);
			const answer = await this.options.requestApproval({
				sessionId: this.options.sessionId,
				agentId: pipelineHolder(context.run),
				conversationId: this.options.sessionId,
				iteration: 0,
				toolCallId: `${context.run}:${context.node}`,
				toolName: PIPELINE_HTTP_POLICY,
				input: { method: request.method, url: request.url },
				policy: { ...policy, autoApprove: false },
			});
			if (!answer.approved)
				throw new Error(
					`the person did not approve ${request.method} ${request.url}${answer.reason ? `: ${answer.reason}` : ""}`,
				);
		}
		const response = await fetch(request.url, {
			method: request.method,
			headers: request.headers,
			...(request.body !== undefined ? { body: request.body } : {}),
			signal: context.signal,
		});
		const text = await response.text();
		const headers: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			headers[key] = value;
		});
		return {
			status: response.status,
			headers,
			body: text.length > OUTPUT_CAP ? text.slice(0, OUTPUT_CAP) : text,
		};
	}

	/** A `pipeline` node: another pipeline, run to its end. */
	private async runPipeline(
		name: string,
		inputs: Record<string, unknown>,
		context: NodeContext,
	): Promise<SubRunResult> {
		if (context.stack.some((entry) => sameName(entry, name)))
			throw new Error(
				`${name} is already running above this node (${[...context.stack, name].join(" → ")})`,
			);
		if (context.stack.length >= MAX_DEPTH)
			throw new Error(
				`pipelines run at most ${MAX_DEPTH} deep (${context.stack.join(" → ")})`,
			);
		const file = findPipeline(this.options.workspaceRoot, name);
		if (!file) throw new Error(`no pipeline "${name}"`);
		// A test's sub-run is a test too: pins, and nothing approved needed.
		const run = context.test
			? this.startTest(
					file,
					inputs,
					true,
					context.stack,
					undefined,
					context.run,
				)
			: this.startApproved(file, inputs, context.stack, context.run);
		const stop = () => run.stop("the pipeline above it stopped");
		context.signal.addEventListener("abort", stop, { once: true });
		try {
			const result = await run.result();
			return {
				run: result.run,
				status: result.status,
				...(result.error ? { error: result.error } : {}),
				items: result.items,
			};
		} finally {
			context.signal.removeEventListener("abort", stop);
		}
	}

	// ---------------------------------------------------------------------
	// Runs
	// ---------------------------------------------------------------------

	private track(
		run: PipelineRun,
		context: { test?: boolean; stack?: string[] } = {},
	): PipelineRun {
		this.live.set(run.id, run);
		void run.result().then(
			(result) => {
				this.live.delete(run.id);
				this.options.log?.(
					`[pipelines] ${run.id} ${result.status}${result.error ? `: ${result.error}` : ""}`,
				);
				const lines = [...result.boardLines];
				if (!context.test) {
					const started = this.startOnFailure(run, result, context.stack ?? []);
					if (started) lines.push(started);
				}
				this.options.onRunEnded?.(run, lines);
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

	/**
	 * A failed run's `onFailure` pipeline, started with what failed. Not for
	 * a stop, a test, or a pipeline already in the chain (no loops). Returns
	 * the line to tell the model, or why it did not start.
	 */
	private startOnFailure(
		run: PipelineRun,
		result: PipelineRunResult,
		stack: string[],
	): string | undefined {
		const name = run.definition.onFailure;
		if (!name || result.status !== "failed") return undefined;
		const chain = [...stack, run.definition.name];
		if (chain.some((entry) => sameName(entry, name))) {
			return `${run.id} failed; its onFailure pipeline ${name} is already in this chain (${chain.join(" → ")}), so it was not started again.`;
		}
		try {
			const file = findPipeline(this.options.workspaceRoot, name);
			if (!file) throw new Error(`no pipeline "${name}"`);
			const child = this.startApproved(
				file,
				{
					run: run.id,
					pipeline: run.definition.name,
					node: result.failedNode ?? "",
					error: result.error ?? "",
				},
				chain,
			);
			this.options.log?.(
				`[pipelines] ${run.id} failed: onFailure ${name} started as ${child.id}`,
			);
			return `${run.id} failed; its onFailure pipeline ${name} started as ${child.id}.`;
		} catch (error) {
			return `${run.id} failed; its onFailure pipeline ${name} could not start: ${(error as Error).message}`;
		}
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
			sessionId: this.options.sessionId,
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
		const run = this.startApproved(file, inputs, []);
		if (gateTask && this.options.board) {
			this.options.board.update(
				{ updates: [{ id: gateTask, gate: [`pipeline:${run.id}`] }] },
				{ by: "model" },
			);
		}
		return run;
	}

	/** The approved version of `file`, started; refused otherwise. */
	private startApproved(
		file: PipelineFile,
		inputs: Record<string, unknown>,
		stack: string[],
		parentRun?: string,
	): PipelineRun {
		const definition = this.approvedDefinition(file);
		return this.track(
			PipelineRun.start({
				...this.baseOptions(definition, file.hash),
				inputs,
				...(stack.length ? { stack } : {}),
				...(parentRun ? { parentRun } : {}),
			}),
			{ stack },
		);
	}

	/** What may run of `file`: its definition, when that version is approved. */
	private approvedDefinition(file: PipelineFile): PipelineDefinition {
		if (!file.valid || !file.definition)
			throw new Error(
				`"${file.name}" does not validate: ${file.errors.join("; ")}`,
			);
		if (!file.isApproved) {
			throw new Error(
				file.approved
					? `"${file.name}" changed since the version the person approved (${file.approved.hash}; the file is ${file.hash}). Only an approved version runs: ask the person to approve this one, or run \`pipeline test\`.`
					: `"${file.name}" has not been approved. Only an approved version runs: ask the person to approve it (the /pipelines command, or Approve in VS Code's board viewer), or run \`pipeline test\`.`,
			);
		}
		return file.definition;
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
		until?: string,
	): PipelineRun {
		return this.startTest(source, inputs, allowSideEffects, [], until);
	}

	private startTest(
		source: PipelineFile | { definition: PipelineDefinition; text: string },
		inputs: Record<string, unknown>,
		allowSideEffects: boolean,
		stack: string[],
		until?: string,
		parentRun?: string,
	): PipelineRun {
		const definition = source.definition;
		if (!definition) throw new Error("the pipeline does not validate");
		if (until && !definition.nodes.some((node) => node.id === until))
			throw new Error(
				`no node "${until}" to stop after (it has ${definition.nodes.map((node) => node.id).join(", ")})`,
			);
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
				...(until ? { until } : {}),
				...(stack.length ? { stack } : {}),
				...(parentRun ? { parentRun } : {}),
			}),
			{ test: true, stack },
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

	/**
	 * Resume a stopped or failed run, or pick up one the host was running
	 * when it stopped. `skip` names a failed node to skip instead of running
	 * again (the person's Skip).
	 */
	resume(runId: string, skip?: string): PipelineRun {
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
				: PipelineRun.resume({
						...options,
						...(skip !== undefined ? { skip } : {}),
					});
		if (!run) throw new Error(`${runId} cannot be resumed`);
		return this.track(run, {
			test: fold.run.pipeline.endsWith("-test"),
		});
	}

	/**
	 * Run `runId` again from `node`, as a new run that reuses what came
	 * before it (plan section 5). The pipeline as it is now: a run's approved
	 * version, a test's file as it is.
	 */
	rerun(runId: string, node: string): PipelineRun {
		const fold = foldJournal(
			readJournal(join(this.journalDir, `${runId}.jsonl`)),
		);
		if (!fold.run) throw new Error(`no run "${runId}"`);
		const test = fold.run.pipeline.endsWith("-test");
		const file = findPipeline(
			this.options.workspaceRoot,
			fold.run.pipeline.replace(/-test$/, ""),
		);
		if (!file?.definition)
			throw new Error(
				`the pipeline of ${runId} ("${fold.run.pipeline}") is no longer in the workspace`,
			);
		const definition = test
			? { ...file.definition, name: fold.run.pipeline }
			: this.approvedDefinition(file);
		return this.track(
			PipelineRun.rerun({
				...this.baseOptions(
					definition,
					file.hash,
					test
						? {
								...this.host,
								waitGate: async () => ({ open: true }),
								approve: async () => true,
							}
						: this.host,
				),
				from: runId,
				node,
				...(test ? { usePins: true } : {}),
			}),
			{ test },
		);
	}

	/**
	 * The person's action on a run, from the board viewer: Retry a failed
	 * node (the run resumes), Skip it (it counts as done and its input goes
	 * on), Re-run from a node (a new run reusing what came before), or Stop.
	 * Only this conversation's runs: another one's run has its task on that
	 * conversation's board. `lines` answer the person; `tell` is for the
	 * model, whose board the run is on.
	 */
	act(action: PipelineRunAction): PipelineActOutcome {
		const refuse = (line: string): PipelineActOutcome => ({
			ok: false,
			lines: [line],
		});
		const { op, run: runId, node } = action;
		const fold = foldJournal(
			readJournal(join(this.journalDir, `${runId}.jsonl`)),
		);
		if (!fold.run) return refuse(`There is no run ${runId} in this workspace.`);
		if (fold.run.session !== this.options.sessionId)
			return refuse(
				`${runId} belongs to another conversation. Open that conversation and send a message there to act on its runs.`,
			);
		if (fold.run.parent)
			return refuse(
				`${runId} is a sub-run of ${fold.run.parent}: act on that run's node instead.`,
			);
		const live = this.live.has(runId);
		if (op === "stop") {
			if (!live)
				return refuse(
					fold.status === "running" || fold.status === "waiting"
						? `${runId} is not running in this window. Send a message to the conversation: it picks its runs up.`
						: `${runId} is not running (it is ${fold.status}).`,
				);
			this.stop(runId, "stopped by the person");
			return {
				ok: true,
				lines: [`Stopped ${runId}.`],
				run: runId,
				tell: `The person stopped pipeline run ${runId}.`,
			};
		}
		if (!node) return refuse(`Pick a node of ${runId} first.`);
		const state = fold.nodes.get(node);
		if (live || fold.status === "running" || fold.status === "waiting")
			return refuse(`${runId} is still running. Stop it first.`);
		try {
			if (op === "rerun") {
				const next = this.rerun(runId, node);
				return {
					ok: true,
					lines: [`Re-running ${runId} from ${node} as ${next.id}.`],
					run: next.id,
					tell: `The person re-ran pipeline run ${runId} from node ${node}, as ${next.id}; it is running.`,
				};
			}
			if (fold.status === "done")
				return refuse(
					`${runId} finished. Re-run it from ${node} to run that node again.`,
				);
			if (state?.status !== "failed")
				return refuse(
					`${node} did not fail (it is ${state?.status ?? "not reached"}): only a failed node is ${op === "skip" ? "skipped" : "retried"}. Re-run from it instead.`,
				);
			if (op === "retry") {
				this.resume(runId);
				return {
					ok: true,
					lines: [`Retrying ${node}: ${runId} resumed.`],
					run: runId,
					tell: `The person retried node ${node} of pipeline run ${runId}; the run resumed.`,
				};
			}
			this.resume(runId, node);
			return {
				ok: true,
				lines: [`Skipped ${node}: its input went on, and ${runId} resumed.`],
				run: runId,
				tell: `The person skipped node ${node} of pipeline run ${runId} after it failed (${state.error ?? "no error recorded"}); its input items went on and the run resumed.`,
			};
		} catch (error) {
			return refuse((error as Error).message);
		}
	}

	/**
	 * After a reload: this session's runs that were running or waiting when
	 * the host stopped are picked up from their journals. A run of another
	 * session is left to it (its task is on that conversation's board), and a
	 * test is not picked up. Returns what to tell the model.
	 */
	recoverInterrupted(): string[] {
		if (!existsSync(this.journalDir)) return [];
		const lines: string[] = [];
		for (const file of readdirSync(this.journalDir)) {
			if (!file.endsWith(".jsonl")) continue;
			const id = file.slice(0, -".jsonl".length);
			if (this.live.has(id)) continue;
			const fold = foldJournal(readJournal(join(this.journalDir, file)));
			if (fold.status !== "running" && fold.status !== "waiting") continue;
			if (fold.run?.session !== this.options.sessionId) continue;
			if (fold.run.pipeline.endsWith("-test")) continue;
			// A sub-run is its parent's to decide: the parent's node failed as
			// interrupted, or starts a new one when it is idempotent.
			if (fold.run.parent) {
				appendJournal(join(this.journalDir, file), {
					t: "done",
					ts: Date.now(),
					status: "stopped",
					error: `the window closed while it ran inside ${fold.run.parent}`,
				});
				continue;
			}
			try {
				const run = this.resume(id);
				const view = run.view();
				lines.push(
					`${id} was running when the window closed; it was picked up from its journal${view.status === "failed" || view.error ? ` (${view.error})` : ""}.`,
				);
			} catch (error) {
				lines.push(
					`${id} was running when the window closed and could not be picked up: ${(error as Error).message}. \`pipeline resume\` tries again; \`pipeline status\` shows where it stopped.`,
				);
			}
		}
		return lines;
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

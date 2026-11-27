/**
 * Running a pipeline.
 *
 * A run schedules its nodes the way the task board schedules tasks: a node
 * is ready when what it is after has settled, and ready nodes run side by
 * side up to `maxParallel`. Every step is appended to the run's journal
 * before it is acted on, and mirrored onto the run's own board (one task
 * per node, layers and all), which the viewer draws.
 *
 * On the conversation's board a run is one task, held by `pipeline:<run>`
 * while it runs: the model carries on beside it, and a task the model gives
 * the gate `pipeline:<run>` waits for the run to end. The node tasks stay
 * on the run's board: on the conversation's they would cost every reader of
 * the board (its text, counts, nudges, the close-out guard) a filter.
 *
 * Everything outside the engine -- calling a tool, running a command,
 * deciding a gate, asking the person -- goes through the host, so a run
 * keeps the session's own approvals and policies.
 */

import { join } from "node:path";
import { isClosed } from "../task-graph/model";
import type { TaskGraphStore } from "../task-graph/store";
import { TaskGraphStore as Board } from "../task-graph/store";
import { type ExpressionScope, fill, fillString, test } from "./expr";
import {
	appendJournal,
	foldJournal,
	type JournalEvent,
	type NodeState,
	nextRunId,
	readJournal,
} from "./journal";
import {
	type AgentNode,
	type CommandNode,
	DEFAULT_PORT,
	ERROR_PORT,
	type HttpNode,
	type LoopNode,
	type MergeNode,
	type NodeOutput,
	nodePorts,
	type PipelineDefinition,
	type PipelineNode,
	parseRef,
	type RunStatus,
	type SetNode,
	type SubPipelineNode,
	type SwarmNode,
	type SwitchNode,
	type ToolNode,
} from "./model";

export interface NodeContext {
	run: string;
	node: string;
	signal: AbortSignal;
	/** The run's task on the conversation's board, when it has one. */
	task?: string;
	/**
	 * The run's task, made now if it has none: a run with no task of its own
	 * gets one only while it waits on the person (an approval, a `human:`).
	 */
	ensureTask?: () => string | undefined;
	/** The pipelines this run is inside, outermost first, its own last. */
	stack: string[];
	/** A test run: what it starts is a test too. */
	test?: boolean;
}

/** An http node's request, as the host sends it. */
export interface HttpRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string;
}

/** A sub-pipeline's run, as the host reports it when it ends. */
export interface SubRunResult {
	run: string;
	status: string;
	error?: string;
	items: unknown[];
}

/** What a run needs from the session it runs in. */
export interface PipelineHost {
	/** A tool the session offers, with the session's approvals. */
	callTool(
		name: string,
		input: unknown,
		context: NodeContext,
	): Promise<unknown>;
	/** A shell command, with the session's approvals. */
	runCommand(
		command: string,
		options: { cwd?: string },
		context: NodeContext,
	): Promise<{ exit: number; stdout: string; stderr: string }>;
	/** Resolves when a task-graph gate opens, or says why it cannot. */
	waitGate(
		spec: string,
		context: NodeContext,
	): Promise<{ open: true } | { failed: string }>;
	/** Asks the person; true approves. */
	approve(message: string, context: NodeContext): Promise<boolean>;
	/** A web request, with the session's approval for it. */
	http?(
		request: HttpRequest,
		context: NodeContext,
	): Promise<{ status: number; headers: Record<string, string>; body: string }>;
	/**
	 * The tool a configured agent named in an `agent` step is offered as.
	 * Default `subagent_<name>`; @cline/core passes its own naming (which
	 * also shortens and hashes long names).
	 */
	agentToolName?(agent: string): string;
	/** Runs another workspace pipeline to its end. */
	runPipeline?(
		name: string,
		inputs: Record<string, unknown>,
		context: NodeContext,
	): Promise<SubRunResult>;
}

export interface PipelineRunOptions {
	definition: PipelineDefinition;
	/** The version being run (`pipelineHash` of its file). */
	hash: string;
	host: PipelineHost;
	/** Where journals go: `<workspace>/.cerebriline/pipeline-runs`. */
	journalDir: string;
	inputs?: Record<string, unknown>;
	/** A test run: nodes with `pin` return it instead of running. */
	usePins?: boolean;
	/** A test that stops after this node: what follows it is not run. */
	until?: string;
	/** The pipelines this one runs inside (a sub-run), outermost first. */
	stack?: string[];
	/** The session starting it, recorded so it picks the run up after a reload. */
	sessionId?: string;
	/** A sub-run: the run whose `pipeline` node started it. */
	parentRun?: string;
	/** `$env`: what the host allows a pipeline to read. */
	env?: Record<string, string>;
	/**
	 * The conversation's board. A run for a task (`forTask`) acts on that
	 * task; a run without one puts a task on the board only while it waits
	 * on the person, and takes it off when the run ends.
	 */
	board?: TaskGraphStore;
	/** The board task the run is for: it waits on the run, and the run's approvals ask on it. */
	forTask?: string;
	now?: () => number;
	/** Every journal event, as it is written. */
	onEvent?: (event: JournalEvent, run: PipelineRun) => void;
}

export interface PipelineRunResult {
	run: string;
	status: Exclude<RunStatus, "running" | "waiting">;
	error?: string;
	/** What the conversation's board said when the run's task closed. */
	boardLines: string[];
	/** Its result: the items of the nodes nothing runs after, in order. */
	items: unknown[];
	/** The node whose failure ended it. */
	failedNode?: string;
}

export interface PipelineNodeView {
	id: string;
	type: string;
	name: string;
	status: NodeState["status"];
	attempts: number;
	port?: string;
	summary?: string;
	error?: string;
	reason?: string;
	waitingOn?: string;
}

const DEFAULT_MAX_PARALLEL = 4;
const TEXT_CLIP = 64_000;

class NodeFailure extends Error {}

/** The holder a run claims its conversation task as. */
export function pipelineHolder(run: string): string {
	return `pipeline:${run}`;
}

function clip(value: string | undefined): string | undefined {
	if (value === undefined || value.length <= TEXT_CLIP) return value;
	return `${value.slice(0, TEXT_CLIP)}\n… (${value.length - TEXT_CLIP} more characters)`;
}

function asText(value: unknown): string {
	return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** One line for a node's task and for `status`. */
function summarize(output: NodeOutput): string {
	const port = output.port !== DEFAULT_PORT ? `→ ${output.port}; ` : "";
	if (output.exit !== undefined) {
		const tail = (output.stdout ?? "").trim().split("\n").at(-1) ?? "";
		return `${port}exit ${output.exit}${tail ? `: ${tail.slice(0, 80)}` : ""}`;
	}
	if (output.text)
		return `${port}${output.text.replace(/\s+/g, " ").slice(0, 100)}`;
	return `${port}${output.items.length} item${output.items.length === 1 ? "" : "s"}`;
}

export class PipelineRun {
	readonly id: string;
	readonly journalPath: string;
	readonly definition: PipelineDefinition;
	/** The run's own board: one task per node, in the definition's order. */
	readonly board = new Board();
	private readonly options: PipelineRunOptions;
	private readonly nodes = new Map<string, PipelineNode>();
	private readonly taskOf = new Map<string, string>();
	private states = new Map<string, NodeState>();
	private inputs: Record<string, unknown> = {};
	private readonly abort = new AbortController();
	private conversationTask: string | undefined;
	private status: RunStatus = "running";
	private error: string | undefined;
	private halted = false;
	/** `until` reached: nothing more starts, and the run still ends done. */
	private stoppedAfter: string | undefined;
	private failedNode: string | undefined;
	private finished: Promise<PipelineRunResult> | undefined;

	private constructor(options: PipelineRunOptions, id: string) {
		this.options = options;
		this.id = id;
		this.definition = options.definition;
		this.journalPath = join(options.journalDir, `${id}.jsonl`);
		for (const node of options.definition.nodes) {
			this.nodes.set(node.id, node);
			this.states.set(node.id, { status: "pending", attempts: 0 });
		}
		// The run's board: the nodes as tasks, `after` as `depends`.
		const index = new Map(
			options.definition.nodes.map((node, at) => [node.id, at + 1]),
		);
		this.board.plan(
			{
				tasks: options.definition.nodes.map((node) => ({
					title: `${node.name ?? node.id} (${node.type})`,
					...(node.description ? { description: node.description } : {}),
					depends: [
						...new Set((node.after ?? []).map((ref) => parseRef(ref).node)),
					]
						.filter((id) => index.has(id))
						.map((id) => `#${index.get(id)}`),
				})),
			},
			{ by: pipelineHolder(id) },
			{ autoStart: false, silent: true },
		);
		options.definition.nodes.forEach((node, at) => {
			this.taskOf.set(node.id, `T${at + 1}`);
		});
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private write(event: JournalEvent): void {
		appendJournal(this.journalPath, event);
		this.options.onEvent?.(event, this);
	}

	private boardUpdate(node: string, fields: Record<string, unknown>): void {
		const id = this.taskOf.get(node);
		if (!id) return;
		this.board.update(
			{ updates: [{ id, ...fields }] },
			{ by: pipelineHolder(this.id) },
			{ silent: true },
		);
	}

	// ---------------------------------------------------------------------
	// Starting, recovering, resuming
	// ---------------------------------------------------------------------

	/** Start a new run. Refuses inputs that are missing or of the wrong type. */
	static start(options: PipelineRunOptions): PipelineRun {
		const inputs = resolveInputs(options.definition, options.inputs ?? {});
		const run = new PipelineRun(
			options,
			nextRunId(options.journalDir, options.definition.name),
		);
		run.inputs = inputs;
		run.takeTask();
		run.write({
			t: "run",
			ts: run.now(),
			run: run.id,
			pipeline: options.definition.name,
			hash: options.hash,
			inputs,
			...(run.conversationTask ? { task: run.conversationTask } : {}),
			...(options.sessionId ? { session: options.sessionId } : {}),
			...(options.parentRun ? { parent: options.parentRun } : {}),
			definition: options.definition,
		});
		run.finished = run.execute();
		return run;
	}

	/**
	 * Run again from `node`, in a new run: every node that is not `node`, not
	 * after it, and unchanged since `from` ran keeps the output it had there;
	 * the rest run (n8n's partial execution). A node is unchanged when its
	 * JSON is the same as in the definition `from` recorded, and so is
	 * everything it is after.
	 */
	static rerun(
		options: PipelineRunOptions & { from: string; node: string },
	): PipelineRun {
		const previous = foldJournal(
			readJournal(join(options.journalDir, `${options.from}.jsonl`)),
		);
		if (!previous.run) throw new Error(`no run "${options.from}"`);
		if (previous.status === "running" || previous.status === "waiting")
			throw new Error(`run "${options.from}" is still running`);
		const nodes = new Map(
			options.definition.nodes.map((node) => [node.id, node]),
		);
		if (!nodes.has(options.node))
			throw new Error(
				`no node "${options.node}" in "${options.definition.name}" (it has ${[...nodes.keys()].join(", ")})`,
			);
		const before = new Map(
			(previous.run.definition?.nodes ?? []).map((node) => [
				node.id,
				JSON.stringify(node),
			]),
		);
		if (!previous.run.definition && previous.run.hash !== options.hash)
			throw new Error(
				`run "${options.from}" did not record its definition, and the pipeline changed since: start a new run`,
			);
		// What has to run again: the node, what changed, and everything after either.
		const again = new Set<string>([options.node]);
		for (const node of options.definition.nodes) {
			const same = previous.run.definition
				? before.get(node.id) === JSON.stringify(node)
				: true;
			if (!same) again.add(node.id);
		}
		for (let grew = true; grew; ) {
			grew = false;
			for (const node of options.definition.nodes) {
				if (again.has(node.id)) continue;
				if ((node.after ?? []).some((ref) => again.has(parseRef(ref).node))) {
					again.add(node.id);
					grew = true;
				}
			}
		}
		const inputs = resolveInputs(
			options.definition,
			options.inputs ?? previous.run.inputs,
		);
		const run = new PipelineRun(
			options,
			nextRunId(options.journalDir, options.definition.name),
		);
		run.inputs = inputs;
		run.takeTask();
		run.write({
			t: "run",
			ts: run.now(),
			run: run.id,
			pipeline: options.definition.name,
			hash: options.hash,
			inputs,
			...(run.conversationTask ? { task: run.conversationTask } : {}),
			...(options.sessionId ? { session: options.sessionId } : {}),
			definition: options.definition,
			from: options.from,
		});
		for (const node of options.definition.nodes) {
			if (again.has(node.id)) continue;
			const old = previous.nodes.get(node.id);
			if (old?.status === "done" && old.output) {
				const state = run.states.get(node.id) as NodeState;
				state.status = "done";
				state.output = old.output;
				run.write({
					t: "end",
					ts: run.now(),
					node: node.id,
					output: old.output,
					reused: options.from,
				});
				run.boardUpdate(node.id, {
					status: "done",
					note: `${summarize(old.output)} (from ${options.from})`,
				});
			} else if (old?.status === "skipped") {
				run.markSkipped(node.id, old.reason ?? `skipped in ${options.from}`);
			}
		}
		run.finished = run.execute();
		return run;
	}

	/**
	 * Pick up a run the host was running when it stopped (a reload). A node
	 * that was in flight runs again when it is idempotent (waits and
	 * approvals always are); otherwise it fails as interrupted, and the run
	 * with it -- an edit, a push or a request may have happened once
	 * already, and running it again is not the engine's call.
	 */
	static recover(
		options: PipelineRunOptions & { run: string },
	): PipelineRun | undefined {
		const run = PipelineRun.load(options);
		if (!run) return undefined;
		const fold = foldJournal(readJournal(run.journalPath));
		if (fold.status !== "running" && fold.status !== "waiting")
			return undefined;
		let interrupted: string | undefined;
		for (const [id, state] of run.states) {
			if (state.status !== "running") continue;
			const node = run.nodes.get(id) as PipelineNode;
			const reason =
				"interrupted: it was running when the host stopped, and it is not marked idempotent";
			if (node.idempotent || node.type === "wait" || node.type === "approval") {
				state.status = "pending";
				delete state.waitingOn;
			} else if (node.onError === "continue" || node.onError === "route") {
				// The author said what a failure does here; an interruption is one.
				run.settleError(node, reason, run.inputItems(node));
			} else {
				interrupted ??= id;
				run.markFailed(id, reason);
			}
		}
		run.write({ t: "resume", ts: run.now() });
		run.reopenConversationTask();
		if (interrupted) {
			run.halted = true;
			run.failedNode = interrupted;
			run.error = `node "${interrupted}" was interrupted`;
		}
		run.finished = run.execute();
		return run;
	}

	/**
	 * Run a failed or stopped run again from where it stopped: its failed
	 * nodes and the ones never reached run; what finished keeps its output.
	 * `skip` names a failed node the person skips instead: it counts as done
	 * and its input items go on through `out`. A node that picks an output
	 * (`if`, `switch`, `approval`) has no one output to go on through, so it
	 * is not skipped.
	 */
	static resume(
		options: PipelineRunOptions & { run: string; skip?: string },
	): PipelineRun {
		const run = PipelineRun.load(options);
		if (!run)
			throw new Error(`no run "${options.run}" in ${options.journalDir}`);
		const fold = foldJournal(readJournal(run.journalPath));
		if (fold.status === "done")
			throw new Error(`run "${options.run}" finished; start a new one`);
		if (fold.status === "running" || fold.status === "waiting") {
			throw new Error(`run "${options.run}" is still running`);
		}
		const skip = options.skip;
		if (skip !== undefined) {
			const node = run.nodes.get(skip);
			const state = run.states.get(skip);
			if (!node || !state)
				throw new Error(
					`no node "${skip}" in ${options.run} (it has ${[...run.nodes.keys()].join(", ")})`,
				);
			if (state.status !== "failed")
				throw new Error(
					`"${skip}" did not fail (it is ${state.status}); only a failed node is skipped`,
				);
			if (nodePorts(node)[0] !== DEFAULT_PORT)
				throw new Error(
					`"${skip}" is ${node.type === "if" ? "an" : "a"} ${node.type}: it picks one of ${nodePorts(node).join(", ")}, so skipping it has no output to go on through. Retry it, or re-run from it.`,
				);
		}
		for (const [id, state] of run.states) {
			if (id === skip) continue;
			if (state.status === "failed" || state.status === "running") {
				state.status = "pending";
				delete state.error;
				run.boardUpdate(id, { status: "pending", note: "resumed" });
			}
		}
		run.write({ t: "resume", ts: run.now() });
		if (skip !== undefined) run.bypass(skip);
		run.reopenConversationTask();
		run.finished = run.execute();
		return run;
	}

	/** The person's skip: the failed node is done, and its input items go on. */
	private bypass(id: string): void {
		const node = this.nodes.get(id) as PipelineNode;
		const state = this.states.get(id) as NodeState;
		const output: NodeOutput = {
			items: this.inputItems(node),
			port: DEFAULT_PORT,
		};
		state.status = "done";
		state.output = output;
		state.bypassed = true;
		this.write({
			t: "end",
			ts: this.now(),
			node: id,
			output,
			bypassed: true,
		});
		this.boardUpdate(id, {
			status: "done",
			note: `skipped by the person after it failed; its ${output.items.length} input item${output.items.length === 1 ? "" : "s"} went on`,
		});
	}

	private static load(
		options: PipelineRunOptions & { run: string },
	): PipelineRun | undefined {
		const run = new PipelineRun(options, options.run);
		const events = readJournal(run.journalPath);
		const fold = foldJournal(events);
		if (!fold.run) return undefined;
		run.inputs = fold.run.inputs;
		run.conversationTask = fold.run.task ?? run.ownTaskOnBoard();
		for (const [id, state] of fold.nodes) {
			if (!run.nodes.has(id)) continue;
			run.states.set(id, { ...state });
			const task = run.taskOf.get(id);
			if (!task) continue;
			if (state.status === "done")
				run.boardUpdate(id, {
					status: "done",
					note: summarize(state.output as NodeOutput),
				});
			else if (state.status === "skipped")
				run.boardUpdate(id, {
					status: "cancelled",
					note: `skipped: ${state.reason}`,
				});
			else if (state.status === "failed")
				run.boardUpdate(id, {
					status: "cancelled",
					note: `failed: ${state.error}`,
				});
		}
		return run;
	}

	// ---------------------------------------------------------------------
	// The conversation's board
	// ---------------------------------------------------------------------

	/** The task the run was started for, when the board has it open. */
	private takeTask(): void {
		const id = this.options.forTask;
		const task = id ? this.options.board?.getState().tasks.get(id) : undefined;
		if (task && !isClosed(task.status)) this.conversationTask = id;
	}

	/** Whether the run's task is the run's own, made to ask the person, not one it was started for. */
	private ownsTask(id: string | undefined): boolean {
		return (
			!!id &&
			this.options.board?.getState().tasks.get(id)?.claimedBy ===
				pipelineHolder(this.id)
		);
	}

	/** A task of the run's own left on the board by a host that stopped, for a resume. */
	private ownTaskOnBoard(): string | undefined {
		const state = this.options.board?.getState();
		const holder = pipelineHolder(this.id);
		return state?.order.find((id) => {
			const task = state.tasks.get(id);
			return task?.claimedBy === holder && !isClosed(task.status);
		});
	}

	/**
	 * The task the run's approvals and waits ask on: the task it was started
	 * for, or one of its own, made now and taken off when the run ends.
	 */
	private ensureConversationTask(): string | undefined {
		const store = this.options.board;
		if (!store) return undefined;
		const current = this.conversationTask
			? store.getState().tasks.get(this.conversationTask)
			: undefined;
		if (current) return current.id;
		const holder = pipelineHolder(this.id);
		const number = /-(\d+)$/.exec(this.id)?.[1] ?? "";
		const outcome = store.plan(
			{
				tasks: [
					{
						title: `▶ ${this.definition.name} #${number}`,
						description: `Pipeline run ${this.id}${this.definition.description ? `: ${this.definition.description}` : ""}. It is waiting for the person; it leaves the board when the run ends.`,
					},
				],
			},
			{ by: holder },
			{ autoStart: false },
		);
		const id = /Created \d+: (T[\d.]+)/.exec(outcome.lines[0] ?? "")?.[1];
		if (!id) return undefined;
		this.conversationTask = id;
		store.setPipelineLive(holder, true);
		store.update({ updates: [{ id, status: "active" }] }, { by: holder });
		return id;
	}

	private reopenConversationTask(): void {
		const store = this.options.board;
		const id = this.conversationTask;
		if (!store || !id || !this.ownsTask(id)) return;
		const holder = pipelineHolder(this.id);
		store.setPipelineLive(holder, true);
		store.update(
			{ updates: [{ id, status: "active", note: "the run resumed" }] },
			{ by: holder },
		);
	}

	private closeConversationTask(
		result: Pick<PipelineRunResult, "run" | "status" | "error">,
	): string[] {
		const store = this.options.board;
		if (!store) return [];
		const holder = pipelineHolder(this.id);
		const lines: string[] = [];
		const id = this.conversationTask;
		const owned = this.ownsTask(id);
		store.setPipelineLive(holder, false);
		// The run's own task was there to ask the person: it goes with the run.
		// The task it was started for stays, and its gate says how the run ended.
		if (owned && id) store.remove([id], { by: holder });
		if (result.status !== "stopped") {
			const gate = `pipeline:${this.id}`;
			lines.push(
				...store.resolveGates((entry) =>
					entry.spec === gate
						? result.status === "done"
							? { open: true }
							: {
									failed: `the run ${result.status}${result.error ? `: ${result.error}` : ""}`,
								}
						: undefined,
				).lines,
			);
		}
		return lines;
	}

	// ---------------------------------------------------------------------
	// Scheduling
	// ---------------------------------------------------------------------

	/** Settles when the run ends. */
	result(): Promise<PipelineRunResult> {
		return this.finished as Promise<PipelineRunResult>;
	}

	/** Stop the run: nodes in flight are told to stop, and fail as stopped. */
	stop(reason = "stopped"): void {
		if (
			this.status === "done" ||
			this.status === "failed" ||
			this.status === "stopped"
		)
			return;
		this.status = "stopped";
		this.error = reason;
		this.halted = true;
		this.abort.abort(new Error(reason));
	}

	private fired(ref: string): boolean {
		const { node, port } = parseRef(ref);
		const state = this.states.get(node);
		return state?.status === "done" && state.output?.port === port;
	}

	private settled(ref: string): boolean {
		const status = this.states.get(parseRef(ref).node)?.status;
		return status === "done" || status === "skipped" || status === "failed";
	}

	/**
	 * Which pending nodes can run now, and which can never run (a branch not
	 * taken); the latter are skipped, which may settle more, so it repeats.
	 */
	private settle(): PipelineNode[] {
		for (;;) {
			let skipped = false;
			const ready: PipelineNode[] = [];
			for (const node of this.nodes.values()) {
				const state = this.states.get(node.id) as NodeState;
				if (state.status !== "pending") continue;
				const after = node.after ?? [];
				const mode =
					node.type === "merge" ? ((node as MergeNode).mode ?? "all") : "all";
				if (mode === "first" && after.some((ref) => this.fired(ref))) {
					ready.push(node);
					continue;
				}
				if (!after.every((ref) => this.settled(ref))) continue;
				const anyFired = after.some((ref) => this.fired(ref));
				const allFired = after.every((ref) => this.fired(ref));
				const runs =
					after.length === 0 || (mode === "all" ? allFired : anyFired);
				if (runs) {
					ready.push(node);
				} else {
					const missing = after.find((ref) => !this.fired(ref)) as string;
					const failed =
						this.states.get(parseRef(missing).node)?.status === "failed";
					if (failed) continue; // left unreached: the run stops on a failure
					this.markSkipped(node.id, `${missing} did not run`);
					skipped = true;
				}
			}
			if (!skipped) return ready;
		}
	}

	private inputItems(node: PipelineNode): unknown[] {
		const after = node.after ?? [];
		const fired = after.filter((ref) => this.fired(ref));
		const lists = fired.map(
			(ref) => this.states.get(parseRef(ref).node)?.output?.items ?? [],
		);
		if (node.type === "merge") {
			const merge = node as MergeNode;
			if (merge.mode === "first") return lists[0] ?? [];
			if (merge.mode === "by-key")
				return mergeByKey(lists, merge.key as string);
		}
		return lists.flat();
	}

	private async execute(): Promise<PipelineRunResult> {
		const max = this.definition.maxParallel ?? DEFAULT_MAX_PARALLEL;
		const running = new Map<string, Promise<void>>();
		for (;;) {
			if (!this.halted && !this.stoppedAfter) {
				for (const node of this.settle()) {
					if (running.size >= max) break;
					if (running.has(node.id)) continue;
					running.set(
						node.id,
						this.launch(node).finally(() => running.delete(node.id)),
					);
				}
			}
			if (running.size === 0) break;
			await Promise.race(running.values());
		}
		const status: PipelineRunResult["status"] =
			this.status === "stopped" ? "stopped" : this.halted ? "failed" : "done";
		this.status = status;
		if (status !== "done" || this.stoppedAfter) {
			// What was never reached says so on the run's board.
			const why = this.stoppedAfter
				? `the test stopped after ${this.stoppedAfter}`
				: `the run ${status}`;
			for (const [id, state] of this.states) {
				if (state.status === "pending")
					this.boardUpdate(id, { note: `not reached: ${why}` });
			}
		}
		this.write({
			t: "done",
			ts: this.now(),
			status,
			...(this.error ? { error: this.error } : {}),
		});
		const result = {
			run: this.id,
			status,
			...(this.error ? { error: this.error } : {}),
		};
		return {
			...result,
			boardLines: this.closeConversationTask(result),
			items: this.resultItems(),
			...(this.failedNode ? { failedNode: this.failedNode } : {}),
		};
	}

	/** The items of the nodes that ran and that nothing runs after. */
	private resultItems(): unknown[] {
		const fed = new Set<string>();
		for (const node of this.nodes.values())
			for (const ref of node.after ?? []) fed.add(parseRef(ref).node);
		return this.definition.nodes
			.filter((node) => !fed.has(node.id))
			.flatMap((node) => {
				const state = this.states.get(node.id);
				return state?.status === "done" ? (state.output?.items ?? []) : [];
			});
	}

	/** `onError: continue | route`: the failure becomes the node's output. */
	private settleError(
		node: PipelineNode,
		message: string,
		items: unknown[],
	): void {
		const state = this.states.get(node.id) as NodeState;
		const route = node.onError === "route";
		const output: NodeOutput = {
			items: [route ? { error: message, input: items } : { error: message }],
			port: route ? ERROR_PORT : DEFAULT_PORT,
			error: message,
		};
		state.status = "done";
		state.output = output;
		delete state.waitingOn;
		this.write({ t: "end", ts: this.now(), node: node.id, output });
		this.boardUpdate(node.id, {
			status: "done",
			note: `failed, ${route ? "routed to error" : "went on"}: ${message}`,
		});
	}

	private async launch(node: PipelineNode): Promise<void> {
		const state = this.states.get(node.id) as NodeState;
		const items = this.inputItems(node);
		const tries = 1 + (node.retry?.max ?? 0);
		for (let attempt = 1; ; attempt++) {
			state.status = "running";
			state.attempts += 1;
			this.write({
				t: "start",
				ts: this.now(),
				node: node.id,
				attempt: state.attempts,
			});
			this.boardUpdate(node.id, { status: "active" });
			try {
				const pinned = this.options.usePins === true && Array.isArray(node.pin);
				const output = pinned
					? { items: node.pin as unknown[], port: DEFAULT_PORT }
					: await this.runNode(node, items, {});
				state.status = "done";
				state.output = output;
				delete state.lastError;
				this.write({
					t: "end",
					ts: this.now(),
					node: node.id,
					output,
					...(pinned ? { pinned: true } : {}),
				});
				this.boardUpdate(node.id, { status: "done", note: summarize(output) });
				if (this.options.until === node.id) this.stoppedAfter = node.id;
				return;
			} catch (error) {
				if (this.abort.signal.aborted) {
					this.fail(node.id, `stopped: ${this.error ?? "stopped"}`);
					return;
				}
				const message = (error as Error).message || String(error);
				if (attempt < tries) {
					const retry = node.retry as NonNullable<PipelineNode["retry"]>;
					const wait =
						(retry.wait ?? 1) * (retry.backoff ?? 2) ** (attempt - 1);
					state.lastError = message;
					this.write({
						t: "retry",
						ts: this.now(),
						node: node.id,
						attempt: state.attempts,
						error: message,
						wait,
					});
					this.boardUpdate(node.id, {
						note: `attempt ${attempt} failed (${message.slice(0, 120)}); again in ${wait} s`,
					});
					try {
						await pause(wait * 1000, this.abort.signal);
					} catch {
						this.fail(node.id, `stopped: ${this.error ?? "stopped"}`);
						return;
					}
					continue;
				}
				const tried = tries > 1 ? ` (after ${tries} attempts)` : "";
				if (node.onError === "continue" || node.onError === "route") {
					this.settleError(node, `${message}${tried}`, items);
					return;
				}
				this.fail(node.id, `${message}${tried}`);
				return;
			}
		}
	}

	/** A node failed for good: the run stops at it. */
	private fail(id: string, message: string): void {
		this.markFailed(id, message);
		if (!this.halted) {
			this.halted = true;
			this.failedNode = id;
			this.error = `node "${id}" failed: ${message}`;
		}
	}

	private markFailed(id: string, error: string): void {
		const state = this.states.get(id) as NodeState;
		state.status = "failed";
		state.error = error;
		delete state.waitingOn;
		this.write({ t: "fail", ts: this.now(), node: id, error });
		this.boardUpdate(id, { status: "cancelled", note: `failed: ${error}` });
	}

	private markSkipped(id: string, reason: string): void {
		const state = this.states.get(id) as NodeState;
		state.status = "skipped";
		state.reason = reason;
		this.write({ t: "skip", ts: this.now(), node: id, reason });
		this.boardUpdate(id, { status: "cancelled", note: `skipped: ${reason}` });
	}

	// ---------------------------------------------------------------------
	// Nodes
	// ---------------------------------------------------------------------

	private scope(items: unknown[], extra: ExpressionScope): ExpressionScope {
		const nodes: Record<string, unknown> = {};
		for (const [id, state] of this.states) {
			if (state.output) nodes[id] = { ...state.output };
		}
		const item = "$item" in extra ? extra.$item : items[0];
		return {
			$vars: this.inputs,
			$node: nodes,
			$input: items,
			$json: item,
			$item: item,
			$index: 0,
			$run: { id: this.id, pipeline: this.definition.name },
			$env: this.options.env ?? {},
			...extra,
		};
	}

	private signalFor(node: { timeout?: number }): AbortSignal {
		if (!node.timeout) return this.abort.signal;
		return AbortSignal.any([
			this.abort.signal,
			AbortSignal.timeout(node.timeout * 1000),
		]);
	}

	private async runNode(
		node: PipelineNode | (Omit<PipelineNode, "after"> & { id: string }),
		items: unknown[],
		extra: ExpressionScope,
	): Promise<NodeOutput> {
		const signal = this.signalFor(node);
		const context: NodeContext = {
			run: this.id,
			node: node.id,
			signal,
			...(this.conversationTask ? { task: this.conversationTask } : {}),
			ensureTask: () => this.ensureConversationTask(),
			stack: [...(this.options.stack ?? []), this.definition.name],
			...(this.options.usePins ? { test: true } : {}),
		};
		const scope = this.scope(items, extra);
		const raced = <T>(work: Promise<T>): Promise<T> =>
			new Promise<T>((resolve, reject) => {
				if (signal.aborted) {
					reject(signal.reason ?? new Error("stopped"));
					return;
				}
				const onAbort = () =>
					reject(
						signal.reason instanceof Error &&
							signal.reason.name === "TimeoutError"
							? new NodeFailure(`timed out after ${node.timeout} s`)
							: (signal.reason ?? new Error("stopped")),
					);
				signal.addEventListener("abort", onAbort, { once: true });
				work
					.then(resolve, reject)
					.finally(() => signal.removeEventListener("abort", onAbort));
			});

		switch (node.type) {
			case "tool": {
				const tool = node as ToolNode;
				const result = await raced(
					this.options.host.callTool(
						tool.tool,
						fill(tool.input ?? {}, scope),
						context,
					),
				);
				return {
					items: Array.isArray(result) ? result : [result],
					port: DEFAULT_PORT,
					text: clip(asText(result)),
				};
			}
			case "command": {
				const command = node as CommandNode;
				const cwd = command.cwd ? asText(fill(command.cwd, scope)) : undefined;
				const result = await raced(
					this.options.host.runCommand(
						asText(fill(command.command, scope)),
						cwd ? { cwd } : {},
						context,
					),
				);
				const output: NodeOutput = {
					items: [
						{
							exit: result.exit,
							stdout: clip(result.stdout),
							stderr: clip(result.stderr),
						},
					],
					port: DEFAULT_PORT,
					exit: result.exit,
					stdout: clip(result.stdout) ?? "",
					stderr: clip(result.stderr) ?? "",
				};
				if (result.exit !== 0 && !command.allowFailure) {
					const tail = (result.stderr || result.stdout)
						.trim()
						.split("\n")
						.slice(-3)
						.join(" | ");
					throw new NodeFailure(
						`exited ${result.exit}${tail ? `: ${tail.slice(0, 300)}` : ""}`,
					);
				}
				return output;
			}
			case "set": {
				const set = node as SetNode;
				if (set.items !== undefined) {
					const value = fillString(set.items, scope);
					if (!Array.isArray(value))
						throw new NodeFailure(
							`"items" gave ${asText(value).slice(0, 60)}, not a list`,
						);
					return { items: value, port: DEFAULT_PORT };
				}
				const sources = items.length > 0 ? items : [undefined];
				const out = sources.map((item, index) => {
					const itemScope = {
						...scope,
						$item: item,
						$json: item,
						$index: index,
					};
					const base = set.keepInput && isObject(item) ? { ...item } : {};
					return {
						...base,
						...(fill(set.fields ?? {}, itemScope) as Record<string, unknown>),
					};
				});
				return { items: out, port: DEFAULT_PORT };
			}
			case "if":
				return {
					items,
					port: test((node as { when: string }).when, scope) ? "true" : "false",
				};
			case "switch": {
				const sw = node as SwitchNode;
				const value = asText(
					sw.on.includes("{{")
						? fillString(sw.on, scope)
						: fillString(`{{${sw.on}}}`, scope),
				);
				return {
					items,
					port: sw.cases.find((name) => name === value) ?? "default",
				};
			}
			case "merge":
				return { items, port: DEFAULT_PORT };
			case "loop":
				return this.runLoop(node as LoopNode, scope, context);
			case "wait": {
				const spec = asText(fill((node as { gate: string }).gate, scope));
				this.waiting(node.id, spec);
				const decision = await raced(this.options.host.waitGate(spec, context));
				if ("failed" in decision)
					throw new NodeFailure(
						`${spec} can no longer open: ${decision.failed}`,
					);
				return { items, port: DEFAULT_PORT };
			}
			case "approval": {
				const message = asText(
					fill((node as { message: string }).message, scope),
				);
				this.waiting(node.id, `human:${message}`);
				const approved = await raced(
					this.options.host.approve(message, context),
				);
				return { items, port: approved ? "approve" : "reject" };
			}
			case "check": {
				const check = node as {
					command?: string;
					when?: string;
					message?: string;
				};
				if (check.command) {
					const result = await raced(
						this.options.host.runCommand(
							asText(fill(check.command, scope)),
							{},
							context,
						),
					);
					if (result.exit !== 0) {
						throw new NodeFailure(
							`${check.message ?? "check failed"}: \`${check.command}\` exited ${result.exit}`,
						);
					}
				}
				if (check.when !== undefined && !test(check.when, scope)) {
					throw new NodeFailure(
						`${check.message ?? "check failed"}: ${check.when} is false`,
					);
				}
				return { items, port: DEFAULT_PORT };
			}
			case "agent": {
				const agent = node as AgentNode;
				const task = asText(fill(agent.task, scope));
				const result = await raced(
					agent.agent
						? this.options.host.callTool(
								this.options.host.agentToolName?.(agent.agent) ??
									`subagent_${agent.agent}`,
								{ prompt: task, wait: true },
								context,
							)
						: this.options.host.callTool(
								"spawn_agent",
								{
									task,
									...(agent.instructions
										? { instructions: asText(fill(agent.instructions, scope)) }
										: {}),
									name: agent.name ?? agent.id,
									wait: true,
								},
								context,
							),
				);
				return agentOutput(result, agent.json === true);
			}
			case "swarm": {
				const swarm = node as SwarmNode;
				const listed =
					typeof swarm.tasks === "string"
						? swarm.tasks.includes("{{")
							? fillString(swarm.tasks, scope)
							: fillString(`{{${swarm.tasks}}}`, scope)
						: swarm.tasks;
				if (listed !== undefined && !Array.isArray(listed))
					throw new NodeFailure(
						`"tasks" gave ${asText(listed).slice(0, 60)}, not a list`,
					);
				const result = await raced(
					this.options.host.callTool(
						"spawn_swarm",
						{
							systemPrompt: asText(fill(swarm.instructions, scope)),
							...(listed
								? {
										tasks: listed.map((entry) => ({
											task: asText(fill(asText(entry), scope)),
										})),
									}
								: {
										task: asText(fill(swarm.task ?? "", scope)),
										...(swarm.count ? { count: swarm.count } : {}),
									}),
							wait: true,
						},
						context,
					),
				);
				return agentOutput(result, false);
			}
			case "http": {
				const http = node as HttpNode;
				if (!this.options.host.http)
					throw new NodeFailure("this session cannot make web requests");
				const body =
					http.body === undefined
						? undefined
						: typeof http.body === "string"
							? asText(fill(http.body, scope))
							: JSON.stringify(fill(http.body, scope));
				const headers = Object.fromEntries(
					Object.entries(http.headers ?? {}).map(([key, value]) => [
						key,
						asText(fill(value, scope)),
					]),
				);
				if (
					body !== undefined &&
					typeof http.body !== "string" &&
					!Object.keys(headers).some(
						(key) => key.toLowerCase() === "content-type",
					)
				)
					headers["content-type"] = "application/json";
				const response = await raced(
					this.options.host.http(
						{
							method: (http.method ?? "GET").toUpperCase(),
							url: asText(fill(http.url, scope)),
							headers,
							...(body !== undefined ? { body } : {}),
						},
						context,
					),
				);
				let parsed: unknown = response.body;
				try {
					parsed = JSON.parse(response.body);
				} catch {
					// Text it is.
				}
				const ok = response.status >= 200 && response.status < 300;
				if (!ok && !http.allowFailure)
					throw new NodeFailure(
						`${(http.method ?? "GET").toUpperCase()} returned ${response.status}${response.body ? `: ${response.body.trim().slice(0, 200)}` : ""}`,
					);
				return {
					items: Array.isArray(parsed)
						? parsed
						: [
								{
									status: response.status,
									headers: response.headers,
									body: parsed,
								},
							],
					port: DEFAULT_PORT,
					status: response.status,
					text: clip(response.body),
				};
			}
			case "pipeline": {
				const sub = node as SubPipelineNode;
				if (!this.options.host.runPipeline)
					throw new NodeFailure("this session cannot run another pipeline");
				const name = asText(fill(sub.pipeline, scope));
				const result = await raced(
					this.options.host.runPipeline(
						name,
						(fill(sub.inputs ?? {}, scope) as Record<string, unknown>) ?? {},
						context,
					),
				);
				if (result.status !== "done")
					throw new NodeFailure(
						`${name} (${result.run}) ${result.status}${result.error ? `: ${result.error}` : ""}`,
					);
				return { items: result.items, port: DEFAULT_PORT, run: result.run };
			}
			default:
				throw new NodeFailure(
					`"${(node as { type: string }).type}" is not a node type`,
				);
		}
	}

	private waiting(id: string, on: string): void {
		const state = this.states.get(id);
		if (state) state.waitingOn = on;
		this.write({ t: "wait", ts: this.now(), node: id, on });
		this.boardUpdate(id, { status: "waiting", note: `waiting on ${on}` });
	}

	private async runLoop(
		loop: LoopNode,
		scope: ExpressionScope,
		context: NodeContext,
	): Promise<NodeOutput> {
		const over = loop.over.includes("{{")
			? fillString(loop.over, scope)
			: fillString(`{{${loop.over}}}`, scope);
		if (!Array.isArray(over))
			throw new NodeFailure(
				`"over" gave ${asText(over).slice(0, 60)}, not a list`,
			);
		const results: unknown[][] = new Array(over.length);
		const parallel = Math.max(1, loop.parallel ?? 1);
		let next = 0;
		const worker = async () => {
			while (next < over.length) {
				const index = next++;
				const item = over[index];
				const body = {
					...loop.body,
					id: `${loop.id}[${index}]`,
				} as PipelineNode;
				const output = await this.runNode(body, [item], {
					$item: item,
					$json: item,
					$index: index,
				});
				results[index] = output.items;
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(parallel, over.length) }, worker),
		);
		if (context.signal.aborted)
			throw context.signal.reason ?? new Error("stopped");
		return { items: results.flat(), port: DEFAULT_PORT };
	}

	// ---------------------------------------------------------------------
	// Views
	// ---------------------------------------------------------------------

	/** Where the run stands, node by node. */
	view(): {
		run: string;
		pipeline: string;
		status: RunStatus;
		error?: string;
		task?: string;
		nodes: PipelineNodeView[];
	} {
		const waiting = [...this.states.values()].some((state) => state.waitingOn);
		return {
			run: this.id,
			pipeline: this.definition.name,
			status: this.status === "running" && waiting ? "waiting" : this.status,
			...(this.error ? { error: this.error } : {}),
			...(this.conversationTask ? { task: this.conversationTask } : {}),
			nodes: this.definition.nodes.map((node) => {
				const state = this.states.get(node.id) as NodeState;
				return {
					id: node.id,
					type: node.type,
					name: node.name ?? node.id,
					status: state.status,
					attempts: state.attempts,
					...(state.output
						? { port: state.output.port, summary: summarize(state.output) }
						: {}),
					...(state.error ? { error: state.error } : {}),
					...(state.reason ? { reason: state.reason } : {}),
					...(state.waitingOn ? { waitingOn: state.waitingOn } : {}),
				};
			}),
		};
	}
}

/** A run's inputs: defaults filled, required ones present, types as declared. */
export function resolveInputs(
	definition: PipelineDefinition,
	given: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...given };
	const problems: string[] = [];
	for (const [name, spec] of Object.entries(definition.inputs ?? {})) {
		if (out[name] === undefined && spec.default !== undefined)
			out[name] = spec.default;
		const value = out[name];
		if (value === undefined) {
			if (spec.required !== false && spec.default === undefined)
				problems.push(`"${name}" is required`);
			continue;
		}
		const type = Array.isArray(value)
			? "array"
			: value === null
				? "null"
				: typeof value;
		if (spec.type && spec.type !== type)
			problems.push(`"${name}" is a ${spec.type}, not a ${type}`);
	}
	if (problems.length > 0) throw new Error(`inputs: ${problems.join("; ")}`);
	return out;
}

function mergeByKey(lists: unknown[][], key: string): unknown[] {
	const merged = new Map<string, Record<string, unknown>>();
	const loose: unknown[] = [];
	for (const list of lists) {
		for (const item of list) {
			if (!isObject(item) || item[key] === undefined) {
				loose.push(item);
				continue;
			}
			const id = asText(item[key]);
			merged.set(id, { ...(merged.get(id) ?? {}), ...item });
		}
	}
	return [...merged.values(), ...loose];
}

/** Waits, or rejects when the run is stopped. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
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

/** The answer's text: a report's `text`, or the whole result as JSON. */
function answerText(result: unknown): string {
	if (typeof result === "string") return result;
	if (isObject(result)) {
		for (const key of ["text", "report", "summary", "result"]) {
			if (typeof result[key] === "string") return result[key] as string;
		}
	}
	return asText(result);
}

/** JSON out of an answer: the whole text, or the first fenced or bracketed block. */
export function answerJson(text: string): unknown {
	const attempts = [
		text.trim(),
		/```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]?.trim(),
		/[[{][\s\S]*[\]}]/.exec(text)?.[0],
	];
	for (const candidate of attempts) {
		if (!candidate) continue;
		try {
			return JSON.parse(candidate) as unknown;
		} catch {
			// The next shape.
		}
	}
	throw new NodeFailure(`the answer is not JSON: ${text.trim().slice(0, 160)}`);
}

/** An agent's or a swarm's result as a node's output. */
function agentOutput(result: unknown, json: boolean): NodeOutput {
	// One item per worker when the result lists them.
	const listed = isObject(result)
		? (["reports", "agents", "results", "workers"]
				.map((key) => result[key])
				.find((value) => Array.isArray(value)) as unknown[] | undefined)
		: Array.isArray(result)
			? result
			: undefined;
	const text = answerText(result);
	if (json) {
		const value = answerJson(text);
		return {
			items: Array.isArray(value) ? value : [value],
			port: DEFAULT_PORT,
			text: clip(text),
		};
	}
	return {
		items: listed ?? [{ text }],
		port: DEFAULT_PORT,
		text: clip(text),
	};
}

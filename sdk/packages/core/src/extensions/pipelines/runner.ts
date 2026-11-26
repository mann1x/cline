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
import type { TaskGraphStore } from "../tools/task-graph/store";
import { TaskGraphStore as Board } from "../tools/task-graph/store";
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
	type CommandNode,
	DEFAULT_PORT,
	type LoopNode,
	type MergeNode,
	type NodeOutput,
	type PipelineDefinition,
	type PipelineNode,
	parseRef,
	type RunStatus,
	type SetNode,
	type SwitchNode,
	type ToolNode,
} from "./model";

export interface NodeContext {
	run: string;
	node: string;
	signal: AbortSignal;
	/** The run's task on the conversation's board, when it has one. */
	task?: string;
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
	/** `$env`: what the host allows a pipeline to read. */
	env?: Record<string, string>;
	/** The conversation's board: the run gets one task on it. */
	board?: TaskGraphStore;
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
		run.openConversationTask();
		run.write({
			t: "run",
			ts: run.now(),
			run: run.id,
			pipeline: options.definition.name,
			hash: options.hash,
			inputs,
			...(run.conversationTask ? { task: run.conversationTask } : {}),
		});
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
			if (node.idempotent || node.type === "wait" || node.type === "approval") {
				state.status = "pending";
				delete state.waitingOn;
			} else {
				interrupted ??= id;
				run.markFailed(
					id,
					"interrupted: it was running when the host stopped, and it is not marked idempotent",
				);
			}
		}
		run.write({ t: "resume", ts: run.now() });
		run.reopenConversationTask();
		if (interrupted) {
			run.halted = true;
			run.error = `node "${interrupted}" was interrupted`;
		}
		run.finished = run.execute();
		return run;
	}

	/**
	 * Run a failed or stopped run again from where it stopped: its failed
	 * nodes and the ones never reached run; what finished keeps its output.
	 */
	static resume(options: PipelineRunOptions & { run: string }): PipelineRun {
		const run = PipelineRun.load(options);
		if (!run)
			throw new Error(`no run "${options.run}" in ${options.journalDir}`);
		const fold = foldJournal(readJournal(run.journalPath));
		if (fold.status === "done")
			throw new Error(`run "${options.run}" finished; start a new one`);
		if (fold.status === "running" || fold.status === "waiting") {
			throw new Error(`run "${options.run}" is still running`);
		}
		for (const [id, state] of run.states) {
			if (state.status === "failed" || state.status === "running") {
				state.status = "pending";
				delete state.error;
				run.boardUpdate(id, { status: "pending", note: "resumed" });
			}
		}
		run.write({ t: "resume", ts: run.now() });
		run.reopenConversationTask();
		run.finished = run.execute();
		return run;
	}

	private static load(
		options: PipelineRunOptions & { run: string },
	): PipelineRun | undefined {
		const run = new PipelineRun(options, options.run);
		const events = readJournal(run.journalPath);
		const fold = foldJournal(events);
		if (!fold.run) return undefined;
		run.inputs = fold.run.inputs;
		run.conversationTask = fold.run.task;
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

	private openConversationTask(): void {
		const store = this.options.board;
		if (!store) return;
		const holder = pipelineHolder(this.id);
		const number = /-(\d+)$/.exec(this.id)?.[1] ?? "";
		const outcome = store.plan(
			{
				tasks: [
					{
						title: `▶ ${this.definition.name} #${number}`,
						description: `Pipeline run ${this.id}${this.definition.description ? `: ${this.definition.description}` : ""}. It runs on its own; a task that needs its result can wait on it with the gate pipeline:${this.id}.`,
					},
				],
			},
			{ by: holder },
			{ autoStart: false },
		);
		const id = /Created \d+: (T[\d.]+)/.exec(outcome.lines[0] ?? "")?.[1];
		if (!id) return;
		this.conversationTask = id;
		store.setPipelineLive(holder, true);
		store.update({ updates: [{ id, status: "active" }] }, { by: holder });
	}

	private reopenConversationTask(): void {
		const store = this.options.board;
		const id = this.conversationTask;
		if (!store || !id) return;
		const holder = pipelineHolder(this.id);
		store.setPipelineLive(holder, true);
		store.update(
			{ updates: [{ id, status: "active", note: "the run resumed" }] },
			{ by: holder },
		);
	}

	private closeConversationTask(
		result: Omit<PipelineRunResult, "boardLines">,
	): string[] {
		const store = this.options.board;
		if (!store) return [];
		const holder = pipelineHolder(this.id);
		const lines: string[] = [];
		const id = this.conversationTask;
		if (id) {
			const counts = this.counts();
			const note =
				result.status === "done"
					? `${counts.done} node${counts.done === 1 ? "" : "s"} done${counts.skipped ? `, ${counts.skipped} skipped` : ""}`
					: `${result.status}${result.error ? `: ${result.error}` : ""}`;
			const status =
				result.status === "done"
					? "done"
					: result.status === "failed"
						? "cancelled"
						: "waiting";
			lines.push(
				...store.update({ updates: [{ id, status, note }] }, { by: holder })
					.lines,
			);
		}
		store.setPipelineLive(holder, false);
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
			if (!this.halted) {
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
		if (status !== "done") {
			// What was never reached says so on the run's board.
			for (const [id, state] of this.states) {
				if (state.status === "pending")
					this.boardUpdate(id, { note: `not reached: the run ${status}` });
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
		return { ...result, boardLines: this.closeConversationTask(result) };
	}

	private async launch(node: PipelineNode): Promise<void> {
		const state = this.states.get(node.id) as NodeState;
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
			const items = this.inputItems(node);
			const pinned = this.options.usePins === true && Array.isArray(node.pin);
			const output = pinned
				? { items: node.pin as unknown[], port: DEFAULT_PORT }
				: await this.runNode(node, items, {});
			state.status = "done";
			state.output = output;
			this.write({
				t: "end",
				ts: this.now(),
				node: node.id,
				output,
				...(pinned ? { pinned: true } : {}),
			});
			this.boardUpdate(node.id, { status: "done", note: summarize(output) });
		} catch (error) {
			const message = this.abort.signal.aborted
				? `stopped: ${this.error ?? "stopped"}`
				: (error as Error).message || String(error);
			this.markFailed(node.id, message);
			if (!this.halted) {
				this.halted = true;
				this.error = `node "${node.id}" failed: ${message}`;
			}
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
			default:
				throw new NodeFailure(
					`"${node.type}" nodes are not available in this version yet`,
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

	private counts(): {
		done: number;
		skipped: number;
		failed: number;
		total: number;
	} {
		let done = 0;
		let skipped = 0;
		let failed = 0;
		for (const state of this.states.values()) {
			if (state.status === "done") done++;
			else if (state.status === "skipped") skipped++;
			else if (state.status === "failed") failed++;
		}
		return { done, skipped, failed, total: this.states.size };
	}

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

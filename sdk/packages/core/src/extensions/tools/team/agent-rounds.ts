/**
 * Every delegation the lead makes, as a round it can come back to.
 *
 * A spawn call used to exist only as the tool call that made it: the lead
 * learned what its agents did when the call returned, and not before or after.
 * After the 75-agent swarm on 4.100.199 the lead's own evaluation named what
 * that cost -- it sat idle for the whole round, could not see why an agent
 * had stopped, and once its history was compacted it no longer had the tasks
 * it had given, so a failed agent could not be run again without rewriting
 * its task from memory.
 *
 * So each spawn call opens a round here: its id, every agent's original task,
 * sampler, iteration cap and check, where each one ran, what state it is in
 * and why it stopped, and its result. The round is the lead's handle for
 * `agents_status`, the controls (`requeue_agent`, `restart_agent`,
 * `resume_agent`, `retry_failed`), and `await_agents` for a round that runs in
 * the background.
 *
 * Two lifetimes, kept apart:
 *
 * - **The record** is plain data, persisted beside the session
 *   (`<session>.rounds.json`), so it survives the lead's compaction and a
 *   reload of the window. Agents that were running when the process went away
 *   come back as cancelled -- "interrupted" -- which is what `retry_failed`
 *   runs again.
 * - **The live state** -- the round's abort signal, its slots' promises, the
 *   runners that can start an agent -- belongs to this process and is never
 *   written.
 *
 * What an agent is doing reaches its record through the same progress
 * updates its chat row is drawn from (`emitUpdate`): placement, model, tokens,
 * speed, compactions, sampler, activity, and the `waiting` report of a wait on
 * infrastructure. Nothing here polls anything.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentToolContext } from "@cline/shared";
import { HARNESS_TAG } from "../../../runtime/turn-queue/harness-notes";
import type { CompactionCause } from "../../context/compaction-cause";
import type { AgentOracleResult } from "./agent-check";
import { type AwaitingLeadEvent, onAwaitingLead } from "./agent-iteration-cap";
import {
	buildSpawnBatchReport,
	failureClassOf,
	type SpawnBatchFailureClass,
} from "./batch-report";
import type { RealizedSpawnSampling, SpawnSampling } from "./spawn-sampling";
import {
	type SubagentStopActor,
	subagentCancellation,
} from "./subagent-cancellation";

/** Which tool opened the round, which decides how an agent is run again. */
export type RoundKind = "spawn_agent" | "swarm" | "configured";

/** Where one agent is. The lead's status tool counts rounds by these. */
export type AgentRunState =
	| "queued"
	| "running"
	| "waiting_infra"
	| "awaiting_lead"
	| "done"
	| "failed"
	| "cancelled";

/**
 * Why an agent stopped (ruling 6). Waiting on infrastructure is a state, not
 * a stop: an agent never fails on infrastructure.
 */
export type AgentStopReason =
	| "completed"
	/** Reached its iteration cap. */
	| "iteration_cap"
	/** The loop guard stopped it for sending the same call again. */
	| "looping"
	/** The struggle supervisor stopped it for grinding after its nudge. */
	| "struggling"
	/** Its context overflowed and could not be recovered. */
	| "context_overflow"
	/** Too many consecutive mistakes, or a loop guard ended it. */
	| "mistake_limit"
	/** The engine or the connection returned an error it could not retry. */
	| "engine_error"
	/** Its own run failed: a tool, the model, a bad request. */
	| "task_error"
	| "cancelled_by_lead"
	| "cancelled_by_user"
	/** The lead's turn or the session was stopped under it. */
	| "cancelled_by_session"
	/** The process went away while it ran (a reload). */
	| "interrupted";

export const LIVE_STATES: ReadonlySet<AgentRunState> = new Set([
	"queued",
	"running",
	"waiting_infra",
	"awaiting_lead",
]);

/** What a round's agent is waiting on, while it waits. */
export interface AgentWaitInfo {
	kind: "refusal" | "transport";
	/** The node or server. */
	where: string;
	/** The refusal's text, or why the server is gone. */
	detail: string;
	since: number;
}

/** The check's verdict on an agent's work (section E): `agent-check.ts`. */
export type { AgentOracleResult };

/** The check's verdict in a few words: `pass`, `FAIL (exit 1)`, `not run (why)`. */
export function oracleWords(oracle: AgentOracleResult): string {
	if (oracle.status === "not_run") {
		return `not run (${oracle.reason ?? "no command sandbox"})`;
	}
	if (oracle.status === "pass") {
		return "pass";
	}
	return oracle.exitCode === null ? "FAIL" : `FAIL (exit ${oracle.exitCode})`;
}

/** An agent as the lead asked for it: what `retry_failed` runs again. */
export interface RoundAgentSpec {
	name: string;
	task: string;
	/** Its role, when it differs from the round's. */
	instructions?: string;
	/** A configured agent to run it as. */
	type?: string;
	/** A swarm worker's own system prompt. */
	systemPrompt?: string;
	/** A swarm worker's tool list. */
	tools?: string[];
	/** The sampler as asked for, "random" and all. */
	sampling?: SpawnSampling;
	maxIterations?: number;
	/** The oracle, as asked for (section E). */
	check?: unknown;
}

export interface ActivityLine {
	at: number;
	text: string;
	severity?: "warn";
}

export interface AgentErrorLine {
	at: number;
	class: SpawnBatchFailureClass;
	text: string;
}

export interface RoundAgentRecord extends RoundAgentSpec {
	/** `r<round>-<n>`, what the lead's controls take. */
	id: string;
	index: number;
	state: AgentRunState;
	stopReason?: AgentStopReason;
	/** A line on the stop: the error, the abort's reason. */
	stopDetail?: string;
	/**
	 * While it waits on the lead: its cap, a loop the guard stopped, or a
	 * grind the struggle supervisor stopped.
	 */
	awaitingReason?: "iteration_cap" | "looping" | "struggling";
	queuedAt: number;
	startedAt?: number;
	endedAt?: number;
	nodeId?: string;
	nodeLabel?: string;
	providerId?: string;
	modelId?: string;
	contextWindow?: number;
	inputTokens?: number;
	outputTokens?: number;
	contextTokens?: number;
	/** Recent generation speed, tokens per second. */
	genTps?: number;
	iterations?: number;
	toolCalls?: number;
	compactions?: number;
	compactionsByCause?: Partial<Record<CompactionCause, number>>;
	/** The sampler it actually ran with. */
	samplingUsed?: RealizedSpawnSampling;
	oracle?: AgentOracleResult;
	/** The last thing it wrote while running, or the tail of its report. */
	outputTail?: string;
	/** Its report, bounded: the summary the lead was handed. */
	result?: string;
	activity: ActivityLine[];
	errors: AgentErrorLine[];
	waiting?: AgentWaitInfo;
	/** Runs of it: 1, plus one per restart or retry. */
	attempts: number;
	/** Times the lead requeued it. */
	requeues: number;
	/** What the lead added to its task on a restart, kept for a retry. */
	revisedInstructions?: string;
}

/** What a round shares across its agents, for a retry after compaction. */
export interface RoundShared {
	knowledge?: { files?: string[]; text?: string };
	instructions?: string;
	systemPrompt?: string;
	sampling?: SpawnSampling;
	maxIterations?: number;
	check?: unknown;
}

export interface RoundRecord {
	/** `r<n>`, unique in the session. */
	id: string;
	kind: RoundKind;
	/** The tool the lead called. */
	tool: string;
	toolCallId?: string;
	createdAt: number;
	endedAt?: number;
	/** Runs beside the lead (`wait: false`); its report arrives on its own. */
	background: boolean;
	status: "running" | "done";
	shared: RoundShared;
	agents: RoundAgentRecord[];
	/** The report has reached the lead: returned, awaited, or delivered. */
	delivered: boolean;
	/** A swarm's merged report, as its call returned it. */
	digest?: string;
	/**
	 * Each agent has its own row under the call, keyed `<call>#<index>`; a
	 * round without it is one row, keyed by the call. Where a rerun's updates
	 * go, after the call is gone.
	 */
	rowed?: boolean;
}

/**
 * Where a rerun's updates belong, when the call that drew the agent's row is
 * gone: the control call carries them, tagged with the row -- the original
 * call and, for a rowed round, the agent's index.
 */
export interface RoundRowTarget {
	toolCallId: string;
	member?: number;
}

/**
 * What one agent of a round came back with. The spawn paths' own output
 * shapes all fit it: a single agent's, a batch member's, a swarm worker's.
 */
export interface RoundMemberOutput {
	name?: string;
	text?: string;
	iterations?: number;
	finishReason?: string;
	usage?: { inputTokens?: number; outputTokens?: number };
	error?: string;
	model?: { id: string; provider: string };
	nodeId?: string;
	nodeLabel?: string;
	sampling?: RealizedSpawnSampling;
	/** `awaiting_lead`: returned while it waits at its cap, work kept. */
	state?: string;
	/** `iteration_cap` when the cap ended it. */
	stopReason?: string;
	maxIterations?: number;
	/** The check's verdict, when one was set. */
	oracle?: AgentOracleResult;
	/** Its runtime's id: what a detached agent's later events name it by. */
	agentId?: string;
}

/**
 * Runs one agent of a round again, from its stored spec: what makes
 * `retry_failed` and a restart of a finished agent possible after the
 * original call is long gone.
 */
export type RoundRunner = (input: {
	round: RoundRecord;
	agent: RoundAgentRecord;
	/** Its task as it should run now: the original, plus revised instructions. */
	task: string;
	context: AgentToolContext;
}) => Promise<RoundMemberOutput>;

/** A report the lead has not seen, for the host to deliver. */
export interface SettledRound {
	record: RoundRecord;
	/** What the lead is handed: the round's report, bounded. */
	report: string;
}

/**
 * A settled round as the lead reads it when it was not waiting for it: a
 * background round, or an agent that finished after its call returned. It
 * arrives at the lead's next boundary, the way a background delegation's
 * report does, so it says what it is before it says what happened.
 */
export function renderRoundNotice(settled: SettledRound): string {
	const round = settled.record;
	// Ended under it by the session going away: a reload of the window, or
	// the task closed. Its agents are gone, and the lead has to be told the
	// one thing it can do about that.
	const interrupted = round.agents.filter(
		(agent) => agent.stopReason === "interrupted",
	);
	if (interrupted.length > 0) {
		const names = interrupted
			.map((agent) => `${agent.id} ${agent.name}`)
			.join(", ");
		const count =
			interrupted.length === round.agents.length
				? interrupted.length === 1
					? "its agent was"
					: `all ${interrupted.length} of its agents were`
				: `${interrupted.length} of its ${round.agents.length} agents were`;
		return `${HARNESS_TAG} Round ${round.id} interrupted: the session ended while ${round.tool} ran (window reloaded or task closed); ${count} stopped, work in progress lost: ${names}. retry_failed(round_id: "${round.id}") reruns them from their tasks; restart_agent reruns one with new instructions. Report so far:\n\n${settled.report}`;
	}
	const how = round.background
		? `background ${round.tool}`
		: `an agent of ${round.tool} ended after its call returned`;
	return `${HARNESS_TAG} Round ${round.id} finished (${how}). Report:\n\n${settled.report}`;
}

/**
 * The lead's completion, held while a round it did not wait for is still
 * out: a background round, or an agent detached at its cap. Its report would
 * otherwise arrive into a finished task. No wall clock: the round ends when
 * its agents do, or when the lead stops them.
 */
export function roundsCompletionGuard(
	sessionId: string,
): () => string | undefined {
	return () => {
		const running = roundsFor(sessionId)
			.list()
			.filter((round) => round.status === "running");
		if (running.length === 0) {
			return undefined;
		}
		const names = running
			.map(
				(round) =>
					`${round.id} (${round.tool}, ${round.agents.length} agent${
						round.agents.length === 1 ? "" : "s"
					})`,
			)
			.join(", ");
		return `${HARNESS_TAG} Still running: ${names}. ${
			running.length === 1 ? "Its report comes" : "Their reports come"
		} when it ends; await_agents to wait, or stop_agents, before you finish.`;
	};
}

/** Longest output tail kept per agent (spec B: "e.g. 1,500 chars"). */
export const ROUND_OUTPUT_TAIL_CHARS = 1_500;
/** Activity lines kept per agent. */
export const ROUND_ACTIVITY_LIMIT = 20;
const ROUND_ERROR_LIMIT = 5;
const PERSIST_DEBOUNCE_MS = 1_000;

function tail(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length > max
		? `…${trimmed.slice(trimmed.length - max + 1)}`
		: trimmed;
}

const LOOP_GUARD = /\bloop guard\b|repeated-call|struggle supervisor/i;

const OVERFLOW =
	/context (?:length|window|size)|context overflow|too many tokens|exceeds? (?:the )?(?:maximum )?context|prompt is too long|maximum context/i;

/**
 * The state and stop reason one finished run comes to.
 *
 * `stoppedBy` is who stopped it, when someone did; `sessionAborted` whether
 * the lead's turn or the session was stopped under it.
 */
export function classifyAgentEnd(
	outcome: RoundMemberOutput | { thrown: unknown },
	stoppedBy: SubagentStopActor | undefined,
	sessionAborted: boolean,
): { state: AgentRunState; reason: AgentStopReason; detail?: string } {
	const cancelled = (detail?: string) => ({
		state: "cancelled" as const,
		reason:
			stoppedBy === "lead"
				? ("cancelled_by_lead" as const)
				: stoppedBy === "user"
					? ("cancelled_by_user" as const)
					: ("cancelled_by_session" as const),
		...(detail ? { detail } : {}),
	});
	// The runtime's own guard ends a run with an abort; nobody cancelled it
	// (9 agents of swarm 0926 read as cancelled by the lead).
	const guard = (detail: string) => ({
		state: "failed" as const,
		reason: "mistake_limit" as const,
		detail: detail.slice(0, 300),
	});
	if ("thrown" in outcome) {
		const message =
			outcome.thrown instanceof Error
				? outcome.thrown.message
				: String(outcome.thrown);
		if (!stoppedBy && LOOP_GUARD.test(message)) {
			return guard(message);
		}
		const abortLike =
			(outcome.thrown as { name?: unknown } | null)?.name === "AbortError" ||
			/\babort|cancel|stopped\b/i.test(message);
		if (stoppedBy || (abortLike && sessionAborted)) {
			return cancelled(message);
		}
		return failedWith(message, undefined);
	}
	if (outcome.error !== undefined && outcome.finishReason === undefined) {
		if (!stoppedBy && LOOP_GUARD.test(outcome.error)) {
			return guard(outcome.error);
		}
		if (
			stoppedBy ||
			(sessionAborted && /\babort|cancel|stopped\b/i.test(outcome.error))
		) {
			return cancelled(outcome.error);
		}
		if (/stopped before it started|never started/i.test(outcome.error)) {
			return cancelled(outcome.error);
		}
		return failedWith(outcome.error, undefined);
	}
	switch (outcome.finishReason) {
		case "completed":
			return { state: "done", reason: "completed" };
		case "aborted":
			// Stopped by nobody outside it: its own guard (a loop, a grind the
			// struggle supervisor pulled), which is a failure of the task.
			if (!stoppedBy && !sessionAborted) {
				return guard(outcome.text?.trim() || "stopped by its own guard");
			}
			return cancelled(outcome.text?.trim().slice(0, 200));
		case "max_iterations":
			return { state: "failed", reason: "iteration_cap" };
		case "mistake_limit":
			return {
				state: "failed",
				reason: "mistake_limit",
				...(outcome.text ? { detail: outcome.text.slice(0, 200) } : {}),
			};
		default:
			return failedWith(outcome.text ?? "", outcome.finishReason);
	}
}

function failedWith(
	text: string,
	finishReason: string | undefined,
): { state: AgentRunState; reason: AgentStopReason; detail?: string } {
	const first = text.trim().split("\n")[0] ?? "";
	const detail = first.slice(0, 300) || undefined;
	if (OVERFLOW.test(first)) {
		return { state: "failed", reason: "context_overflow", detail };
	}
	const failureClass = failureClassOf({
		name: "",
		...(finishReason ? { finishReason } : { error: text || "failed" }),
		text,
	});
	return {
		state: "failed",
		reason: failureClass === "infra" ? "engine_error" : "task_error",
		...(detail ? { detail } : {}),
	};
}

/** The task an agent runs now: its own, with the lead's revision after it. */
export function taskWithRevision(agent: RoundAgentRecord): string {
	return agent.revisedInstructions
		? `${agent.task}\n\n# Revised instructions from the lead\n\n${agent.revisedInstructions}`
		: agent.task;
}

interface LiveRound {
	record: RoundRecord;
	controller: AbortController;
	/** Each agent's current run, when it has one. */
	slots: Map<number, Promise<RoundMemberOutput>>;
	/** Each agent's latest output, for the round's report. */
	outputs: Map<number, RoundMemberOutput>;
	/** Each agent's live control id. */
	cancelIds: Map<number, string>;
	/** Each agent's channel to its row, kept for news after its call returned. */
	rows?: Map<number, (update: unknown) => void>;
	/** Where the original call's progress went, while it is still open. */
	emitUpdate?: (update: unknown) => void;
	/** Tags an update with its agent, as the call's rows expect. */
	rowed: boolean;
	idleWaiters: Array<() => void>;
	/**
	 * Held open by the call that opened it while it is still launching agents:
	 * a swarm launches over time, and a round whose first worker finished
	 * before the second started is not a finished round.
	 */
	holds: number;
	/** Callers inside `await_agents` for it: its report goes to them. */
	awaited: number;
	/** Lets go of the lead's turn signal, for a blocking round detached. */
	unlinkTurn?: () => void;
	/** Reruns started, for unique tool-call ids. */
	reruns: number;
	/** A report from the call itself, in place of one built from results. */
	reportOverride?: string;
}

export interface OpenRoundInput {
	kind: RoundKind;
	tool: string;
	toolCallId?: string;
	background: boolean;
	shared?: RoundShared;
	agents: RoundAgentSpec[];
	/**
	 * The lead's call signal, for a blocking round: stopping the lead's turn
	 * stops the round. A background round is not tied to the turn it started
	 * in, and runs until it ends, is stopped, or the session goes.
	 */
	signal?: AbortSignal;
	/** The call's own progress channel, for its rows. */
	emitUpdate?: (update: unknown) => void;
	/** Each agent has its own row, keyed by `member`. */
	rowed?: boolean;
}

type SettledListener = (settled: SettledRound) => void;

/** Renders a finished round's report for the lead. Set by the tools. */
export type RoundReportRenderer = (
	record: RoundRecord,
	outputs: ReadonlyMap<number, RoundMemberOutput>,
	sessionId: string | undefined,
) => string;

export class AgentRounds {
	private readonly rounds = new Map<string, RoundRecord>();
	private readonly live = new Map<string, LiveRound>();
	private readonly runners = new Map<RoundKind, RoundRunner>();
	private readonly listeners = new Set<SettledListener>();
	private persistTimer: ReturnType<typeof setTimeout> | undefined;
	private path: string | undefined;
	private blocking = 0;
	private renderReport: RoundReportRenderer = defaultRoundReport;

	constructor(
		readonly sessionId: string,
		private readonly now: () => number = Date.now,
	) {}

	/**
	 * Persist to `path`, loading what is there first. Agents recorded as live
	 * were running when the process went away: they are cancelled now, as
	 * `interrupted`, which `retry_failed` runs again.
	 */
	attachStore(path: string): void {
		this.path = path;
		let loaded: RoundRecord[] = [];
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as {
				version?: number;
				rounds?: RoundRecord[];
			};
			if (parsed?.version === 1 && Array.isArray(parsed.rounds)) {
				loaded = parsed.rounds;
			}
		} catch {
			// No file yet, or one that does not parse: nothing to restore.
		}
		let changed = false;
		for (const round of loaded) {
			if (this.rounds.has(round.id)) {
				continue;
			}
			for (const agent of round.agents ?? []) {
				agent.activity ??= [];
				agent.errors ??= [];
			}
			// Written while it ran by a process that did not end it -- a
			// crash: nothing of it runs now either.
			changed = this.interruptRound(round) || changed;
			this.rounds.set(round.id, round);
		}
		if (changed) {
			this.schedulePersist();
		}
	}

	/**
	 * The session is going with rounds still out: a reload of the window, or
	 * the task closed. Their agents are about to be stopped, and whatever they
	 * would report on the way out is not what the record keeps: each is
	 * `interrupted` now, its round is over with a report owed to the lead, and
	 * that is what is written. Nothing is written after it -- the late ends of
	 * the agents being stopped would otherwise land a second later as
	 * "cancelled by the session", or not at all if the process is gone by
	 * then. The next start of the session delivers the notice.
	 */
	interruptAll(): void {
		for (const round of this.rounds.values()) {
			this.interruptRound(round);
		}
		this.flush();
		this.path = undefined;
	}

	private interruptRound(round: RoundRecord): boolean {
		return markRoundInterrupted(round, this.now());
	}

	/** Write now, and stop writing: the session is going. */
	flush(): void {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = undefined;
		}
		this.writeNow();
	}

	/** Stop every live round; the session is ending. */
	stopAll(reason = "The session ended."): void {
		for (const live of this.live.values()) {
			live.controller.abort(new DOMException(reason, "AbortError"));
		}
	}

	setReportRenderer(renderer: RoundReportRenderer): void {
		this.renderReport = renderer;
	}

	registerRunner(kind: RoundKind, runner: RoundRunner): void {
		this.runners.set(kind, runner);
	}

	hasRunner(kind: RoundKind): boolean {
		return this.runners.has(kind);
	}

	/** Told once per settle of a round whose report the lead has not had. */
	onSettled(listener: SettledListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * The lead is inside a call that waits on its agents: a blocking spawn, or
	 * `await_agents`. A user's steer is then answered in a side turn; with the
	 * lead working beside a background round it goes to the lead as usual.
	 */
	enterBlocking(): () => void {
		this.blocking += 1;
		let left = false;
		return () => {
			if (!left) {
				left = true;
				this.blocking -= 1;
			}
		};
	}

	get leadBlocked(): boolean {
		return this.blocking > 0;
	}

	/**
	 * The lead's waits on its agents in progress -- `await_agents`, a blocking
	 * spawn -- each ended by {@link wakeAwaits}.
	 */
	private readonly wakers = new Set<() => void>();

	/**
	 * `work`, or a message for the lead, whichever comes first. A blocking
	 * spawn waits here: measured 2026-09-26, a `wait: true` spawn of 50
	 * agents held the lead for the whole round while the user's steers went
	 * to side turns and their results queued behind it.
	 */
	async untilWoken<T>(
		work: Promise<T>,
	): Promise<{ woken: false; value: T } | { woken: true }> {
		let off = () => {};
		const woken = new Promise<{ woken: true }>((resolve) => {
			off = this.onWake(() => resolve({ woken: true }));
		});
		try {
			return await Promise.race([
				work.then((value) => ({ woken: false as const, value })),
				woken,
			]);
		} finally {
			off();
		}
	}

	/** Register a wait on the agents that a message for the lead ends. */
	onWake(wake: () => void): () => void {
		this.wakers.add(wake);
		return () => {
			this.wakers.delete(wake);
		};
	}

	/**
	 * The lead is waiting on its agents (`await_agents`, a blocking spawn):
	 * a message for it should end the wait rather than sit behind the round.
	 */
	get leadAwaiting(): boolean {
		return this.wakers.size > 0;
	}

	/**
	 * Something is waiting for the lead -- the user's message, the harness's
	 * report of a stuck agent. Its `await_agents` returns now, so the message
	 * reaches it at the turn boundary right after; the rounds carry on.
	 * Returns whether a wait was ended.
	 */
	wakeAwaits(): boolean {
		if (this.wakers.size === 0) {
			return false;
		}
		for (const wake of [...this.wakers]) {
			wake();
		}
		return true;
	}

	list(): RoundRecord[] {
		return [...this.rounds.values()];
	}

	get(roundId: string): RoundRecord | undefined {
		return this.rounds.get(roundId.trim());
	}

	/** Rounds still running in the background whose report is not yet in. */
	pendingBackground(): RoundRecord[] {
		return this.list().filter(
			(round) => round.background && round.status === "running",
		);
	}

	/**
	 * An agent by id (`r2-3`) or by name. A name used in several rounds means
	 * the newest round's agent of that name.
	 */
	findAgent(
		ref: string,
	): { round: RoundRecord; agent: RoundAgentRecord } | undefined {
		const wanted = ref.trim();
		if (!wanted) {
			return undefined;
		}
		const rounds = this.list().reverse();
		for (const round of rounds) {
			const agent = round.agents.find((entry) => entry.id === wanted);
			if (agent) {
				return { round, agent };
			}
		}
		const lower = wanted.toLowerCase();
		for (const round of rounds) {
			const agent = round.agents.find(
				(entry) => entry.name.toLowerCase() === lower,
			);
			if (agent) {
				return { round, agent };
			}
		}
		return undefined;
	}

	/** The live control id of an agent that is running now. */
	cancelIdOf(roundId: string, index: number): string | undefined {
		return this.live.get(roundId)?.cancelIds.get(index);
	}

	isLive(roundId: string): boolean {
		return this.live.has(roundId);
	}

	/** The round's signal, while it is live in this process. */
	signalOf(roundId: string): AbortSignal | undefined {
		return this.live.get(roundId)?.controller.signal;
	}

	open(input: OpenRoundInput): RoundHandle {
		const id = `r${this.nextRoundNumber()}`;
		const at = this.now();
		const record: RoundRecord = {
			id,
			kind: input.kind,
			tool: input.tool,
			...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
			createdAt: at,
			background: input.background,
			status: "running",
			shared: input.shared ?? {},
			agents: input.agents.map((spec, index) =>
				this.newAgent(id, index, spec, at),
			),
			delivered: false,
			...(input.rowed ? { rowed: true } : {}),
		};
		const controller = new AbortController();
		const signal = input.signal;
		let unlinkTurn: (() => void) | undefined;
		if (signal) {
			const onAbort = () => controller.abort(signal.reason);
			if (signal.aborted) {
				controller.abort(signal.reason);
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
				unlinkTurn = () => signal.removeEventListener("abort", onAbort);
				// A blocking round lets go of the turn's signal once it returns.
				controller.signal.addEventListener("abort", unlinkTurn, {
					once: true,
				});
			}
		}
		const live: LiveRound = {
			record,
			controller,
			slots: new Map(),
			outputs: new Map(),
			cancelIds: new Map(),
			...(input.emitUpdate ? { emitUpdate: input.emitUpdate } : {}),
			rowed: input.rowed ?? false,
			idleWaiters: [],
			holds: 1,
			awaited: 0,
			reruns: 0,
			...(unlinkTurn ? { unlinkTurn } : {}),
		};
		this.rounds.set(id, record);
		this.live.set(id, live);
		this.schedulePersist();
		return new RoundHandle(this, live);
	}

	/** Add an agent to a live round: a swarm's `max` finds its size as it goes. */
	addAgent(roundId: string, spec: RoundAgentSpec): RoundAgentRecord {
		const round = this.rounds.get(roundId);
		if (!round) {
			throw new Error(`No round ${roundId}.`);
		}
		const agent = this.newAgent(roundId, round.agents.length, spec, this.now());
		round.agents.push(agent);
		this.schedulePersist();
		return agent;
	}

	/**
	 * Run one agent of the round again, from its stored spec. For a restart of
	 * an agent that has finished, and for `retry_failed`. The round reopens,
	 * and its report goes to the lead again when it is done.
	 *
	 * `context` is the control call's: a rerun borrows its session and parent,
	 * never its signal -- it runs under the round's.
	 */
	rerun(
		roundId: string,
		index: number,
		context: AgentToolContext,
		options?: { instructions?: string },
	): { started: boolean; why?: string } {
		const round = this.rounds.get(roundId);
		const agent = round?.agents[index];
		if (!round || !agent) {
			return { started: false, why: "no such agent" };
		}
		if (LIVE_STATES.has(agent.state)) {
			return { started: false, why: `it is ${agent.state}` };
		}
		const runner = this.runners.get(round.kind);
		if (!runner) {
			return {
				started: false,
				why: `this session cannot run ${round.tool} agents again (the tool is not available)`,
			};
		}
		let live = this.live.get(roundId);
		if (!live) {
			// Reopened after its call returned, or after a reload.
			live = {
				record: round,
				controller: new AbortController(),
				slots: new Map(),
				outputs: new Map(),
				cancelIds: new Map(),
				rowed: round.rowed === true,
				idleWaiters: [],
				holds: 0,
				awaited: 0,
				reruns: 0,
			};
			this.live.set(roundId, live);
		}
		if (options?.instructions?.trim()) {
			agent.revisedInstructions = options.instructions.trim();
		}
		live.reruns += 1;
		round.status = "running";
		round.endedAt = undefined;
		round.delivered = false;
		// The report for this settle is built from the agents' results; a
		// swarm's digest described the round as it first ended.
		live.reportOverride = undefined;
		this.resetForRun(agent);
		agent.attempts += 1;
		const handle = new RoundHandle(this, live);
		const base = round.toolCallId ?? `${round.id}`;
		// Its row: through the call while the call is open; once it is gone,
		// through the control call, each update tagged with the row it is for.
		// The control call's own channel, untagged, drew it on the control
		// call's row -- or nowhere -- and the agent's row kept its last end.
		const target: RoundRowTarget | undefined = round.toolCallId
			? {
					toolCallId: round.toolCallId,
					...(live.rowed ? { member: index } : {}),
				}
			: undefined;
		const control = context.emitUpdate;
		const toRow = live.emitUpdate
			? live.rowed
				? (update: unknown) =>
						live.emitUpdate?.({
							...(update as Record<string, unknown>),
							member: index,
						})
				: (update: unknown) => live.emitUpdate?.(update)
			: target && control
				? (update: unknown) =>
						control({
							...(update as Record<string, unknown>),
							roundRow: target,
						})
				: undefined;
		// The row starts over: running again, its last end cleared.
		toRow?.({ rerun: { attempt: agent.attempts } });
		const rerunContext: AgentToolContext = {
			...context,
			toolCallId: `${base}#${index}~${live.reruns}`,
			signal: live.controller.signal,
			metadata: { ...(context.metadata ?? {}), [ROUND_MEMBER_KEY]: true },
		};
		if (!live.emitUpdate) {
			if (toRow) {
				rerunContext.emitUpdate = toRow;
			} else {
				delete rerunContext.emitUpdate;
			}
		}
		void handle
			.run(index, rerunContext, (memberContext) =>
				runner({
					round,
					agent,
					task: taskWithRevision(agent),
					context: memberContext,
				}),
			)
			.then((output) => {
				// Its new end, on its row -- unless it returned waiting for the
				// lead, which its own update already drew there.
				if (output.state !== "awaiting_lead") {
					toRow?.({ finished: output });
				}
			});
		return { started: true };
	}

	/** Wait for these rounds -- or every running one -- to finish. */
	async waitFor(
		roundIds: readonly string[] | undefined,
		signal?: AbortSignal,
	): Promise<RoundRecord[]> {
		const ids =
			roundIds && roundIds.length > 0
				? roundIds
				: this.list()
						.filter((round) => round.status === "running")
						.map((round) => round.id);
		const waiting: LiveRound[] = [];
		const waits = ids.map((id) => {
			const live = this.live.get(id);
			if (!live || live.record.status === "done") {
				return Promise.resolve();
			}
			live.awaited += 1;
			waiting.push(live);
			return new Promise<void>((resolve) => {
				live.idleWaiters.push(resolve);
			});
		});
		const all = Promise.all(waits);
		try {
			if (signal) {
				await Promise.race([
					all,
					new Promise<void>((_resolve, reject) => {
						if (signal.aborted) {
							reject(signal.reason);
							return;
						}
						signal.addEventListener("abort", () => reject(signal.reason), {
							once: true,
						});
					}),
				]);
			} else {
				await all;
			}
		} finally {
			for (const live of waiting) {
				live.awaited -= 1;
			}
		}
		return ids
			.map((id) => this.rounds.get(id))
			.filter((round): round is RoundRecord => round !== undefined);
	}

	/** The report of a finished round, as the lead reads it. */
	reportFor(roundId: string): string {
		const round = this.rounds.get(roundId);
		if (!round) {
			return `No round ${roundId}.`;
		}
		const live = this.live.get(roundId);
		if (live?.reportOverride) {
			return live.reportOverride;
		}
		if (round.digest && !live) {
			return round.digest;
		}
		return this.renderReport(
			round,
			live?.outputs ?? new Map(),
			this.sessionId || undefined,
		);
	}

	markDelivered(roundId: string): void {
		const round = this.rounds.get(roundId);
		if (round && !round.delivered) {
			round.delivered = true;
			this.schedulePersist();
		}
	}

	// ---------------------------------------------------------------------
	// Internal: what a handle reports
	// ---------------------------------------------------------------------

	/** @internal */
	schedulePersist(): void {
		if (!this.path || this.persistTimer) {
			return;
		}
		this.persistTimer = setTimeout(() => {
			this.persistTimer = undefined;
			this.writeNow();
		}, PERSIST_DEBOUNCE_MS);
		(this.persistTimer as unknown as { unref?: () => void }).unref?.();
	}

	/** @internal */
	settleIfIdle(live: LiveRound): void {
		if (
			live.slots.size > 0 ||
			live.holds > 0 ||
			live.record.status === "done"
		) {
			return;
		}
		const round = live.record;
		round.status = "done";
		round.endedAt = this.now();
		// Someone is inside `await_agents` for it: the report is theirs.
		if (live.awaited > 0) {
			round.delivered = true;
		}
		this.schedulePersist();
		const waiters = live.idleWaiters.splice(0);
		for (const resolve of waiters) {
			resolve();
		}
		if (!round.delivered && this.listeners.size > 0) {
			const settled: SettledRound = {
				record: round,
				report: this.reportFor(round.id),
			};
			for (const listener of this.listeners) {
				try {
					listener(settled);
				} catch {
					// Delivery is the host's business; a failure there is not
					// the round's.
				}
			}
		}
	}

	/** @internal */
	resetForRun(agent: RoundAgentRecord): void {
		agent.state = "queued";
		agent.stopReason = undefined;
		agent.stopDetail = undefined;
		agent.queuedAt = this.now();
		agent.startedAt = undefined;
		agent.endedAt = undefined;
		agent.waiting = undefined;
		agent.oracle = undefined;
		agent.result = undefined;
		agent.outputTail = undefined;
		agent.iterations = undefined;
		agent.toolCalls = undefined;
		agent.inputTokens = undefined;
		agent.outputTokens = undefined;
		agent.contextTokens = undefined;
		agent.genTps = undefined;
		agent.compactions = undefined;
		agent.compactionsByCause = undefined;
	}

	/** @internal */
	now_(): number {
		return this.now();
	}

	private newAgent(
		roundId: string,
		index: number,
		spec: RoundAgentSpec,
		at: number,
	): RoundAgentRecord {
		return {
			...spec,
			id: `${roundId}-${index + 1}`,
			index,
			state: "queued",
			queuedAt: at,
			activity: [],
			errors: [],
			attempts: 1,
			requeues: 0,
		};
	}

	private nextRoundNumber(): number {
		let max = 0;
		for (const id of this.rounds.keys()) {
			const n = Number(id.replace(/^r/, ""));
			if (Number.isFinite(n) && n > max) {
				max = n;
			}
		}
		return max + 1;
	}

	private writeNow(): void {
		if (!this.path) {
			return;
		}
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			const temp = `${this.path}.${randomUUID().slice(0, 8)}.tmp`;
			writeFileSync(
				temp,
				JSON.stringify({ version: 1, rounds: this.list() }),
				"utf8",
			);
			renameSync(temp, this.path);
		} catch {
			// A status record that could not be written is not a reason to
			// disturb the agents it describes.
		}
	}
}

/** Marks a tool context as one agent of a round already open. */
export const ROUND_MEMBER_KEY = "cerebrilineRoundMember";

/** Whether a tool call runs as a member of a round a caller already opened. */
export function isRoundMember(context: AgentToolContext | undefined): boolean {
	return context?.metadata?.[ROUND_MEMBER_KEY] === true;
}

/** One open round, as the tool that opened it drives it. */
export class RoundHandle {
	constructor(
		private readonly rounds: AgentRounds,
		private readonly live: LiveRound,
	) {}

	get id(): string {
		return this.live.record.id;
	}

	get record(): RoundRecord {
		return this.live.record;
	}

	/** The round's own stop: the lead's turn for a blocking round. */
	get signal(): AbortSignal {
		return this.live.controller.signal;
	}

	agent(index: number): RoundAgentRecord | undefined {
		return this.live.record.agents[index];
	}

	/** The control id agent `index` is stopped, requeued and messaged by. */
	bindControl(index: number, cancelId: string): void {
		this.live.cancelIds.set(index, cancelId);
	}

	/** Grow the round by one agent; returns its index. */
	add(spec: RoundAgentSpec): number {
		return this.rounds.addAgent(this.id, spec).index;
	}

	/**
	 * Run agent `index` under `context`, recording what it does and how it
	 * ends. The context handed to `fn` taps the agent's progress updates on
	 * their way to its row. Never throws: a failed agent is an output with an
	 * `error`, as a batch member's always was.
	 */
	async run(
		index: number,
		context: AgentToolContext,
		fn: (context: AgentToolContext) => Promise<RoundMemberOutput>,
	): Promise<RoundMemberOutput> {
		const agent = this.live.record.agents[index];
		if (!agent) {
			throw new Error(`Round ${this.id} has no agent ${index + 1}.`);
		}
		const promise = this.runAgent(index, agent, context, fn);
		this.live.slots.set(index, promise);
		try {
			return await promise;
		} finally {
			if (this.live.slots.get(index) === promise) {
				this.live.slots.delete(index);
			}
			this.rounds.settleIfIdle(this.live);
		}
	}

	/**
	 * Record an agent that never ran: stopped or left in the queue when the
	 * round ended.
	 */
	never(index: number, why: string): void {
		const agent = this.live.record.agents[index];
		if (!agent || !LIVE_STATES.has(agent.state)) {
			return;
		}
		const output: RoundMemberOutput = { name: agent.name, error: why };
		this.live.outputs.set(index, output);
		this.finish(agent, output, undefined, why);
	}

	/** Resolves when no agent of the round is running. */
	idle(): Promise<void> {
		if (this.live.slots.size === 0) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			const check = async () => {
				while (this.live.slots.size > 0) {
					await Promise.allSettled([...this.live.slots.values()]);
				}
				resolve();
			};
			void check();
		});
	}

	/** The latest output of every agent, in order. */
	outputs(): RoundMemberOutput[] {
		return this.live.record.agents.map(
			(agent, index) =>
				this.live.outputs.get(index) ?? {
					name: agent.name,
					error: "never started",
				},
		);
	}

	/** A report from the call itself -- a swarm's digest -- for this settle. */
	setReport(report: string, digest?: string): void {
		this.live.reportOverride = report;
		if (digest !== undefined) {
			this.live.record.digest = digest;
		}
	}

	/**
	 * The call is returning its report to the lead itself: nothing to deliver.
	 * Also lets go of the call's progress channel, which is closed once the
	 * call returns.
	 */
	delivered(): void {
		this.rounds.markDelivered(this.id);
		this.live.emitUpdate = undefined;
	}

	/**
	 * A blocking round whose call returns before it ends: a message for the
	 * lead woke it. The round goes on in the background, no longer stopped by
	 * the turn's signal, and its report is delivered when it ends.
	 */
	detach(): void {
		this.live.record.background = true;
		this.live.unlinkTurn?.();
		this.live.unlinkTurn = undefined;
		this.rounds.schedulePersist();
	}

	/**
	 * The opening call has launched everything it will: the round settles
	 * once its last agent ends (now, if none runs). Idempotent.
	 */
	close(): void {
		if (this.live.holds > 0) {
			this.live.holds -= 1;
		}
		this.rounds.settleIfIdle(this.live);
	}

	/** Where agent `index`'s updates go: its record, then its row. */
	private tap(
		index: number,
		agent: RoundAgentRecord,
		forward: ((update: unknown) => void) | undefined,
	): (update: unknown) => void {
		return (update: unknown) => {
			if (update && typeof update === "object") {
				this.observe(index, agent, update as Record<string, unknown>);
			}
			forward?.(update);
		};
	}

	private observe(
		index: number,
		agent: RoundAgentRecord,
		update: Record<string, unknown>,
	): void {
		const at = this.rounds.now_();
		const live = LIVE_STATES.has(agent.state);
		if (typeof update.cancelId === "string") {
			this.live.cancelIds.set(index, update.cancelId);
		}
		if (!live) {
			return;
		}
		if (update.queued === true && agent.state !== "waiting_infra") {
			agent.state = "queued";
		}
		if (update.queued === false) {
			agent.startedAt ??= at;
			if (agent.state === "queued") {
				agent.state = "running";
			}
		}
		// A path with no queue in front of it (the session's single delegated
		// connection, no slot gate) never says `queued: false`: its first
		// iteration or output is what says it runs.
		if (
			agent.state === "queued" &&
			update.queued === undefined &&
			["iterations", "inputTokens", "latestOutput", "genTps", "activity"].some(
				(key) => update[key] !== undefined,
			)
		) {
			agent.startedAt ??= at;
			agent.state = "running";
		}
		if (update.waiting && typeof update.waiting === "object") {
			const wait = update.waiting as Partial<AgentWaitInfo>;
			agent.waiting = {
				kind: wait.kind === "transport" ? "transport" : "refusal",
				where: String(wait.where ?? "the server"),
				detail: String(wait.detail ?? ""),
				since: agent.waiting?.since ?? at,
			};
			agent.state = "waiting_infra";
		} else if (update.waiting === null && agent.waiting) {
			agent.waiting = undefined;
			agent.state = "running";
			agent.startedAt ??= at;
		}
		// At its cap, waiting for the lead (`agent-iteration-cap.ts`): the
		// update carries its iterations and cap; `null` is its resume.
		if (update.awaitingLead && typeof update.awaitingLead === "object") {
			const cap = update.awaitingLead as {
				iterations?: unknown;
				maxIterations?: unknown;
				reason?: unknown;
				detail?: unknown;
			};
			agent.state = "awaiting_lead";
			agent.awaitingReason =
				cap.reason === "looping" || cap.reason === "struggling"
					? cap.reason
					: "iteration_cap";
			if (
				(cap.reason === "looping" || cap.reason === "struggling") &&
				typeof cap.detail === "string"
			) {
				agent.stopDetail = cap.detail;
			}
			if (typeof cap.iterations === "number") {
				agent.iterations = cap.iterations;
			}
			if (typeof cap.maxIterations === "number") {
				agent.maxIterations = cap.maxIterations;
			}
		} else if (
			(update.awaitingLead === null || update.awaitingLead === false) &&
			agent.state === "awaiting_lead"
		) {
			agent.state = "running";
			agent.awaitingReason = undefined;
		}
		const text = (key: string) =>
			typeof update[key] === "string" ? (update[key] as string) : undefined;
		const num = (key: string) =>
			typeof update[key] === "number" && Number.isFinite(update[key])
				? (update[key] as number)
				: undefined;
		agent.nodeId = text("nodeId") ?? agent.nodeId;
		agent.nodeLabel = text("nodeLabel") ?? agent.nodeLabel;
		agent.providerId = text("providerId") ?? agent.providerId;
		agent.modelId = text("modelId") ?? agent.modelId;
		agent.contextWindow = num("contextWindow") ?? agent.contextWindow;
		agent.inputTokens = num("inputTokens") ?? agent.inputTokens;
		agent.outputTokens = num("outputTokens") ?? agent.outputTokens;
		agent.contextTokens = num("contextTokens") ?? agent.contextTokens;
		agent.genTps = num("genTps") ?? agent.genTps;
		agent.iterations = num("iterations") ?? agent.iterations;
		agent.toolCalls = num("toolCalls") ?? agent.toolCalls;
		agent.maxIterations = num("maxIterations") ?? agent.maxIterations;
		if (num("compactions") !== undefined) {
			agent.compactions = num("compactions");
			agent.compactionsByCause = {
				...((update.compactionsByCause as Partial<
					Record<CompactionCause, number>
				>) ?? {}),
			};
		}
		if (update.sampling && typeof update.sampling === "object") {
			agent.samplingUsed = update.sampling as RealizedSpawnSampling;
		}
		if (update.oracle && typeof update.oracle === "object") {
			agent.oracle = update.oracle as AgentOracleResult;
		}
		const output = text("latestOutput");
		if (output?.trim()) {
			agent.outputTail = tail(output, ROUND_OUTPUT_TAIL_CHARS);
		}
		const activity = update.activity as
			| { text?: unknown; severity?: unknown }
			| undefined;
		if (activity && typeof activity.text === "string" && activity.text.trim()) {
			this.pushActivity(
				agent,
				activity.text,
				activity.severity === "warn" ? "warn" : undefined,
			);
		}
		if (
			(update.queued === false && (text("nodeLabel") || text("nodeId"))) ||
			text("latestToolCall")
		) {
			this.pushActivity(
				agent,
				text("latestToolCall")
					? `tool: ${text("latestToolCall")}`
					: `placed on ${agent.nodeLabel ?? agent.nodeId}`,
			);
		}
		this.rounds.schedulePersist();
	}

	private pushActivity(
		agent: RoundAgentRecord,
		text: string,
		severity?: "warn",
	): void {
		const line = text.trim().slice(0, 240);
		const last = agent.activity[agent.activity.length - 1];
		if (last?.text === line) {
			return;
		}
		agent.activity.push({
			at: this.rounds.now_(),
			text: line,
			...(severity ? { severity } : {}),
		});
		if (agent.activity.length > ROUND_ACTIVITY_LIMIT) {
			agent.activity.splice(0, agent.activity.length - ROUND_ACTIVITY_LIMIT);
		}
	}

	private async runAgent(
		index: number,
		agent: RoundAgentRecord,
		context: AgentToolContext,
		fn: (context: AgentToolContext) => Promise<RoundMemberOutput>,
	): Promise<RoundMemberOutput> {
		const forward = this.live.emitUpdate
			? this.live.rowed
				? (update: unknown) =>
						this.live.emitUpdate?.({
							...(update as Record<string, unknown>),
							member: index,
						})
				: (update: unknown) => this.live.emitUpdate?.(update)
			: context.emitUpdate;
		if (forward) {
			this.live.rows ??= new Map();
			this.live.rows.set(index, forward);
		}
		const memberContext: AgentToolContext = {
			...context,
			emitUpdate: this.tap(index, agent, forward),
			metadata: { ...(context.metadata ?? {}), [ROUND_MEMBER_KEY]: true },
		};
		let outcome: RoundMemberOutput | { thrown: unknown };
		try {
			outcome = await fn(memberContext);
		} catch (error) {
			outcome = { thrown: error };
		}
		const output: RoundMemberOutput =
			"thrown" in outcome
				? {
						name: agent.name,
						error:
							outcome.thrown instanceof Error
								? outcome.thrown.message
								: String(outcome.thrown),
					}
				: outcome;
		this.live.outputs.set(index, output);
		this.finish(agent, output, outcome);
		return output;
	}

	/**
	 * An agent whose run returned while it waits at its cap, its call gone
	 * (`agent-iteration-cap.ts`: detached). The round stays open for it, its
	 * resume and its real end are recorded as they happen, and its end
	 * settles the round again -- a report the lead has not had.
	 */
	private followDetached(
		agent: RoundAgentRecord,
		output: RoundMemberOutput,
	): void {
		const cancelId = this.live.cancelIds.get(agent.index);
		const runtimeId = output.agentId;
		if (!runtimeId && !cancelId) {
			return;
		}
		const live = this.live;
		live.holds += 1;
		const mine = (event: AwaitingLeadEvent) =>
			(runtimeId !== undefined && event.agent.agentId === runtimeId) ||
			(cancelId !== undefined && event.agent.cancelId === cancelId);
		const stop = onAwaitingLead((event) => {
			if (!mine(event)) {
				return;
			}
			if (event.type === "resumed") {
				agent.state = "running";
				agent.maxIterations =
					(agent.maxIterations ?? event.agent.maxIterations) +
					event.extraIterations;
				agent.activity.push({
					at: this.rounds.now_(),
					text: `Resumed by the lead with ${event.extraIterations} more iterations`,
				});
				this.rounds.schedulePersist();
				return;
			}
			if (event.type === "suspended") {
				agent.state = "awaiting_lead";
				agent.awaitingReason = event.agent.reason ?? "iteration_cap";
				this.rounds.schedulePersist();
				return;
			}
			if (event.type !== "finished") {
				return;
			}
			stop();
			const final = event.outcome;
			const late: RoundMemberOutput = {
				name: agent.name,
				text: final.result.text,
				iterations: final.iterations,
				finishReason: final.result.finishReason,
				usage: {
					inputTokens: final.result.usage.inputTokens,
					outputTokens: final.result.usage.outputTokens,
				},
				...(final.maxIterations !== undefined
					? { maxIterations: final.maxIterations }
					: {}),
				...(final.stopReason ? { stopReason: final.stopReason } : {}),
				...(final.oracle ? { oracle: final.oracle } : {}),
			};
			live.outputs.set(agent.index, late);
			this.finish(agent, late, late);
			// Its row still shows it waiting: it ends there as a member does.
			live.rows?.get(agent.index)?.({ finished: late });
			// Its end is news the lead has not had, whoever had the round's
			// report before.
			live.record.delivered = false;
			live.reportOverride = undefined;
			live.holds -= 1;
			this.rounds.settleIfIdle(live);
		});
	}

	private finish(
		agent: RoundAgentRecord,
		output: RoundMemberOutput,
		outcome: RoundMemberOutput | { thrown: unknown } | undefined,
		never?: string,
	): void {
		const cancelId = this.live.cancelIds.get(agent.index);
		const stoppedBy = cancelId
			? subagentCancellation.stoppedBy(cancelId)
			: undefined;
		const end: {
			state: AgentRunState;
			reason: AgentStopReason;
			detail?: string;
		} =
			never || !outcome
				? {
						state: "cancelled" as AgentRunState,
						reason: (stoppedBy === "lead"
							? "cancelled_by_lead"
							: stoppedBy === "user"
								? "cancelled_by_user"
								: "cancelled_by_session") as AgentStopReason,
						detail: never ?? "never ran",
					}
				: classifyAgentEnd(
						outcome,
						stoppedBy,
						this.live.controller.signal.aborted,
					);
		const at = this.rounds.now_();
		// Returned while it waits on the lead: it has not ended.
		if (output.state === "awaiting_lead") {
			end.state = "awaiting_lead";
			end.reason =
				output.stopReason === "loop_guard"
					? "looping"
					: output.stopReason === "supervisor"
						? "struggling"
						: "iteration_cap";
			agent.awaitingReason = end.reason;
		} else if (output.stopReason === "loop_guard" && !stoppedBy) {
			// Ended where the loop guard stopped it, with nobody to ask.
			end.state = "failed";
			end.reason = "looping";
		} else if (output.stopReason === "supervisor" && !stoppedBy) {
			// Ended where the struggle supervisor stopped it, likewise.
			end.state = "failed";
			end.reason = "struggling";
		}
		agent.maxIterations = output.maxIterations ?? agent.maxIterations;
		agent.state = end.state;
		agent.stopReason = end.reason;
		agent.stopDetail = end.detail;
		agent.endedAt = at;
		agent.waiting = undefined;
		agent.iterations = output.iterations ?? agent.iterations;
		if (output.usage) {
			agent.inputTokens = output.usage.inputTokens ?? agent.inputTokens;
			agent.outputTokens = output.usage.outputTokens ?? agent.outputTokens;
		}
		if (output.model) {
			agent.providerId = output.model.provider;
			agent.modelId = output.model.id;
		}
		agent.nodeId = output.nodeId ?? agent.nodeId;
		agent.nodeLabel = output.nodeLabel ?? agent.nodeLabel;
		agent.samplingUsed = output.sampling ?? agent.samplingUsed;
		agent.oracle = output.oracle ?? agent.oracle;
		const report = (output.text ?? output.error ?? "").trim();
		if (report) {
			agent.result = tail(report, ROUND_OUTPUT_TAIL_CHARS);
			agent.outputTail = agent.result;
		}
		if (end.state === "awaiting_lead") {
			this.followDetached(agent, output);
		}
		if (end.state === "failed") {
			const failureClass =
				end.reason === "engine_error" ? "infra" : ("task" as const);
			agent.errors.push({
				at,
				class: failureClass,
				text: (end.detail ?? report).slice(0, 300) || end.reason,
			});
			if (agent.errors.length > ROUND_ERROR_LIMIT) {
				agent.errors.splice(0, agent.errors.length - ROUND_ERROR_LIMIT);
			}
		}
		this.rounds.schedulePersist();
	}
}

/**
 * The per-session registries, process-wide like the stop registry: the host
 * attaches persistence when it starts a session, and a tool finds its round
 * by the session id its context carries.
 */
const REGISTRIES = new Map<string, AgentRounds>();

/**
 * A round the session's end caught running: each agent still out is
 * `interrupted`, and the round is over with its report owed to the lead.
 */
function markRoundInterrupted(round: RoundRecord, at: number): boolean {
	let changed = false;
	for (const agent of round.agents ?? []) {
		if (LIVE_STATES.has(agent.state)) {
			agent.state = "cancelled";
			agent.stopReason = "interrupted";
			agent.stopDetail =
				"The session ended while it ran (the window was reloaded or the task closed); its work in progress is gone.";
			agent.endedAt ??= at;
			agent.waiting = undefined;
			agent.awaitingReason = undefined;
			changed = true;
		}
	}
	if (round.status === "running") {
		round.status = "done";
		round.endedAt ??= at;
		// Its report, interruption and all, is the lead's to be told.
		round.delivered = false;
		changed = true;
	}
	return changed;
}

/**
 * A session's rounds, for a view drawn after the fact -- a task reopened, a
 * window reloaded: this process's registry when it holds them, else the file
 * the session wrote beside its transcript. A round the file says is running
 * was not ended by any process alive now, so it reads as interrupted, as the
 * session's next start will record it. Copies: nothing here changes a round.
 */
export function readRoundRecords(
	sessionId: string,
	path?: string,
): RoundRecord[] {
	const registry = REGISTRIES.get(sessionId);
	const held = registry?.list() ?? [];
	if (held.length > 0) {
		return held.map((round) => structuredClone(round));
	}
	if (!path) {
		return [];
	}
	let rounds: RoundRecord[];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as {
			version?: number;
			rounds?: RoundRecord[];
		};
		rounds =
			parsed?.version === 1 && Array.isArray(parsed.rounds)
				? parsed.rounds
				: [];
	} catch {
		return [];
	}
	const at = Date.now();
	for (const round of rounds) {
		for (const agent of round.agents ?? []) {
			agent.activity ??= [];
			agent.errors ??= [];
		}
		markRoundInterrupted(round, at);
	}
	return rounds;
}

/** This session's rounds, created on first use. */
export function roundsFor(sessionId: string | undefined): AgentRounds {
	const key = sessionId ?? "";
	let rounds = REGISTRIES.get(key);
	if (!rounds) {
		rounds = new AgentRounds(key);
		REGISTRIES.set(key, rounds);
	}
	return rounds;
}

/** The session is gone: stop its rounds, write them, forget them. */
export function releaseRounds(sessionId: string): void {
	const rounds = REGISTRIES.get(sessionId);
	if (!rounds) {
		return;
	}
	// Recorded as interrupted and written before anything is stopped: see
	// `interruptAll`.
	rounds.interruptAll();
	rounds.stopAll();
	REGISTRIES.delete(sessionId);
}

/** Test seam. */
export function __resetAgentRounds(): void {
	for (const rounds of REGISTRIES.values()) {
		rounds.stopAll();
	}
	REGISTRIES.clear();
}

/**
 * A round's report as the lead reads it: the batch shape -- an aggregate, an
 * index naming every agent with its id and stop reason, and as many reports
 * as fit, each with its facts line -- whatever tool opened the round.
 */
function defaultRoundReport(
	record: RoundRecord,
	outputs: ReadonlyMap<number, RoundMemberOutput>,
	sessionId: string | undefined,
): string {
	const results = record.agents.map((agent) => {
		const output = outputs.get(agent.index);
		return {
			name: agent.name,
			...(agent.type ? { type: agent.type } : {}),
			id: agent.id,
			...(agent.stopReason ? { stop: agent.stopReason } : {}),
			facts: agentFactsLine(agent),
			...(output
				? {
						...(output.text !== undefined ? { text: output.text } : {}),
						...(output.finishReason
							? { finishReason: output.finishReason }
							: {}),
						...(output.iterations !== undefined
							? { iterations: output.iterations }
							: {}),
						...(output.usage ? { usage: output.usage } : {}),
						...(output.error !== undefined ? { error: output.error } : {}),
					}
				: agent.state === "done"
					? { text: agent.result ?? "", finishReason: "completed" }
					: { error: agent.stopDetail ?? agent.stopReason ?? agent.state }),
		};
	});
	return JSON.stringify(
		buildSpawnBatchReport(results, sessionId, undefined, record.id),
	);
}

/**
 * An agent's trouble watch, also reporting each wait on its row's channel --
 * `{waiting: {kind, where, detail}}` while it waits, `{waiting: null}` when
 * the engine produces for it again -- so its round knows it is waiting on
 * infrastructure and on what. The watch itself is untouched: the lead's
 * nudge after a long wait works exactly as it did.
 */
export function reportWaits<
	T extends {
		waiting(state: { kind: string; where: string; detail: string }): void;
		progressed(): void;
		dispose(): void;
	},
>(
	watch: T,
	emitUpdate: ((update: unknown) => void) | undefined,
	control?: { setWaitingInfra(waiting: boolean): void },
): T {
	let waiting = false;
	return {
		...watch,
		waiting: (state) => {
			watch.waiting(state);
			waiting = true;
			control?.setWaitingInfra(true);
			emitUpdate?.({
				waiting: { kind: state.kind, where: state.where, detail: state.detail },
			});
		},
		progressed: () => {
			watch.progressed();
			if (waiting) {
				waiting = false;
				control?.setWaitingInfra(false);
				emitUpdate?.({ waiting: null });
			}
		},
		dispose: () => watch.dispose(),
	};
}

/**
 * What every agent's result carries (section F): its state and why it
 * stopped, iterations against its cap, tokens, compactions, the oracle's
 * verdict, its sampler, and where it ran.
 */
export interface AgentFacts {
	id: string;
	round: string;
	state: AgentRunState;
	stopReason?: AgentStopReason;
	iterations?: number;
	maxIterations?: number;
	tokens?: { input: number; output: number };
	compactions?: {
		count: number;
		byCause?: Partial<Record<CompactionCause, number>>;
	};
	oracle?: AgentOracleResult;
	sampling?: RealizedSpawnSampling;
	node?: string;
	model?: string;
}

export function agentFacts(
	round: Pick<RoundRecord, "id">,
	agent: RoundAgentRecord,
): AgentFacts {
	const node = agent.nodeLabel ?? agent.nodeId;
	const model = [agent.providerId, agent.modelId].filter(Boolean).join("/");
	return {
		id: agent.id,
		round: round.id,
		state: agent.state,
		...(agent.stopReason ? { stopReason: agent.stopReason } : {}),
		...(agent.iterations !== undefined ? { iterations: agent.iterations } : {}),
		...(agent.maxIterations !== undefined
			? { maxIterations: agent.maxIterations }
			: {}),
		...(agent.inputTokens !== undefined || agent.outputTokens !== undefined
			? {
					tokens: {
						input: agent.inputTokens ?? 0,
						output: agent.outputTokens ?? 0,
					},
				}
			: {}),
		...(agent.compactions
			? {
					compactions: {
						count: agent.compactions,
						...(agent.compactionsByCause
							? { byCause: agent.compactionsByCause }
							: {}),
					},
				}
			: {}),
		...(agent.oracle ? { oracle: agent.oracle } : {}),
		...(agent.samplingUsed ? { sampling: agent.samplingUsed } : {}),
		...(node ? { node } : {}),
		...(model ? { model } : {}),
	};
}

function compactNumber(value: number): string {
	return value >= 10_000
		? `${Math.round(value / 1000)}k`
		: value >= 1_000
			? `${(value / 1000).toFixed(1)}k`
			: String(value);
}

/** The same facts on one line, for a round's per-agent report entries. */
export function agentFactsLine(agent: RoundAgentRecord): string {
	const parts: string[] = [
		`${agent.state}${agent.stopReason ? ` (${agent.stopReason})` : ""}`,
	];
	if (agent.iterations !== undefined) {
		parts.push(
			`${agent.iterations}${agent.maxIterations ? `/${agent.maxIterations}` : ""} iterations`,
		);
	}
	if (agent.inputTokens !== undefined || agent.outputTokens !== undefined) {
		parts.push(
			`${compactNumber(agent.inputTokens ?? 0)} in / ${compactNumber(agent.outputTokens ?? 0)} out tokens`,
		);
	}
	if (agent.compactions) {
		const causes = Object.entries(agent.compactionsByCause ?? {})
			.filter(([, count]) => (count ?? 0) > 0)
			.map(([cause, count]) => `${cause} ${count}`)
			.join(", ");
		parts.push(
			`${agent.compactions} compaction${agent.compactions === 1 ? "" : "s"}${causes ? ` (${causes})` : ""}`,
		);
	}
	if (agent.oracle) {
		parts.push(`check ${oracleWords(agent.oracle)}`);
	}
	const sampling = agent.samplingUsed;
	if (
		sampling &&
		(sampling.seed !== undefined || sampling.temperature !== undefined)
	) {
		parts.push(
			[
				sampling.seed !== undefined ? `seed ${sampling.seed}` : "",
				sampling.temperature !== undefined
					? `temp ${sampling.temperature}`
					: "",
			]
				.filter(Boolean)
				.join(" "),
		);
	}
	const where = [
		agent.nodeLabel ?? agent.nodeId,
		agent.modelId ?? agent.providerId,
	].filter(Boolean);
	if (where.length > 0) {
		parts.push(`on ${where.join(" ")}`);
	}
	return parts.join(" · ");
}

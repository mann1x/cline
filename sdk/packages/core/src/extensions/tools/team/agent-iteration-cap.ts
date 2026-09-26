/**
 * A delegated agent at its iteration cap waits for the lead; its work is kept.
 *
 * Ruled (lead-agent-control spec, D): hitting `maxIterations` must not lose
 * the work -- the lead decides whether to resume it with a raised cap, or stop
 * or restart it. Until now the cap ended the run like an error, the agent's
 * overlay was handed back and disposed, and the transcript went with the
 * agent object.
 *
 * So a run that stops at its cap is *suspended* here, in state
 * `awaiting_lead`, with everything it needs to go on: the conversation (the
 * agent object, alive), its private workspace (its path does not tear it down
 * while it waits) and its place in the round. The lead is told -- once for all
 * the agents of a session that stop together -- and answers with
 * {@link resumeSuspended} (the `resume_agent` tool) or a stop. A blocking
 * round does not return while one of its agents waits: the spawn call is the
 * thing waiting, and the lead's side turn is where it decides.
 *
 * With nobody to ask -- a host that registered no lead listener, so no side
 * turn and no queue -- the agent is *detached*: its spawn returns at once with
 * the agent reported `awaiting_lead`, and the agent stays suspended with its
 * resources held until `resume_agent` continues it in the background or it is
 * stopped. {@link createDelegatedAgentLifetime} is how the spawn path defers
 * its teardown to that point.
 *
 * **The engine session is released while an agent waits.** On an opencoti node
 * a held engine session is KV cells booked against the node's admission --
 * "one held past its work refuses the next agent" -- and an agent waiting on
 * the lead is generating nothing. The resumed agent pays one re-prefill of its
 * transcript. The client-side node lease (or endpoint slot) is kept: it pins
 * the agent to the node its transcript was produced on, and giving it up would
 * let the harness re-place it onto a different model mid-conversation.
 */

import type { AgentResult } from "@cline/shared";
import type { AgentOracleResult, DelegatedAgentCheck } from "./agent-check";
import { leadCanBeReached, sendLeadNudge } from "./agent-trouble";

/** The tool the lead continues a waiting agent with (built on {@link resumeSuspended}). */
export const RESUME_AGENT_TOOL_NAME = "resume_agent";

/** How long agents stopping together wait for each other's notice. */
export const AWAITING_LEAD_BATCH_MS = 3_000;

/** What the agent-layer needs of the agent it runs: a `SessionRuntime`. */
export interface CappableAgent {
	getAgentId(): string;
	/** Optional so a stand-in agent need not have it; a `SessionRuntime` does. */
	getMaxIterations?(): number | undefined;
	setMaxIterations?(maxIterations: number | undefined): void;
	continue(message?: string): Promise<AgentResult>;
}

/** An agent waiting on the lead, as the lead and the status tool see it. */
export interface AwaitingLeadView {
	/** The agent's own id (its runtime's). */
	agentId: string;
	/** What the round calls it. */
	name: string;
	sessionId?: string;
	/** The id `stop_agents` and the chat row know it by, when it has one. */
	cancelId?: string;
	/** Iterations it has used, over every run so far. */
	iterations: number;
	/** Its cap so far: the first one plus every raise. */
	maxIterations: number;
	/** When it stopped at the cap. */
	since: number;
	/** Its spawn call has returned; a resume runs it in the background. */
	detached: boolean;
}

/** Why an agent's run came to an end, as far as the cap is concerned. */
export type DelegatedStopReason = "iteration_cap";

/** A delegated run, with what the cap and the check made of it. */
export interface DelegatedRunOutcome {
	/** The last run's result, with iterations and usage summed over every run. */
	result: AgentResult;
	/** Iterations used, over the first run and every resume. */
	iterations: number;
	/** The cap it ended under: the first plus every raise. Absent is no cap. */
	maxIterations?: number;
	/** Set when the cap is what ended it (stopped at the cap by the lead or a user). */
	stopReason?: DelegatedStopReason;
	/** Set when it is still waiting on the lead: its spawn returned detached. */
	state?: "awaiting_lead";
	/** The lead's check, when one was set. */
	oracle?: AgentOracleResult;
}

export type AwaitingLeadEvent =
	| { type: "suspended"; agent: AwaitingLeadView }
	| { type: "resumed"; agent: AwaitingLeadView; extraIterations: number }
	| { type: "stopped"; agent: AwaitingLeadView; reason: string }
	| { type: "finished"; agent: AwaitingLeadView; outcome: DelegatedRunOutcome };

type LeadDecision =
	| { kind: "resume"; extraIterations: number }
	| { kind: "stop"; reason: string };

interface Entry {
	view: AwaitingLeadView;
	decide(decision: LeadDecision): void;
	/** A detached agent's run after a resume, for the resume's caller. */
	completion?: Promise<DelegatedRunOutcome>;
}

const WAITING = new Map<string, Entry>();
const LISTENERS = new Set<(event: AwaitingLeadEvent) => void>();
const PENDING_NOTICES = new Map<
	string,
	{ views: AwaitingLeadView[]; timer: ReturnType<typeof setTimeout> }
>();

function emit(event: AwaitingLeadEvent): void {
	for (const listener of LISTENERS) {
		try {
			listener(event);
		} catch {
			// An observer must not break the agent it observes.
		}
	}
}

/**
 * Be told as agents stop at their cap, resume, are stopped there, or -- a
 * detached one -- finish. For the round registry and the status tool.
 */
export function onAwaitingLead(
	listener: (event: AwaitingLeadEvent) => void,
): () => void {
	LISTENERS.add(listener);
	return () => {
		LISTENERS.delete(listener);
	};
}

/** Every agent waiting on the lead, or those of one session. */
export function listAwaitingLead(sessionId?: string): AwaitingLeadView[] {
	return [...WAITING.values()]
		.map((entry) => ({ ...entry.view }))
		.filter((view) => sessionId === undefined || view.sessionId === sessionId);
}

function find(
	idOrName: string,
	sessionId: string | undefined,
): { entry?: Entry; error?: string } {
	const wanted = idOrName.trim();
	const candidates = [...WAITING.values()].filter(
		(entry) => sessionId === undefined || entry.view.sessionId === sessionId,
	);
	const exact = candidates.filter(
		(entry) => entry.view.agentId === wanted || entry.view.cancelId === wanted,
	);
	const byName =
		exact.length > 0
			? exact
			: candidates.filter(
					(entry) => entry.view.name.toLowerCase() === wanted.toLowerCase(),
				);
	if (byName.length === 1) {
		return { entry: byName[0] };
	}
	const waiting = candidates.map((entry) => entry.view.name);
	if (byName.length > 1) {
		return {
			error: `Several agents waiting on you are called "${wanted}"; name one by its agent id: ${byName
				.map((entry) => entry.view.agentId)
				.join(", ")}.`,
		};
	}
	return {
		error: `No agent called "${wanted}" is waiting on you at its iteration cap.${
			waiting.length > 0
				? ` Waiting: ${waiting.join(", ")}.`
				: " None is waiting."
		}`,
	};
}

export interface ResumeSuspendedResult {
	ok: boolean;
	message: string;
	agent?: AwaitingLeadView;
	/**
	 * For a detached agent: its run from here, to its end or its next stop at
	 * the cap. Absent for an agent whose spawn call is still open -- that call
	 * returns its report.
	 */
	completion?: Promise<DelegatedRunOutcome>;
}

/**
 * Continue an agent waiting at its cap, with `extraIterations` more turns.
 *
 * The primitive `resume_agent` is built on. `idOrName` is the agent's id, its
 * row's id, or its name in the round; `sessionId` scopes the search to the
 * lead's session, which a caller should always pass.
 */
export function resumeSuspended(
	idOrName: string,
	extraIterations: number,
	sessionId?: string,
): ResumeSuspendedResult {
	const extra = Math.floor(Number(extraIterations));
	if (!Number.isFinite(extra) || extra < 1) {
		return {
			ok: false,
			message: `extra_iterations must be a whole number of at least 1 (got ${String(extraIterations)}).`,
		};
	}
	const { entry, error } = find(idOrName, sessionId);
	if (!entry) {
		return { ok: false, message: error ?? "Not found." };
	}
	const agent = { ...entry.view };
	entry.decide({ kind: "resume", extraIterations: extra });
	return {
		ok: true,
		message: `Resumed ${agent.name} with ${extra} more iteration${
			extra === 1 ? "" : "s"
		} (cap now ${agent.maxIterations + extra}).${
			agent.detached
				? " It runs in the background; its report arrives when it finishes."
				: " Its report comes back with its round."
		}`,
		agent,
		...(entry.completion ? { completion: entry.completion } : {}),
	};
}

/**
 * End an agent waiting at its cap, keeping what it did: its report is its last
 * output, its changes are handed back as they would be on any other end.
 */
export function stopSuspended(
	idOrName: string,
	options: { sessionId?: string; reason?: string } = {},
): { ok: boolean; message: string; agent?: AwaitingLeadView } {
	const { entry, error } = find(idOrName, options.sessionId);
	if (!entry) {
		return { ok: false, message: error ?? "Not found." };
	}
	const agent = { ...entry.view };
	entry.decide({
		kind: "stop",
		reason: options.reason ?? "stopped by the lead",
	});
	return {
		ok: true,
		message: `Stopped ${agent.name} at its iteration cap; its work so far is its report.`,
		agent,
	};
}

/** The notice for agents that stopped at their cap, as the lead reads it. */
export function describeAwaitingLead(
	views: readonly AwaitingLeadView[],
): string {
	const lines = views.map(
		(view) =>
			`- ${view.name} (agent id ${view.agentId}) reached its ${view.maxIterations}-iteration cap after ${view.iterations} iterations.`,
	);
	return [
		`${views.length === 1 ? "An agent has" : `${views.length} agents have`} stopped at the iteration cap and ${views.length === 1 ? "is" : "are"} waiting for you. The work is kept -- transcript and file changes -- and nothing has been discarded:`,
		...lines,
		`Call ${RESUME_AGENT_TOOL_NAME}(agent_id, extra_iterations) to continue one from where it stopped with a raised cap, or stop it (stop_agents) to take its work as it is, or restart it. Its round does not return until you decide.`,
	].join("\n");
}

/** Send what is batched for a session now, rather than when its timer fires. */
export function flushAwaitingLeadNotices(sessionId?: string): void {
	for (const [id, pending] of [...PENDING_NOTICES.entries()]) {
		if (sessionId !== undefined && id !== sessionId) {
			continue;
		}
		clearTimeout(pending.timer);
		sendNotice(id);
	}
}

function sendNotice(sessionId: string): void {
	const pending = PENDING_NOTICES.get(sessionId);
	PENDING_NOTICES.delete(sessionId);
	// Only those still waiting: one resumed or stopped in the meantime has
	// been decided already.
	const still = (pending?.views ?? []).filter((view) =>
		[...WAITING.values()].some((entry) => entry.view === view),
	);
	if (still.length > 0) {
		sendLeadNudge(sessionId, describeAwaitingLead(still));
	}
}

function queueNotice(view: AwaitingLeadView): void {
	const sessionId = view.sessionId;
	if (!sessionId) {
		return;
	}
	const pending = PENDING_NOTICES.get(sessionId);
	if (pending) {
		pending.views.push(view);
		return;
	}
	const timer = setTimeout(() => sendNotice(sessionId), AWAITING_LEAD_BATCH_MS);
	(timer as unknown as { unref?: () => void }).unref?.();
	PENDING_NOTICES.set(sessionId, { views: [view], timer });
}

/**
 * When a spawn path's teardown runs: at once, or -- for an agent detached at
 * its cap -- once the agent is finally done.
 */
export interface DelegatedAgentLifetime {
	/**
	 * Run `cleanup` now, or -- for a detached agent -- schedule it for when the
	 * agent is finally done and return at once, so the spawn call can return
	 * while the agent waits. Never throws.
	 */
	end(cleanup: () => Promise<void> | void): Promise<void>;
	/** Settles once the cleanup handed to {@link end} has run. */
	readonly ended: Promise<void>;
	/** Whether the agent was detached (its spawn returned while it waits). */
	readonly detached: boolean;
	/** Set by the run when it detaches: teardown waits for `done`. */
	holdUntil(done: Promise<unknown>): void;
}

export function createDelegatedAgentLifetime(): DelegatedAgentLifetime {
	let until: Promise<unknown> | undefined;
	let markEnded!: () => void;
	const ended = new Promise<void>((resolve) => {
		markEnded = resolve;
	});
	const run = async (cleanup: () => Promise<void> | void) => {
		try {
			await cleanup();
		} catch {
			// Teardown is best-effort on every path.
		} finally {
			markEnded();
		}
	};
	return {
		ended,
		get detached() {
			return until !== undefined;
		},
		holdUntil(done) {
			until = done;
		},
		async end(cleanup) {
			if (!until) {
				await run(cleanup);
				return;
			}
			// The spawn call returns now; the teardown waits for the agent.
			void until.then(
				() => run(cleanup),
				() => run(cleanup),
			);
		},
	};
}

export interface RunDelegatedWithCapOptions {
	agent: CappableAgent;
	/** The first run: `agent.run(task)` or `agent.runWithHead(...)`. */
	start: () => Promise<AgentResult>;
	/** What the round calls it. */
	name: string;
	/** The cap it was built with, when the agent cannot say. */
	maxIterations?: number;
	/** The lead's session. */
	sessionId?: string;
	/** The id its row and `stop_agents` know it by. */
	cancelId?: string;
	/** Its stop: a stop while it waits ends it at the cap, work kept. */
	signal?: AbortSignal;
	/** Its row. */
	emitUpdate?: (update: unknown) => void;
	/** The lead's check on it, already wired into its completion boundary. */
	check?: DelegatedAgentCheck;
	/** Gives the engine session back while it waits; see the file comment. */
	releaseEngineSession?: () => Promise<unknown>;
	/**
	 * Where teardown is deferred to when the agent is detached. Without one it
	 * is never detached: with nobody to ask, it is ended at the cap instead,
	 * its work kept.
	 */
	lifetime?: DelegatedAgentLifetime;
	/** A detached agent's final outcome, for the path's own end-of-run work. */
	onDetachedFinish?: (outcome: DelegatedRunOutcome) => Promise<void> | void;
}

function addUsage(
	total: AgentResult["usage"],
	next: AgentResult["usage"],
): AgentResult["usage"] {
	const sum = (a?: number, b?: number) =>
		a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
	return {
		...next,
		inputTokens: total.inputTokens + next.inputTokens,
		outputTokens: total.outputTokens + next.outputTokens,
		...(sum(total.cacheReadTokens, next.cacheReadTokens) !== undefined
			? { cacheReadTokens: sum(total.cacheReadTokens, next.cacheReadTokens) }
			: {}),
		...(sum(total.cacheWriteTokens, next.cacheWriteTokens) !== undefined
			? { cacheWriteTokens: sum(total.cacheWriteTokens, next.cacheWriteTokens) }
			: {}),
		...(sum(total.totalCost, next.totalCost) !== undefined
			? { totalCost: sum(total.totalCost, next.totalCost) }
			: {}),
	};
}

/** What an agent is told when the lead raises its cap. */
export function resumeNote(extraIterations: number): string {
	return `The lead raised your iteration budget by ${extraIterations}. Continue from exactly where you stopped -- your earlier work is all still here -- finish the task, and give your answer.`;
}

/**
 * Run a delegated agent to its end, suspending it at its cap for the lead.
 *
 * Every spawn path runs its agent through this, so the cap behaves the same
 * on all of them. A run with no cap, or one that finishes under it, passes
 * straight through.
 */
export async function runDelegatedWithCap(
	options: RunDelegatedWithCapOptions,
): Promise<DelegatedRunOutcome> {
	let cap = options.agent.getMaxIterations?.() ?? options.maxIterations;
	let iterations = 0;
	let usage: AgentResult["usage"] | undefined;
	let result = await options.start();

	const fold = (next: AgentResult) => {
		iterations += next.iterations;
		usage = usage ? addUsage(usage, next.usage) : next.usage;
		result = next;
	};
	fold(result);

	const outcome = (extra: Partial<DelegatedRunOutcome> = {}) => {
		options.check?.close();
		const oracle = options.check?.result();
		return {
			result: { ...result, iterations, usage: usage ?? result.usage },
			iterations,
			...(cap !== undefined ? { maxIterations: cap } : {}),
			...(oracle ? { oracle } : {}),
			...extra,
		} satisfies DelegatedRunOutcome;
	};

	const view = (detached: boolean): AwaitingLeadView => ({
		agentId: options.agent.getAgentId(),
		name: options.name,
		...(options.sessionId ? { sessionId: options.sessionId } : {}),
		...(options.cancelId ? { cancelId: options.cancelId } : {}),
		iterations,
		maxIterations: cap ?? iterations,
		since: Date.now(),
		detached,
	});

	/**
	 * Wait here for the lead's decision. Registered under the agent's id; a
	 * stop through its own signal is a stop at the cap.
	 */
	const suspend = (detached: boolean) => {
		const waiting = view(detached);
		let settle!: (decision: LeadDecision) => void;
		const decided = new Promise<LeadDecision>((resolve) => {
			settle = resolve;
		});
		const onAbort = () =>
			entry.decide({
				kind: "stop",
				reason: "stopped while waiting on the lead",
			});
		const entry: Entry = {
			view: waiting,
			decide: (decision) => {
				if (WAITING.get(waiting.agentId) !== entry) {
					return;
				}
				WAITING.delete(waiting.agentId);
				options.signal?.removeEventListener("abort", onAbort);
				options.emitUpdate?.({ awaitingLead: null });
				if (decision.kind === "resume") {
					emit({
						type: "resumed",
						agent: { ...waiting },
						extraIterations: decision.extraIterations,
					});
				} else {
					emit({
						type: "stopped",
						agent: { ...waiting },
						reason: decision.reason,
					});
				}
				settle(decision);
			},
		};
		WAITING.set(waiting.agentId, entry);
		options.emitUpdate?.({
			awaitingLead: {
				iterations: waiting.iterations,
				maxIterations: waiting.maxIterations,
			},
		});
		emit({ type: "suspended", agent: { ...waiting } });
		if (options.signal?.aborted) {
			onAbort();
		} else {
			options.signal?.addEventListener("abort", onAbort, { once: true });
		}
		if (!detached) {
			queueNotice(waiting);
		}
		void options.releaseEngineSession?.().catch(() => undefined);
		return { entry, decided };
	};

	/** Resume, and carry on to the next end: finished, or the cap again. */
	const resume = async (extra: number) => {
		cap = (cap ?? iterations) + extra;
		options.agent.setMaxIterations?.(extra);
		fold(await options.agent.continue(resumeNote(extra)));
	};

	const leadListening = () =>
		options.sessionId !== undefined && leadCanBeReached(options.sessionId);

	while (result.finishReason === "max_iterations") {
		if (!leadListening() && options.lifetime) {
			return detach(options, suspend, resume, () => result, outcome);
		}
		if (!leadListening()) {
			// Nobody to ask and nowhere to hold it: ended at the cap, work kept.
			return outcome({ stopReason: "iteration_cap" });
		}
		const { decided } = suspend(false);
		const decision = await decided;
		if (decision.kind === "stop") {
			return outcome({ stopReason: "iteration_cap" });
		}
		await resume(decision.extraIterations);
	}
	return outcome();
}

/**
 * Suspend with nobody to ask: return the agent as `awaiting_lead` now, and
 * leave a resume to run it on in the background.
 */
function detach(
	options: RunDelegatedWithCapOptions,
	suspend: (detached: boolean) => {
		entry: Entry;
		decided: Promise<LeadDecision>;
	},
	resume: (extra: number) => Promise<void>,
	current: () => AgentResult,
	outcome: (extra?: Partial<DelegatedRunOutcome>) => DelegatedRunOutcome,
): DelegatedRunOutcome {
	let finish!: () => void;
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	options.lifetime?.holdUntil(finished);

	const wait = () => {
		const { entry, decided } = suspend(true);
		const completion = decided.then(async (decision) => {
			if (decision.kind === "stop") {
				return outcome({ stopReason: "iteration_cap" });
			}
			try {
				await resume(decision.extraIterations);
			} catch (error) {
				finish();
				throw error;
			}
			if (current().finishReason === "max_iterations") {
				// At the cap again: waiting again, and this resume's caller is told so.
				wait();
				return outcome({ state: "awaiting_lead", stopReason: "iteration_cap" });
			}
			return outcome();
		});
		entry.completion = completion;
		void completion.then(
			async (final) => {
				if (final.state === "awaiting_lead") {
					return;
				}
				emit({
					type: "finished",
					agent: { ...entry.view },
					outcome: final,
				});
				try {
					await options.onDetachedFinish?.(final);
				} catch {
					// The agent's end must still release what it held.
				}
				finish();
			},
			() => undefined,
		);
	};
	wait();
	return outcome({ state: "awaiting_lead", stopReason: "iteration_cap" });
}

/** Test seam. */
export function __resetAwaitingLead(): void {
	for (const pending of PENDING_NOTICES.values()) {
		clearTimeout(pending.timer);
	}
	PENDING_NOTICES.clear();
	WAITING.clear();
	LISTENERS.clear();
}

/**
 * Telling the lead about agents that have been stuck for a long time.
 *
 * An agent never gives up on a refusal or a server that went away (ruled
 * after pandorum's 1tmrl swarm): it waits and retries for as long as it takes,
 * and the user can stop it from its row. What the user asked for on top of
 * that: after very extended waiting, tell the LEAD what is going on, so it can
 * consider taking those tasks back and doing them itself.
 *
 * So each delegated agent carries a watch. Every wait -- a refusal, a server
 * that is not answering -- is reported to it; any sign of progress (the engine
 * producing output for it) ends the stretch. An agent that has been waiting
 * without a break for {@link LEAD_NUDGE_AFTER_MS} is reported to the lead,
 * once per agent, together with every other agent of the same session that has
 * crossed the line by then. The report is delivered the way a steer is while
 * the lead waits on its round -- a side turn with `message_agents` and
 * `stop_agents` (see `steer-side-turn.ts`) -- and the lead's next real turn is
 * told what was said.
 *
 * An agent still waiting after {@link NO_NODE_AFTER_MS} has had nowhere to run
 * for hours, and a lead that answered the first report with "let them retry"
 * then waits with it for as long as the node stays away (pandorum's wlafh
 * run: six hours). It is reported a second time, once per agent, and this
 * report asks for a decision: ask the user, or take the tasks back when doing
 * them itself fits what the user asked.
 *
 * The agents keep retrying. Nothing here stops one: the lead may, and so may
 * the user.
 */
import { describeAdmissionWait } from "@cline/shared";
import { HARNESS_TAG } from "../../../runtime/turn-queue/harness-notes";
import { FAILED_BATCH_REASON, type TurnFaultWait } from "./turn-fault-recovery";

/** Continuous waiting after which the lead is told about an agent. */
export const LEAD_NUDGE_AFTER_MS = 10 * 60_000;

/**
 * Continuous waiting after which an agent counts as having no node to run on,
 * and the lead is asked to decide instead of waiting on.
 */
export const NO_NODE_AFTER_MS = 2 * 60 * 60_000;

/**
 * How long the first overdue agent waits for others to join its report.
 *
 * A round of agents on one node goes wrong together: 75 agents crossing the
 * line within a minute of each other are one report, not 75 side turns.
 */
export const LEAD_NUDGE_BATCH_MS = 30_000;

/**
 * How a nudge waits for the lead: `awaiting` for the agents-waiting-on-you
 * notice (one replaces another), and a `refresh` that rewrites it as it is
 * read, or drops it once it no longer applies.
 */
export interface LeadNudgeOptions {
	noteKind?: "awaiting";
	refresh?: () => string | undefined;
}

/** Per-session listener: whoever can put a message in front of the lead. */
type LeadNudgeListener = (text: string, options?: LeadNudgeOptions) => void;

const LEAD_NUDGE_LISTENERS = new Map<string, LeadNudgeListener>();

/**
 * Receive the nudges for a session's lead. One listener per session: the
 * host that owns the lead. Returns the unsubscribe.
 */
export function onLeadNudge(
	sessionId: string,
	listener: LeadNudgeListener,
): () => void {
	LEAD_NUDGE_LISTENERS.set(sessionId, listener);
	return () => {
		if (LEAD_NUDGE_LISTENERS.get(sessionId) === listener) {
			LEAD_NUDGE_LISTENERS.delete(sessionId);
		}
	};
}

/** Whether a host is listening for this session's lead: a side turn or a queue. */
export function leadCanBeReached(sessionId: string): boolean {
	return LEAD_NUDGE_LISTENERS.has(sessionId);
}

/** Put a message in front of the lead. `false` when no host is listening. */
export function sendLeadNudge(
	sessionId: string,
	text: string,
	options?: LeadNudgeOptions,
): boolean {
	const listener = LEAD_NUDGE_LISTENERS.get(sessionId);
	if (!listener) {
		return false;
	}
	try {
		listener(text, options);
		return true;
	} catch {
		return false;
	}
}

interface TroubleRecord {
	name: string;
	/** Start of the current stretch of waiting. */
	since: number;
	kind: TurnFaultWait["kind"];
	where: string;
	detail: string;
	/** Refusals in the current stretch. */
	refusals: number;
	/** Told the lead already; never twice for one agent. */
	nudged: boolean;
	/** Told the lead it has had no node for hours; never twice either. */
	escalated: boolean;
}

interface SessionTrouble {
	records: Set<TroubleRecord>;
	flush?: ReturnType<typeof setTimeout>;
}

const SESSIONS = new Map<string, SessionTrouble>();

function unref(timer: ReturnType<typeof setTimeout>): void {
	(timer as unknown as { unref?: () => void }).unref?.();
}

function minutes(ms: number): number {
	return Math.max(1, Math.round(ms / 60_000));
}

/** One agent's line in the lead's report. */
export function describeTrouble(
	record: Pick<
		TroubleRecord,
		"name" | "since" | "kind" | "where" | "detail" | "refusals"
	>,
	now: number,
): string {
	const waited = `${minutes(now - record.since)} min`;
	if (record.kind === "refusal") {
		// Queue words: "refused 13x" read to the lead as a broken node
		// (swarm ra0as), and the agent is only waiting its turn.
		return `- ${record.name}: queued by ${record.where}, ${record.refusals} ${record.refusals === 1 ? "retry" : "retries"}: "${describeAdmissionWait(record.detail.trim().slice(0, 160))}" (${waited})`;
	}
	if (record.detail === FAILED_BATCH_REASON) {
		return `- ${record.name}: ${record.where} answers, its turns fail (${record.detail}, ${waited})`;
	}
	return `- ${record.name}: ${record.where} unreachable (${record.detail}, ${waited})`;
}

/** The whole report, as the lead reads it. */
export function describeLeadNudge(
	records: ReadonlyArray<
		Pick<
			TroubleRecord,
			"name" | "since" | "kind" | "where" | "detail" | "refusals"
		>
	>,
	now: number,
): string {
	const count = records.length;
	return [
		`${HARNESS_TAG} ${count} agent${count === 1 ? "" : "s"} waiting >${minutes(LEAD_NUDGE_AFTER_MS)} min for the server, still retrying; nothing stopped:`,
		...records.map((record) => describeTrouble(record, now)),
		"Options: let them retry; or stop_agents and do their tasks yourself when the round returns. The user can stop/restart them from their rows.",
	].join("\n");
}

/** The second report: these agents have had nowhere to run for hours. */
export function describeNoNodeNudge(
	records: ReadonlyArray<
		Pick<
			TroubleRecord,
			"name" | "since" | "kind" | "where" | "detail" | "refusals"
		>
	>,
	now: number,
	afterMs = NO_NODE_AFTER_MS,
): string {
	const count = records.length;
	return [
		`${HARNESS_TAG} ${count} agent${count === 1 ? "" : "s"} with no node to run on for >${minutes(afterMs)} min, still retrying; nothing stopped:`,
		...records.map((record) => describeTrouble(record, now)),
		"Waiting on may never end. Decide now: ask the user how to proceed (ask_question); or stop_agents and do their tasks yourself, only if that fits what the user asked.",
	].join("\n");
}

function sessionOf(sessionId: string): SessionTrouble {
	let session = SESSIONS.get(sessionId);
	if (!session) {
		session = { records: new Set() };
		SESSIONS.set(sessionId, session);
	}
	return session;
}

/** A wait the engine's fetch reported (`onPolykvRoomWait`), as a trouble. */
export function roomWaitTrouble(reason: string | undefined): TurnFaultWait {
	return /come back/i.test(reason ?? "")
		? { kind: "transport", where: "the server", detail: "not answering" }
		: {
				kind: "refusal",
				where: "the server",
				detail: reason ?? "no room for it yet",
			};
}

export interface AgentTroubleWatch {
	/** The agent is waiting on this; starts or continues a stretch. */
	waiting(state: TurnFaultWait): void;
	/** The engine produced something for the agent: the stretch is over. */
	progressed(): void;
	/** The agent ended. */
	dispose(): void;
}

export interface AgentTroubleWatchOptions {
	/** The lead's session; absent means nobody to tell, and nothing is kept. */
	sessionId?: string;
	/** The agent's name, as the round and `stop_agents` call it. */
	name: string;
	/** Seams for tests. */
	now?: () => number;
	nudgeAfterMs?: number;
	noNodeAfterMs?: number;
	batchMs?: number;
	/** Where the report goes; defaults to the session's lead listener. */
	send?: (sessionId: string, text: string) => boolean;
	/** For when no lead could be reached: the log still says it. */
	logger?: { log: (message: string) => void };
}

export function createAgentTroubleWatch(
	options: AgentTroubleWatchOptions,
): AgentTroubleWatch {
	const sessionId = options.sessionId;
	const now = options.now ?? Date.now;
	const nudgeAfterMs = options.nudgeAfterMs ?? LEAD_NUDGE_AFTER_MS;
	const noNodeAfterMs = options.noNodeAfterMs ?? NO_NODE_AFTER_MS;
	const batchMs = options.batchMs ?? LEAD_NUDGE_BATCH_MS;
	const send = options.send ?? sendLeadNudge;
	let record: TroubleRecord | undefined;
	let nudgedOnce = false;
	let escalatedOnce = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const clearTimer = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	const armFor = (deadline: number) => {
		timer = setTimeout(overdue, Math.max(0, deadline - now()));
		unref(timer);
	};

	/** Wake at the next line this stretch has yet to cross. */
	const arm = () => {
		if (timer || !record || record.escalated) {
			return;
		}
		armFor(record.since + (record.nudged ? noNodeAfterMs : nudgeAfterMs));
	};

	const flush = (id: string) => {
		const session = SESSIONS.get(id);
		if (!session) {
			return;
		}
		session.flush = undefined;
		const at = now();
		const noNode = [...session.records].filter(
			(entry) => !entry.escalated && at - entry.since >= noNodeAfterMs,
		);
		const overdue = [...session.records].filter(
			(entry) =>
				!entry.nudged &&
				!noNode.includes(entry) &&
				at - entry.since >= nudgeAfterMs,
		);
		for (const entry of noNode) {
			entry.nudged = true;
			entry.escalated = true;
		}
		for (const entry of overdue) {
			entry.nudged = true;
		}
		for (const text of [
			overdue.length > 0 ? describeLeadNudge(overdue, at) : undefined,
			noNode.length > 0
				? describeNoNodeNudge(noNode, at, noNodeAfterMs)
				: undefined,
		]) {
			if (text) {
				options.logger?.log(`[Agents] telling the lead: ${text}`);
				send(id, text);
			}
		}
		if (session.records.size === 0) {
			SESSIONS.delete(id);
		}
	};

	function overdue() {
		timer = undefined;
		if (!sessionId || !record || record.escalated) {
			return;
		}
		// Each watch keeps its own wake-up for the two-hour line: the flush
		// below belongs to whichever agent crossed first, and that one may end.
		const noNodeAt = record.since + noNodeAfterMs;
		if (now() < noNodeAt) {
			armFor(noNodeAt);
			if (record.nudged) {
				return;
			}
		}
		const session = sessionOf(sessionId);
		if (!session.flush) {
			session.flush = setTimeout(() => flush(sessionId), batchMs);
			unref(session.flush);
		}
	}

	return {
		waiting: (state) => {
			if (!sessionId || (nudgedOnce && escalatedOnce)) {
				return;
			}
			if (!record) {
				record = {
					name: options.name,
					since: now(),
					kind: state.kind,
					where: state.where,
					detail: state.detail,
					refusals: 0,
					// One ten-minute report per agent, across its stretches.
					nudged: nudgedOnce,
					escalated: escalatedOnce,
				};
				sessionOf(sessionId).records.add(record);
			}
			record.kind = state.kind;
			record.where = state.where;
			record.detail = state.detail;
			if (state.kind === "refusal") {
				record.refusals += 1;
			}
			arm();
		},
		progressed: () => {
			clearTimer();
			if (record && sessionId) {
				nudgedOnce ||= record.nudged;
				escalatedOnce ||= record.escalated;
				SESSIONS.get(sessionId)?.records.delete(record);
			}
			record = undefined;
		},
		dispose: () => {
			clearTimer();
			if (record && sessionId) {
				const session = SESSIONS.get(sessionId);
				session?.records.delete(record);
				if (session && session.records.size === 0 && !session.flush) {
					SESSIONS.delete(sessionId);
				}
			}
			record = undefined;
		},
	};
}

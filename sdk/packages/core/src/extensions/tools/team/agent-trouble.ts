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
 * The agents keep retrying. Nothing here stops one: the lead may, and so may
 * the user.
 */
import { FAILED_BATCH_REASON, type TurnFaultWait } from "./turn-fault-recovery";

/** Continuous waiting after which the lead is told about an agent. */
export const LEAD_NUDGE_AFTER_MS = 10 * 60_000;

/**
 * How long the first overdue agent waits for others to join its report.
 *
 * A round of agents on one node goes wrong together: 75 agents crossing the
 * line within a minute of each other are one report, not 75 side turns.
 */
export const LEAD_NUDGE_BATCH_MS = 30_000;

/** Per-session listener: whoever can put a message in front of the lead. */
type LeadNudgeListener = (text: string) => void;

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

/** Put a message in front of the lead. `false` when no host is listening. */
export function sendLeadNudge(sessionId: string, text: string): boolean {
	const listener = LEAD_NUDGE_LISTENERS.get(sessionId);
	if (!listener) {
		return false;
	}
	try {
		listener(text);
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
}

interface SessionTrouble {
	records: Set<TroubleRecord>;
	flush?: ReturnType<typeof setTimeout>;
}

const SESSIONS = new Map<string, SessionTrouble>();

function unref(timer: ReturnType<typeof setTimeout>): void {
	(timer as unknown as { unref?: () => void }).unref?.();
}

function clock(at: number): string {
	return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
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
		return `- ${record.name}: refused ${record.refusals} time${
			record.refusals === 1 ? "" : "s"
		} by ${record.where}: "${record.detail.trim().slice(0, 200)}" (waiting since ${clock(record.since)}, ${waited})`;
	}
	if (record.detail === FAILED_BATCH_REASON) {
		return `- ${record.name}: ${record.where} answering, but failing its turns since ${clock(record.since)} (${record.detail}, ${waited})`;
	}
	return `- ${record.name}: ${record.where} unreachable since ${clock(record.since)} (${record.detail}, ${waited})`;
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
		`Status of your agents: ${count} agent${count === 1 ? " has" : "s have"} been waiting for over ${minutes(LEAD_NUDGE_AFTER_MS)} minutes without making progress, and ${count === 1 ? "is" : "are"} still retrying:`,
		...records.map((record) => describeTrouble(record, now)),
		"They will keep retrying on their own; nothing has been stopped. Consider whether it is better to stop them (`stop_agents`) and do those tasks yourself once the round returns. The user can also stop or restart any agent from its row.",
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
	const batchMs = options.batchMs ?? LEAD_NUDGE_BATCH_MS;
	const send = options.send ?? sendLeadNudge;
	let record: TroubleRecord | undefined;
	let nudgedOnce = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const clearTimer = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	const flush = (id: string) => {
		const session = SESSIONS.get(id);
		if (!session) {
			return;
		}
		session.flush = undefined;
		const at = now();
		const overdue = [...session.records].filter(
			(entry) => !entry.nudged && at - entry.since >= nudgeAfterMs,
		);
		if (overdue.length === 0) {
			return;
		}
		for (const entry of overdue) {
			entry.nudged = true;
		}
		const text = describeLeadNudge(overdue, at);
		options.logger?.log(`[Agents] telling the lead: ${text}`);
		send(id, text);
		if (session.records.size === 0) {
			SESSIONS.delete(id);
		}
	};

	const overdue = () => {
		timer = undefined;
		if (!sessionId || !record || record.nudged) {
			return;
		}
		const session = sessionOf(sessionId);
		if (!session.flush) {
			session.flush = setTimeout(() => flush(sessionId), batchMs);
			unref(session.flush);
		}
	};

	return {
		waiting: (state) => {
			if (!sessionId || nudgedOnce) {
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
					nudged: false,
				};
				sessionOf(sessionId).records.add(record);
			}
			record.kind = state.kind;
			record.where = state.where;
			record.detail = state.detail;
			if (state.kind === "refusal") {
				record.refusals += 1;
			}
			if (!timer) {
				timer = setTimeout(
					overdue,
					Math.max(0, record.since + nudgeAfterMs - now()),
				);
				unref(timer);
			}
		},
		progressed: () => {
			clearTimer();
			if (record && sessionId) {
				nudgedOnce ||= record.nudged;
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

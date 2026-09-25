/**
 * How a delegated agent waits out a turn the server dropped or refused.
 *
 * The agent loop hands a failed turn here when it failed on a fault that is
 * not the model's (see `classifyTurnFault` in `@cline/shared`): a transport
 * fault -- the server restarted, the connection was refused or reset, the
 * gateway answered 502/503/504 -- or an admission refusal. This waits, then
 * tells the loop to send the same turn again. There is no attempt limit and no
 * deadline: an agent is meant to finish its job, and the user can always stop
 * it from its row. Ruled after pandorum's 1tmrl swarm, where 41 of 75 agents
 * ended on exactly these faults.
 *
 * - **Transport**: wait for the server to answer `GET /health` again, probing
 *   with exponential backoff capped at 30 s. Measured on 1tmrl: the server was
 *   listening again ten seconds after it restarted. A transport fault that
 *   repeats (any attempt after the first) then also backs off like a refusal:
 *   a stream the SDK cannot read comes from a server that answers `/health`.
 * - **Refusal**: back off, growing to {@link REFUSAL_BACKOFF_MAX_MS}. The
 *   refusal thresholds (the tps floor, the allocation) are the user's own
 *   settings and are never touched from here; waiting is the only answer.
 *
 * Before the engine admitted an agent that was placed on a node, the spawn
 * queue owns the retry instead -- it can put the agent on another node -- so
 * this declines, and `runPlacedAgent` re-places it.
 */
import {
	notePolykvServerFault,
	serverRoot,
	sleepUnlessAborted,
	waitForServerHealth,
} from "@cline/llms";
import type { TurnFault, TurnFaultRecovery } from "@cline/shared";

/** First wait after a refusal; doubles with each one in a row. */
export const REFUSAL_BACKOFF_FIRST_MS = 2_000;

/**
 * Longest wait between refused attempts: the one guard against a tight loop,
 * and short enough that a pool that frees up is used within a minute.
 */
export const REFUSAL_BACKOFF_MAX_MS = 60_000;

/** Wait before the `attempt`th retry of a refusal (1-based). */
export function refusalBackoffMs(attempt: number): number {
	return Math.min(
		REFUSAL_BACKOFF_MAX_MS,
		REFUSAL_BACKOFF_FIRST_MS * 2 ** Math.max(0, attempt - 1),
	);
}

/** What a waiting agent is waiting on. */
export interface TurnFaultWait {
	kind: "transport" | "refusal";
	/** The node or server. */
	where: string;
	/** The refusal's text, or why the server is gone. */
	detail: string;
}

export interface TurnFaultRecoveryOptions {
	/** The agent, as its row and the log name it. */
	label: string;
	/** Where it runs, for the waiting line: a node label, or undefined. */
	where?: () => string | undefined;
	/** The server's base URL, for the health probe. Absent: back off only. */
	baseUrl?: () => string | undefined;
	headers?: () => Record<string, string> | undefined;
	/** The agent's own stop, on top of the run's. */
	signal?: AbortSignal;
	/** The agent's row. */
	emitUpdate?: (update: unknown) => void;
	logger?: { log: (message: string) => void };
	/**
	 * Placed agents only: whether the engine has admitted this agent. Before
	 * it has, the fault goes back to the spawn queue, which can re-place it.
	 */
	isAdmitted?: () => boolean;
	/** A transport fault was seen: take the node out of rotation for a while. */
	onTransportFault?: () => void;
	/**
	 * Told on every wait, and again on each health probe that finds the server
	 * still gone: what the agent is waiting on. For whoever tracks how long an
	 * agent has been stuck.
	 */
	onWaiting?: (state: TurnFaultWait) => void;
	/** Seams for tests. */
	fetch?: typeof fetch;
	sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
	probe?: (root: string) => Promise<boolean>;
}

function composed(
	...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
	const present = signals.filter(
		(signal): signal is AbortSignal => signal !== undefined,
	);
	if (present.length <= 1) {
		return present[0];
	}
	return AbortSignal.any(present);
}

/** Why the server went away, in the words the row uses. */
export function transportFaultReason(message: string): string {
	return /shutting down|loading model/i.test(message)
		? "server restarted"
		: /\b50[234]\b|bad gateway|gateway time|service unavailable|upstream/i.test(
					message,
				)
			? "its gateway has nothing behind it"
			: /type validation failed|json parsing failed/i.test(message)
				? "the stream it sent could not be read"
				: "not answering";
}

function report(
	emitUpdate: TurnFaultRecoveryOptions["emitUpdate"],
	text: string,
	severity: "warn" | "info",
): void {
	emitUpdate?.({
		latestOutput: text,
		latestOutputKind: "text",
		activity: { text, severity },
	});
}

export function createTurnFaultRecovery(
	options: TurnFaultRecoveryOptions,
): TurnFaultRecovery {
	const sleep = options.sleep ?? sleepUnlessAborted;
	return async (fault: TurnFault): Promise<boolean> => {
		const signal = composed(fault.signal, options.signal);
		if (signal?.aborted) {
			return false;
		}
		if (options.isAdmitted && !options.isAdmitted()) {
			return false;
		}
		const where = options.where?.() ?? "the server";
		if (fault.kind === "transport") {
			options.onTransportFault?.();
			// The server may come back as a new one, without the pools this
			// agent's tree names: its next attach asks first (PolyKV only; a
			// no-op on any other server).
			const faulted = options.baseUrl?.();
			if (faulted) {
				notePolykvServerFault(faulted);
			}
			const reason = transportFaultReason(fault.message);
			const line = `Waiting for ${where} to come back (${reason}); the turn is sent again once it answers.`;
			options.logger?.log(
				`[Agents] ${options.label}: ${fault.message} -- ${line}`,
			);
			report(options.emitUpdate, line, "warn");
			options.onWaiting?.({ kind: "transport", where, detail: reason });
			const root = serverRoot(options.baseUrl?.());
			if (root) {
				const headers = options.headers?.();
				await waitForServerHealth(root, {
					...(options.fetch ? { fetch: options.fetch } : {}),
					...(headers ? { headers } : {}),
					...(signal ? { signal } : {}),
					...(options.sleep ? { sleep: options.sleep } : {}),
					...(options.probe ? { probe: options.probe } : {}),
					onProbe: (probes) => {
						if (probes > 0) {
							options.onWaiting?.({
								kind: "transport",
								where,
								detail: reason,
							});
						}
					},
				});
				// Answering again is not proof the fault is gone. A stream the
				// SDK could not read comes from a server whose /health is fine,
				// and a retry sent at once fetches the same bad frame in a tight
				// loop. The first retry goes at once, as after a restart; a
				// fault that repeats backs off like a refusal, to the minute.
				if (fault.attempt > 1 && !signal?.aborted) {
					await sleep(refusalBackoffMs(fault.attempt - 1), signal);
				}
			} else {
				// No address to ask (a cloud provider): back off instead.
				await sleep(refusalBackoffMs(fault.attempt), signal);
			}
		} else {
			const waitMs = refusalBackoffMs(fault.attempt);
			const line = `${where} refused the turn (${fault.message.trim().slice(0, 200)}); trying again in ${Math.round(waitMs / 1000)} s (refusal ${fault.attempt}).`;
			options.logger?.log(`[Agents] ${options.label}: ${line}`);
			// A refusal is pacing, not a fault: info, like the spawn-time one.
			report(options.emitUpdate, line, "info");
			options.onWaiting?.({
				kind: "refusal",
				where,
				detail: fault.message,
			});
			await sleep(waitMs, signal);
		}
		if (signal?.aborted) {
			return false;
		}
		report(
			options.emitUpdate,
			`${where} answered; sending the turn again.`,
			"info",
		);
		return true;
	};
}

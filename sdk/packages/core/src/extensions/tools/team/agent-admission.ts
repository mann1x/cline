/**
 * Asking the engine whether one more agent fits, before spending a prefill
 * finding out that it does not.
 *
 * opencoti's admission gate refuses a saturated pool with `429` + `Retry-After`,
 * and the retry middleware in `@cline/llms` waits that out. This is the other
 * half, and the better one: a request that is going to be refused is a request
 * worth not sending. `GET /polykv/pools/{id}/capacity` answers directly --
 * `can_admit`, and `headroom_sessions` for how many more the pool will take --
 * which is the contract the reference fan-out node is built on (FS-H1:
 * "bounds the round by /capacity -- headroom_sessions caps, hard reject holds
 * all").
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: on c7, every `GET /capacity` folds
 * the settle and bias EWMAs. It is not a read -- it advances the learner. A
 * client that polls it corrupts the measurement it is asking for, and then acts
 * on the corrupted answer. So capacity is read exactly once per round, where a
 * round is the burst of spawns between one quiescent point and the next, and
 * the agents in that round draw from that one answer. Nothing else in this
 * codebase may call it. (c8 makes the GET read-only and moves the fold behind
 * `?fold=1`; this file does not need to change when it does, it just stops
 * being load-bearing.)
 *
 * A hold is not a failure. The engine is describing this moment, and a held
 * agent has not started, so there is nothing to fail -- it waits for one of its
 * siblings to finish and goes then. That is the difference between pacing a
 * swarm and killing it, and it is the whole reason this sits before the spawn
 * rather than after the refusal.
 */

import type { PolykvCapacity } from "@cline/llms";

/** What one capacity read says, in the only three terms this file acts on. */
export interface AdmissionCapacity {
	/** Whether the engine would take one more right now. */
	canAdmit: boolean;
	/**
	 * How many more it would take. Negative means the engine has no
	 * measurement yet -- which is NOT "none": clamping `-1` to `0` is what told
	 * an empty server it was full (c8 T9), and it must read as "unbounded by
	 * this signal" instead.
	 */
	headroomSessions: number;
	/**
	 * Why, in the engine's own words. Carried back verbatim: the engine keeps
	 * `elastic_reason` distinct from `kv headroom exhausted` precisely so a
	 * caller can tell "raise --max-parallel" from "this context does not fit",
	 * and collapsing them into one word throws that away.
	 */
	reason: string;
}

/**
 * Read a `/capacity` payload into the three terms this file acts on.
 *
 * Both absences are deliberate readings, not defaults of convenience. A
 * missing `can_admit` is a pool with an advisory policy -- the engine
 * reporting rather than gating -- and reading it as a refusal would hold every
 * agent on a server that never says no. A missing or negative
 * `headroom_sessions` is the engine saying it has no measurement yet, which is
 * the `-1` that must not be clamped to zero (c8 T9).
 */
export function admissionFromCapacity(
	capacity: Partial<PolykvCapacity> | undefined,
): AdmissionCapacity | undefined {
	if (!capacity) {
		return undefined;
	}
	return {
		canAdmit: capacity.can_admit !== false,
		headroomSessions:
			typeof capacity.headroom_sessions === "number"
				? capacity.headroom_sessions
				: -1,
		reason: capacity.reason ?? "",
	};
}

export interface AgentAdmissionController {
	/**
	 * Resolves when this agent may start, having waited however long the
	 * engine's answer required. Rejects only on cancellation.
	 */
	acquire(signal?: AbortSignal): Promise<{ reason: string }>;
	/** Called when an admitted agent finishes, however it finished. */
	release(): void;
}

interface AdmissionLogger {
	log?(message: string, meta?: Record<string, unknown>): void;
}

export interface AgentAdmissionOptions {
	/**
	 * One capacity read. `undefined` for "could not be asked" -- an unreachable
	 * control plane, or an endpoint with no pool -- which admits rather than
	 * holds, matching the engine's own default when its internal capacity check
	 * fails (it warns and admits; only `--polykv-adm-on-error deny` refuses).
	 */
	capacity: () => Promise<AdmissionCapacity | undefined>;
	/**
	 * How long a held agent waits before asking again, when no sibling is
	 * running to release it.
	 *
	 * Only reached when the whole round is held and nothing is outstanding, so
	 * there is no release coming. Long enough that re-asking does not become
	 * the poll this file forbids.
	 */
	holdRetryMs?: number;
	logger?: AdmissionLogger;
	/** Seam for tests; the real one is abort-aware. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const DEFAULT_ADMISSION_HOLD_RETRY_MS = 2_000;

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (ms <= 0 || signal?.aborted) {
			resolve();
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function createAgentAdmissionController(
	options: AgentAdmissionOptions,
): AgentAdmissionController {
	const holdRetryMs = Math.max(
		0,
		options.holdRetryMs ?? DEFAULT_ADMISSION_HOLD_RETRY_MS,
	);
	const wait = options.sleep ?? realSleep;
	const logger = options.logger;

	/**
	 * What is left of the current round's answer.
	 *
	 * `undefined` means there is no live round and the next acquirer reads
	 * capacity. `Infinity` is a round the engine did not bound -- an
	 * uncomputable headroom, or a control plane that could not be asked.
	 */
	let remaining: number | undefined;
	let lastReason = "";
	let outstanding = 0;
	const waiters: Array<() => void> = [];

	/** Wake one held acquirer, if any is waiting. */
	const wake = (): void => {
		waiters.shift()?.();
	};

	/**
	 * Wait for a sibling to finish, or for the hold timer -- whichever comes
	 * first. The timer is what keeps a fully-held round from deadlocking: with
	 * nothing outstanding, no release is ever coming.
	 */
	const holdOnce = async (signal: AbortSignal | undefined): Promise<void> => {
		let woken: (() => void) | undefined;
		const released = new Promise<void>((resolve) => {
			woken = resolve;
			if (woken) {
				waiters.push(woken);
			}
		});
		await Promise.race([released, wait(holdRetryMs, signal)]);
		const index = woken ? waiters.indexOf(woken) : -1;
		if (index >= 0) {
			// The timer won; take our waiter back out so a later release is not
			// spent waking someone who has already gone round again.
			waiters.splice(index, 1);
		}
	};

	return {
		acquire: async (signal) => {
			for (;;) {
				if (signal?.aborted) {
					throw new Error("Admission wait cancelled");
				}
				if (remaining === undefined) {
					let read: AdmissionCapacity | undefined;
					try {
						read = await options.capacity();
					} catch (error) {
						// A control plane that cannot be reached has not said
						// no. Holding every agent on it would be a worse
						// failure than the refusal this avoids.
						logger?.log?.(
							"PolyKV capacity could not be read; admitting without it",
							{
								severity: "warn",
								error: error instanceof Error ? error.message : String(error),
							},
						);
						read = undefined;
					}
					if (read === undefined) {
						remaining = Number.POSITIVE_INFINITY;
						lastReason = "capacity unavailable; not holding";
					} else if (!read.canAdmit) {
						lastReason = read.reason;
						logger?.log?.("PolyKV is holding the round", {
							severity: "info",
							reason: read.reason,
							headroomSessions: read.headroomSessions,
						});
						await holdOnce(signal);
						continue;
					} else {
						lastReason = read.reason;
						remaining =
							read.headroomSessions < 0
								? Number.POSITIVE_INFINITY
								: Math.max(1, read.headroomSessions);
					}
				}
				if (remaining > 0) {
					remaining -= 1;
					outstanding += 1;
					return { reason: lastReason };
				}
				// The round is spent. The next answer must be a fresh read: the
				// agents that emptied it have changed the thing being measured.
				remaining = undefined;
				await holdOnce(signal);
			}
		},
		release: () => {
			if (outstanding > 0) {
				outstanding -= 1;
			}
			wake();
		},
	};
}

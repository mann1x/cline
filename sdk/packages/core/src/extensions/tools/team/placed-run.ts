/**
 * One delegated agent through the spawn queue: placed, run, and put back at
 * the head of the queue when the spawn itself failed.
 *
 * Three spawn paths -- `spawn_agent`, a configured `subagent_*` tool, and a
 * swarm worker -- each carried their own copy of place / run / re-place, and
 * they had drifted: only two re-queued a node that lacked the model, none
 * re-queued a refusal, and a re-placed agent went to the BACK of the queue,
 * behind agents asked for after it.
 *
 * What counts as the spawn failing is decided by one fact: whether the engine
 * admitted the agent. Admission is its first output -- any content starting --
 * and before that nothing has happened that re-running would repeat: no tool
 * ran, no file changed, no token was generated. So a failure before it is the
 * spawn's, and the agent goes back to the front and is placed again, on
 * whichever node has room next. A failure after it is the agent's own and
 * travels to the caller untouched: re-running an agent that has started would
 * redo its side effects.
 *
 * The admission report is also what paces an uncapped node: it takes its next
 * agent only when this one is admitted (see `agent-placement-queue`).
 */
import { serverHealthBackoffMs, sleepUnlessAborted } from "@cline/llms";
import {
	type AgentEvent,
	type AgentResult,
	classifyTurnFault,
	classifyTurnFaultError,
	type TurnFaultRecovery,
} from "@cline/shared";
import type {
	AgentNodePlacement,
	PlacedAgentNode,
} from "./agent-node-placement";
import {
	MAX_NODE_PLACEMENT_ATTEMPTS,
	NODE_MODEL_MISSING_COOL_OFF_MS,
} from "./agent-placement-queue";
import {
	isGatewayDown,
	isGatewayDownRun,
	isNodeUnreachable,
	isWastedNodeRun,
} from "./node-reachability";
import {
	reportSubagentPlaced,
	reportSubagentQueued,
} from "./subagent-progress";
import {
	createTurnFaultRecovery,
	type TurnFaultWait,
} from "./turn-fault-recovery";

/**
 * How many times one agent may be refused and re-queued.
 *
 * A refusal is the engine describing this moment, so it is retried rather
 * than reported -- but not forever: a server that refuses every attempt for
 * ten minutes (at the 5 s hold, and sooner when an agent there finishes) is
 * saying something the agent should report instead of waiting on.
 */
export const MAX_REFUSED_REQUEUES = 120;

const REFUSAL = [
	/\b429\b/,
	/too many requests/i,
	/rate[ _-]?limit/i,
	/admission (?:rejected|refused)/i,
	/\bsaturated\b/i,
	// The pool owner's window, full until one of its workers finishes.
	/session allocation full/i,
];

function messageChain(value: unknown, depth = 0): string[] {
	if (depth > 4 || value === null || value === undefined) {
		return [];
	}
	if (typeof value === "string") {
		return [value];
	}
	if (typeof value !== "object") {
		return [];
	}
	const message = (value as { message?: unknown }).message;
	const status =
		(value as { status?: unknown; statusCode?: unknown }).status ??
		(value as { statusCode?: unknown }).statusCode;
	return [
		...(typeof message === "string" ? [message] : []),
		...(status === 429 ? ["429"] : []),
		...messageChain((value as { cause?: unknown }).cause, depth + 1),
	];
}

/**
 * The engine said no to starting this agent: a 429 from the admission gate, or
 * the pool owner's window being full.
 *
 * Read from a thrown error, or from a run that ended in error having spent
 * nothing -- the two shapes a refusal reaches a spawn path in, depending on
 * whether the agent loop caught it.
 */
export function isRefusedSpawn(outcome: unknown): boolean {
	const result = outcome as Partial<AgentResult> | undefined;
	if (
		result &&
		typeof result === "object" &&
		"finishReason" in result &&
		result.finishReason === "error" &&
		(result.usage?.outputTokens ?? 0) === 0
	) {
		const text = String(result.text ?? "");
		return REFUSAL.some((pattern) => pattern.test(text));
	}
	return messageChain(outcome).some((text) =>
		REFUSAL.some((pattern) => pattern.test(text)),
	);
}

/** What the engine said when it refused, for a person to read. */
export function refusalReason(outcome: unknown): string {
	const result = outcome as Partial<AgentResult> | undefined;
	const text =
		result && typeof result === "object" && typeof result.text === "string"
			? result.text
			: messageChain(outcome)[0];
	return (text ?? "no reason given").trim().slice(0, 300);
}

/**
 * A refusal that will not clear by waiting the way a 429 does.
 *
 * Two kinds, both seen live (pandorum swarm, 2026-09-23): the pool cannot fit
 * the request — `context allocation exhausted (largest admissible N < peak M)` —
 * and the endpoint is estimated too slow for the concurrency — `projected mean
 * tps below floor`. A 429 or a full window frees when a sibling finishes; these
 * do not, because the request's own size and the endpoint's own speed are what
 * they are. Re-queuing them to the front forever is the livelock this guards.
 */
const DURABLE_REFUSAL = [
	/context allocation exhausted/i,
	/projected mean tps below floor/i,
];

export function isDurableRefusal(outcome: unknown): boolean {
	const result = outcome as Partial<AgentResult> | undefined;
	const text =
		result && typeof result === "object" && typeof result.text === "string"
			? result.text
			: messageChain(outcome).join(" ");
	return DURABLE_REFUSAL.some((pattern) => pattern.test(text ?? ""));
}

/**
 * The KV the pool could admit at the moment it refused, from `largest
 * admissible N`, or undefined when the refusal did not state one.
 *
 * It is the one signal that says whether waiting is worth it: a number that
 * climbs across refusals means siblings are finishing and space is opening, so
 * the next attempt might fit; a number that does not move is a pool that is
 * stuck — in the deadlock case every worker holds nothing and waits, so nothing
 * finishes to free the cells the next worker needs.
 */
export function admissionHeadroom(outcome: unknown): number | undefined {
	const result = outcome as Partial<AgentResult> | undefined;
	const text =
		result && typeof result === "object" && typeof result.text === "string"
			? result.text
			: messageChain(outcome).join(" ");
	const match = /largest admissible\s+(\d+)/i.exec(text ?? "");
	return match ? Number(match[1]) : undefined;
}

/**
 * Consecutive durable refusals whose headroom did not grow before a worker
 * stops waiting and reports the refusal instead.
 *
 * Small on purpose. A pool that is going to free space for this request shows
 * it by the admissible figure climbing; one that refuses with the same figure
 * this many times running is not draining, and every extra attempt only starves
 * the siblings that could have. At the queue's ~5 s place hold this is on the
 * order of a minute — long enough to ride out a brief stall, short enough that a
 * genuine deadlock is reported rather than spun on (it spun for twelve hours).
 */
export const MAX_STALLED_DURABLE_REFUSALS = 8;

/**
 * The attempt never reached a server that could run it: a refused or reset
 * connection, a gateway with nothing behind it, or a server going down. Read
 * from a thrown error or from a run that ended in error having spent nothing.
 */
export function isTransportFailure(
	outcome: { result: AgentResult } | { error: unknown },
): boolean {
	if ("error" in outcome) {
		return (
			isNodeUnreachable(outcome.error) ||
			isGatewayDown((outcome.error as { message?: unknown } | null)?.message) ||
			classifyTurnFaultError(outcome.error) === "transport"
		);
	}
	const result = outcome.result;
	return (
		isGatewayDownRun(result) ||
		(result.finishReason === "error" &&
			(result.usage?.outputTokens ?? 0) === 0 &&
			classifyTurnFault(String(result.text ?? "")) === "transport")
	);
}

/** An event that shows the engine is generating for this agent. */
export function isAdmissionEvent(event: AgentEvent): boolean {
	return event.type === "content_start";
}

export interface PlacedRunInput {
	placement: AgentNodePlacement;
	signal?: AbortSignal;
	emitUpdate?: (update: unknown) => void;
	logger?: { log: (message: string) => void };
	/** How the agent is named in the log lines. */
	label: string;
	/**
	 * Build the agent for this node and run it. `admitted` is to be called on
	 * its first output; {@link isAdmissionEvent} says which event that is.
	 *
	 * `recoverTurnFault` is to be given to the agent (`AgentConfig`): it waits
	 * out a turn the server dropped or refused once the engine has admitted the
	 * agent, and declines before that, so the failure comes back here and the
	 * agent is placed again.
	 */
	run: (
		placed: PlacedAgentNode,
		admitted: () => void,
		recoverTurnFault: TurnFaultRecovery,
	) => Promise<AgentResult>;
	/** Told whenever the agent is waiting on a fault or a refusal. */
	onWaiting?: (state: TurnFaultWait) => void;
	/** Seam for tests: the backoff between re-placements. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Between a failed spawn and the next placement: close its engine session. */
	beforeRetry?: () => Promise<void>;
}

export interface PlacedRunOutcome {
	result: AgentResult;
	/** Where it finally ran. */
	placed: Pick<PlacedAgentNode, "nodeId" | "nodeLabel">;
}

export async function runPlacedAgent(
	input: PlacedRunInput,
): Promise<PlacedRunOutcome> {
	let refusals = 0;
	let nodeFailures = 0;
	let transportFailures = 0;
	let front = false;
	// Deadlock guard: the best admissible headroom a durable refusal has stated,
	// and how many durable refusals in a row have failed to beat it.
	let bestHeadroom = -1;
	let stalledDurable = 0;
	for (;;) {
		reportSubagentQueued(input.emitUpdate);
		const placed = await input.placement.place(
			input.signal,
			front ? { front: true } : undefined,
		);
		reportSubagentPlaced(input.emitUpdate, placed);
		let admitted = false;
		const admit = (): void => {
			if (!admitted) {
				admitted = true;
				placed.admitted();
			}
		};

		const where = placed.nodeLabel ?? placed.nodeId;
		const recoverTurnFault = createTurnFaultRecovery({
			label: input.label,
			where: () => where,
			baseUrl: () => placed.configProvider?.getConnectionConfig?.().baseUrl,
			headers: () => placed.configProvider?.getConnectionConfig?.().headers,
			...(input.signal ? { signal: input.signal } : {}),
			...(input.emitUpdate ? { emitUpdate: input.emitUpdate } : {}),
			...(input.logger ? { logger: input.logger } : {}),
			...(input.onWaiting ? { onWaiting: input.onWaiting } : {}),
			isAdmitted: () => admitted,
			// The node went away under a running agent: the next agent should
			// not be sent there until it answers again.
			onTransportFault: () => placed.markUnreachable(),
		});

		let outcome: { result: AgentResult } | { error: unknown };
		try {
			outcome = {
				result: await placed.run(() =>
					input.run(placed, admit, recoverTurnFault),
				),
			};
		} catch (error) {
			outcome = { error };
		}
		const failure = "error" in outcome ? outcome.error : outcome.result;

		if (!admitted && !input.signal?.aborted) {
			if (isRefusedSpawn(failure) && refusals < MAX_REFUSED_REQUEUES) {
				// Is waiting still worth it? A durable refusal whose stated
				// headroom is not growing is a pool that will not fit this request
				// and is not draining; a transient one (a 429, a full window) can
				// clear on its own and does not count toward the guard.
				if (isDurableRefusal(failure)) {
					const headroom = admissionHeadroom(failure);
					if (headroom !== undefined && headroom > bestHeadroom) {
						bestHeadroom = headroom;
						stalledDurable = 0;
					} else {
						stalledDurable += 1;
					}
				} else {
					stalledDurable = 0;
				}
				if (stalledDurable < MAX_STALLED_DURABLE_REFUSALS) {
					refusals += 1;
					placed.refused();
					input.logger?.log(
						`[Agents] ${where} refused ${input.label} before starting it; back to the front of the queue (refusal ${refusals})`,
					);
					// On the agent's row as well as in the log: a refused agent
					// otherwise looks exactly like one that is working, and the
					// only place the engine's reason appeared was a log file.
					const refusedLine = `${where} refused it (refusal ${refusals} of ${MAX_REFUSED_REQUEUES}): ${refusalReason(failure)}`;
					input.emitUpdate?.({
						latestOutput: refusedLine,
						latestOutputKind: "text",
						activity: { text: refusedLine, severity: "warn" },
					});
					await input.beforeRetry?.().catch(() => undefined);
					front = true;
					continue;
				}
				// The pool is not draining for this request. Report the refusal to
				// the lead — which can shrink the round or free the pool — rather
				// than re-queuing it and starving the siblings that might free
				// space. Measured before this guard: 126 identical refusals over
				// twelve hours, "largest admissible 160" never once moving.
				input.logger?.log(
					`[Agents] ${where} cannot admit ${input.label}: ${refusalReason(failure)} — reported after ${stalledDurable} refusals with no headroom gained`,
				);
				const stalledLine = `${where} could not admit it (${refusalReason(failure)}); the pool is not freeing up — reported instead of waiting`;
				input.emitUpdate?.({
					latestOutput: stalledLine,
					latestOutputKind: "text",
					activity: { text: stalledLine, severity: "warn" },
				});
			}
			const unreachable = isTransportFailure(outcome);
			const wasted = "result" in outcome && isWastedNodeRun(outcome.result);
			// A node that went away is waited out without limit -- the agent
			// is placed again, on whichever node answers -- because a restart
			// is not the agent failing. A node without the model is a
			// configuration, and three of those in a row is the agent's own
			// failure (see MAX_NODE_PLACEMENT_ATTEMPTS).
			if (
				unreachable ||
				(wasted && nodeFailures < MAX_NODE_PLACEMENT_ATTEMPTS - 1)
			) {
				if (unreachable) {
					transportFailures += 1;
					input.onWaiting?.({
						kind: "transport",
						where,
						detail: "not answering",
					});
				} else {
					nodeFailures += 1;
				}
				placed.markUnreachable(
					wasted ? NODE_MODEL_MISSING_COOL_OFF_MS : undefined,
				);
				placed.release();
				input.logger?.log(
					`[Agents] ${where} cannot run ${input.label} (${
						wasted
							? String((outcome as { result: AgentResult }).result.text).slice(
									0,
									120,
								)
							: "unreachable"
					}); back to the front of the queue`,
				);
				const failedLine = `${where} could not run it (${
					wasted ? "it does not have the model" : "the node is not answering"
				}); waiting for another node`;
				input.emitUpdate?.({
					latestOutput: failedLine,
					latestOutputKind: "text",
					activity: { text: failedLine, severity: "warn" },
				});
				await input.beforeRetry?.().catch(() => undefined);
				// Every node down at once must not become a tight loop: the
				// first retry goes straight to another node, and each one after
				// it waits longer, up to the health probe's 30 s.
				if (unreachable && transportFailures > 1) {
					await (input.sleep ?? sleepUnlessAborted)(
						serverHealthBackoffMs(transportFailures - 2),
						input.signal,
					);
				}
				front = true;
				continue;
			}
		}

		if ("error" in outcome) {
			// A node nothing could connect to is a node the next agent should
			// not be sent to either.
			if (isNodeUnreachable(outcome.error)) {
				placed.markUnreachable();
			}
			placed.release();
			throw outcome.error;
		}
		placed.release();
		return {
			result: outcome.result,
			placed: {
				nodeId: placed.nodeId,
				...(placed.nodeLabel ? { nodeLabel: placed.nodeLabel } : {}),
			},
		};
	}
}

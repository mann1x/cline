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
	NODE_REFUSED_HOLD_MS,
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
 * Longest a node is held after refusing an agent that has not started, when
 * none of its agents finishes first.
 *
 * A refusal is never the agent's result, however many there are: ruled after
 * 1tmrl, where 13 agents were never admitted and became "projected mean tps
 * below floor" as their final answer. What stops a refused agent from
 * hammering the node is the hold, which grows from the queue's 5 s with each
 * refusal in a row to this, and ends early the moment one of the node's own
 * agents finishes -- the room the refusal was waiting for.
 */
export const REFUSED_HOLD_MAX_MS = 60_000;

/** The hold after the `refusals`th consecutive refusal (1-based). */
export function refusedHoldMs(refusals: number): number {
	return Math.min(
		REFUSED_HOLD_MAX_MS,
		NODE_REFUSED_HOLD_MS * 2 ** Math.max(0, refusals - 1),
	);
}

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
		return [...REFUSAL, ...DURABLE_REFUSAL].some((pattern) =>
			pattern.test(text),
		);
	}
	return messageChain(outcome).some((text) =>
		[...REFUSAL, ...DURABLE_REFUSAL].some((pattern) => pattern.test(text)),
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
 * clear more slowly, as the pool drains or the endpoint's load falls.
 *
 * Still never the agent's result (ruled after 1tmrl): they are waited out with
 * a hold that grows to {@link REFUSED_HOLD_MAX_MS}, so a pool that is not
 * draining is asked once a minute rather than spun on, and after long enough
 * the lead is told (see `agent-trouble.ts`) and may take the task back. The
 * thresholds behind them -- the tps floor, the allocation -- are the user's
 * settings and are never changed from here.
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
	// The best admissible headroom a durable refusal has stated, and how many
	// refusals in a row have failed to beat it: what the node's hold grows by.
	let bestHeadroom = -1;
	let stalledRefusals = 0;
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
			if (isRefusedSpawn(failure)) {
				// The hold grows while the refusals do not change: a durable
				// refusal whose stated headroom is climbing is a pool that is
				// draining, and the next try is worth making sooner.
				const headroom = isDurableRefusal(failure)
					? admissionHeadroom(failure)
					: undefined;
				if (headroom !== undefined && headroom > bestHeadroom) {
					bestHeadroom = headroom;
					stalledRefusals = 1;
				} else {
					stalledRefusals += 1;
				}
				refusals += 1;
				const holdMs = refusedHoldMs(stalledRefusals);
				placed.refused(holdMs);
				input.onWaiting?.({
					kind: "refusal",
					where,
					detail: refusalReason(failure),
				});
				input.logger?.log(
					`[Agents] ${where} refused ${input.label} before starting it; back to the front of the queue, the node held up to ${Math.round(holdMs / 1000)} s (refusal ${refusals})`,
				);
				// On the agent's row as well as in the log: a refused agent
				// otherwise looks exactly like one that is working, and the
				// only place the engine's reason appeared was a log file.
				// Not a warning: an admission refusal is the engine pacing its
				// load, and waiting it out is the normal path (user ruling
				// 2026-09-25). The row says what it is waiting for, plainly.
				const refusedLine = `${where} refused it (refusal ${refusals}): ${refusalReason(failure)}; waiting for room, then trying again`;
				input.emitUpdate?.({
					latestOutput: refusedLine,
					latestOutputKind: "text",
					activity: { text: refusedLine },
				});
				await input.beforeRetry?.().catch(() => undefined);
				front = true;
				continue;
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
					// A node without the model is a configuration fault; one that
					// is not answering is a wait, and says so without alarm.
					activity: wasted
						? { text: failedLine, severity: "warn" }
						: { text: failedLine },
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

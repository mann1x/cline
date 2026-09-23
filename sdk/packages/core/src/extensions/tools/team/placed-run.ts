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
import type { AgentEvent, AgentResult } from "@cline/shared";
import type {
	AgentNodePlacement,
	PlacedAgentNode,
} from "./agent-node-placement";
import {
	MAX_NODE_PLACEMENT_ATTEMPTS,
	NODE_MODEL_MISSING_COOL_OFF_MS,
} from "./agent-placement-queue";
import { isNodeUnreachable, isWastedNodeRun } from "./node-reachability";
import {
	reportSubagentPlaced,
	reportSubagentQueued,
} from "./subagent-progress";

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
	 */
	run: (placed: PlacedAgentNode, admitted: () => void) => Promise<AgentResult>;
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
	let front = false;
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

		let outcome: { result: AgentResult } | { error: unknown };
		try {
			outcome = { result: await placed.run(() => input.run(placed, admit)) };
		} catch (error) {
			outcome = { error };
		}
		const failure = "error" in outcome ? outcome.error : outcome.result;
		const where = placed.nodeLabel ?? placed.nodeId;

		if (!admitted && !input.signal?.aborted) {
			if (isRefusedSpawn(failure) && refusals < MAX_REFUSED_REQUEUES) {
				refusals += 1;
				placed.refused();
				input.logger?.log(
					`[Agents] ${where} refused ${input.label} before starting it; back to the front of the queue (refusal ${refusals})`,
				);
				// On the agent's row as well as in the log: a refused agent
				// otherwise looks exactly like one that is working, and the
				// only place the engine's reason appeared was a log file.
				input.emitUpdate?.({
					latestOutput: `${where} refused it (refusal ${refusals} of ${MAX_REFUSED_REQUEUES}): ${refusalReason(failure)}`,
					latestOutputKind: "text",
				});
				await input.beforeRetry?.().catch(() => undefined);
				front = true;
				continue;
			}
			const unreachable =
				"error" in outcome && isNodeUnreachable(outcome.error);
			const wasted = "result" in outcome && isWastedNodeRun(outcome.result);
			if (
				(unreachable || wasted) &&
				nodeFailures < MAX_NODE_PLACEMENT_ATTEMPTS - 1
			) {
				nodeFailures += 1;
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
				await input.beforeRetry?.().catch(() => undefined);
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

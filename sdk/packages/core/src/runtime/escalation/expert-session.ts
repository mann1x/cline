/**
 * The expert's side of an escalation: one conversation, held or closed.
 *
 * An escalation is not a single question. The session's model states a goal and
 * a scope, the expert answers, the model checks the answer against the task and
 * pushes back if it does not hold — so what the expert needs is a conversation
 * that survives between calls, and what the *host* needs is a decision about
 * whether to keep it.
 *
 * Both answers are right on different hardware, which is why the decision is a
 * setting rather than a default:
 *
 *   held    a hosted provider's prompt cache stays warm and the expert still
 *           has the exchange in its context, so a follow-up sends one message
 *           rather than the whole conversation again. On a metered account that
 *           difference is the bill.
 *   closed  a local server gets its slot back, which is what lets another model
 *           load at all. `OLLAMA_MAX_LOADED_MODELS` is usually 1 or 2, and an
 *           expert held open is a model the session's own cannot replace.
 *
 * The accounting is here rather than left to the host because the expert is the
 * one model whose cost has to be separable. A total that folds the expert's
 * tokens into the session's answers no question anybody has about a paid
 * account, and the generation rate is the provider's own reported figure for
 * the same reason the task header uses it: wall-clock over tokens would fold in
 * queueing and tool time and move when the model did not.
 */
import type { AgentEvent, AgentResult } from "@cline/shared";
import type { AgentSlotGate } from "../../extensions/tools/team/agent-slot-gate";

/**
 * What an escalation spent.
 *
 * Two clocks, deliberately. `generateMs` is what the provider says it spent
 * generating, and is the only honest input to a tok/s figure. `wallMs` is what
 * the escalation actually took, queueing and prompt processing included, and is
 * what a metered account is billed for.
 */
export interface ExpertUsage {
	inputTokens: number;
	outputTokens: number;
	/** Tokens generated across the requests whose provider timed itself. */
	generateTokens: number;
	/** Milliseconds those requests spent generating, by the provider's clock. */
	generateMs: number;
	/** Wall-clock the expert was running, by ours. */
	wallMs: number;
	/** Turns asked of the expert, the first brief included. */
	requests: number;
}

/**
 * What the expert has done so far in the turn that is still running.
 *
 * A hand-over is one tool call from the base model's point of view, so the
 * chat has nothing to say between the brief and the delivery -- and an expert
 * that reads a file twelve times over twenty minutes looks exactly like a hung
 * request. This is what makes the difference visible while it is still true.
 */
export interface ExpertProgress {
	/** Tool calls the expert has completed in this turn. */
	toolCalls: number;
	/** The last one's name, when the event carried it. */
	lastTool?: string;
	/** What the turn has spent so far, wall-clock included. */
	usage: ExpertUsage;
}

export interface ExpertReply {
	text: string;
	iterations: number;
	finishReason?: string;
	/** What this turn alone spent. */
	usage: ExpertUsage;
}

/**
 * The part of a session runtime an escalation uses.
 *
 * Narrow on purpose: `SessionRuntime` satisfies it structurally, and a test can
 * satisfy it without a provider, a model or a network.
 */
export interface ExpertRuntime {
	run(prompt: string): Promise<AgentResult>;
	shutdown?(reason?: string): Promise<void>;
	abort?(reason?: unknown): void;
}

export interface ExpertSessionOptions {
	/**
	 * Builds the expert's runtime, once, on the first ask.
	 *
	 * Deferred rather than taken as a value so that configuring an expert costs
	 * nothing until one is actually called — on a local server, constructing it
	 * is what loads the model.
	 */
	open: (context: {
		onEvent: (event: AgentEvent) => void;
	}) => Promise<ExpertRuntime>;
	/** Follow-ups allowed after the first delivery. */
	maxFollowUps: number;
	/**
	 * The endpoint's slot gate, when the host resolved one.
	 *
	 * A local server queues a request that finds no free slot rather than
	 * refusing it, and says nothing while it does, so an ungated expert call
	 * reads as a slow run rather than a blocked one.
	 */
	gate?: Pick<AgentSlotGate, "run" | "active">;
	/**
	 * Called as the expert works, not only when it answers.
	 *
	 * Fires on every completed tool call and on every usage event the provider
	 * sends, which is as often as the expert gives anyone anything to report.
	 */
	onProgress?: (progress: ExpertProgress) => void;
}

export interface ExpertSession {
	/** Answers the expert has actually produced. A failed run is not one. */
	readonly deliveries: number;
	/** Deliveries after the first. The brief itself is not a follow-up. */
	readonly followUps: number;
	readonly closed: boolean;
	/** Everything this conversation has spent so far. */
	readonly usage: ExpertUsage;
	ask(message: string): Promise<ExpertReply>;
	/** Ends the conversation and releases the endpoint's slot. Idempotent. */
	close(reason?: string): Promise<void>;
}

function emptyUsage(): ExpertUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		generateTokens: 0,
		generateMs: 0,
		wallMs: 0,
		requests: 0,
	};
}

export function createExpertSession(
	options: ExpertSessionOptions,
): ExpertSession {
	const total = emptyUsage();
	let turn = emptyUsage();
	let runtime: ExpertRuntime | undefined;
	let deliveries = 0;
	let closed = false;
	let turnToolCalls = 0;
	let askStartedAt: number | undefined;

	// Provider timings arrive as events during the run rather than on its
	// result, which is also where the task header's own rate comes from. Only
	// some providers report them; the token counts do not depend on it.
	const onEvent = (event: AgentEvent): void => {
		if (event.type === "content_end" && event.contentType === "tool") {
			turnToolCalls += 1;
			report(event.toolName);
			return;
		}
		if (event.type !== "usage") {
			return;
		}
		turn.inputTokens += event.inputTokens ?? 0;
		turn.outputTokens += event.outputTokens ?? 0;
		const timings = event.timings;
		if (timings?.generateTokens && timings.generateMs) {
			turn.generateTokens += timings.generateTokens;
			turn.generateMs += timings.generateMs;
		}
		report();
	};

	/**
	 * Hands out what the turn has spent so far.
	 *
	 * The wall-clock is computed here rather than read off `turn`, which only
	 * learns it when the turn ends -- and a progress line whose elapsed time is
	 * zero until the work is over is the thing this exists to replace.
	 */
	const report = (lastTool?: string): void => {
		if (!options.onProgress || askStartedAt === undefined) {
			return;
		}
		options.onProgress({
			toolCalls: turnToolCalls,
			...(lastTool ? { lastTool } : {}),
			usage: { ...turn, wallMs: Date.now() - askStartedAt, requests: 1 },
		});
	};

	return {
		get deliveries() {
			return deliveries;
		},
		get followUps() {
			return Math.max(0, deliveries - 1);
		},
		get closed() {
			return closed;
		},
		get usage() {
			return { ...total };
		},
		async ask(message: string): Promise<ExpertReply> {
			if (closed) {
				throw new Error(
					"This expert conversation is closed. Escalate again to open a new one.",
				);
			}
			// Counted against deliveries already made, so the brief is free and
			// the cap bounds the back-and-forth after it.
			if (deliveries > 0 && deliveries - 1 >= options.maxFollowUps) {
				throw new Error(
					`The expert has already answered ${options.maxFollowUps} follow-up${
						options.maxFollowUps === 1 ? "" : "s"
					}, which is the limit. Act on what it has given you, or escalate again with a narrower question.`,
				);
			}
			if (!runtime) {
				runtime = await options.open({ onEvent });
			}
			turn = emptyUsage();
			turnToolCalls = 0;
			const startedAt = Date.now();
			askStartedAt = startedAt;
			const result = options.gate
				? await options.gate.run(
						() => runtime?.run(message) as Promise<AgentResult>,
					)
				: await runtime.run(message);
			turn.wallMs = Date.now() - startedAt;
			turn.requests = 1;
			askStartedAt = undefined;
			// The provider's own token counts win where the events reported
			// none: a provider that streams no usage event still answers with a
			// result, and reporting zero tokens for a turn that happened would
			// be worse than reporting the coarser number.
			if (turn.inputTokens === 0 && turn.outputTokens === 0) {
				turn.inputTokens = result.usage?.inputTokens ?? 0;
				turn.outputTokens = result.usage?.outputTokens ?? 0;
			}
			total.inputTokens += turn.inputTokens;
			total.outputTokens += turn.outputTokens;
			total.generateTokens += turn.generateTokens;
			total.generateMs += turn.generateMs;
			total.wallMs += turn.wallMs;
			total.requests += 1;
			// A run that finished on `error` has no answer in it. Its `text` is
			// whatever the provider said going down -- "ollama cloud is
			// disabled: remote model is unavailable" is a real one -- and the
			// caller wraps a reply in "THIS IS A DELIVERY, NOT A VERDICT"
			// before handing it to the base model. Returning it would tell a
			// stuck model that the expert had answered and that this was the
			// answer, which is how one transport failure came back as an empty
			// delivery, cost an escalation, and sent the model back to editing
			// alone. Throw instead: the tool above has a catch that says the
			// escalation did not happen, and the escalation is refunded.
			//
			// The spend stays counted. A run can fail after real work, and a
			// metered account is owed that number whether or not anything came
			// back.
			if (result.finishReason === "error") {
				const reason = result.text?.trim();
				throw new Error(
					`The expert's run failed and produced no answer${
						reason ? `: ${reason}` : "."
					}`,
				);
			}
			deliveries += 1;
			return {
				text: result.text,
				iterations: result.iterations,
				finishReason: result.finishReason,
				usage: { ...turn },
			};
		},
		async close(reason?: string): Promise<void> {
			if (closed) {
				return;
			}
			closed = true;
			// Best-effort: a runtime that fails to shut down cleanly must not
			// leave the session believing an expert is still holding a slot.
			try {
				await runtime?.shutdown?.(reason);
			} catch {
				runtime?.abort?.(reason);
			}
			runtime = undefined;
		},
	};
}

/**
 * What a task is allowed to spend on the expert, and what happens to the
 * conversation between escalations.
 *
 * Two bounds, and they answer different questions. The follow-up cap inside
 * {@link ExpertSession} stops one exchange running away — two models talking to
 * each other until something times out. This one stops a *task* running away:
 * three hand-overs is a model that has been given real help three times and is
 * still stuck, and a fourth is not what that task needs.
 *
 * Running out is not a failure state that needs explaining away. It restores
 * exactly the behaviour every build before this one had: the guards stop the
 * run. The message says so, because a model told only "denied" will spend its
 * remaining turns trying to find the wording that works.
 */
import type { ExpertSession, ExpertUsage } from "./expert-session";

export interface EscalationControllerOptions {
	/** Hand-overs allowed in this task. */
	maxEscalations: number;
	/**
	 * Release the expert's conversation at the end of each escalation.
	 *
	 * See {@link ExpertSession} for why both answers are right on different
	 * hardware. Off means hold.
	 */
	closeAfterEscalation: boolean;
	/** Builds a fresh expert conversation. Called only when one is needed. */
	createSession: () => ExpertSession;
}

export interface EscalationController {
	/** Hand-overs made so far. */
	readonly used: number;
	/** Hand-overs still allowed. */
	readonly remaining: number;
	/** The conversation now open, if any. */
	readonly session: ExpertSession | undefined;
	/** Everything the expert has spent in this task, open conversations included. */
	readonly usage: ExpertUsage;
	/** Spends one escalation and returns the conversation to ask through. */
	begin(): ExpertSession;
	/**
	 * Gives back an escalation that bought nothing.
	 *
	 * A hand-over is charged at {@link begin}, before the expert has been asked
	 * anything, because that is the only place that can refuse one. When the ask
	 * then fails outright -- the endpoint is down, the model is unavailable, the
	 * run finished on `error` -- no expert saw the task and the budget must not
	 * record that it did. Floors at zero: refunding what was never spent would
	 * hand the task a fourth escalation out of a budget of three.
	 *
	 * The conversation goes with it when it has delivered nothing. A held
	 * session that never opened still reads as live to the next `escalate`,
	 * which would then arrive as a follow-up -- the model's raw goal, into an
	 * empty context, instead of the brief a hand-over builds.
	 */
	refund(): Promise<void>;
	/** Ends the current escalation: closes the conversation, or holds it. */
	end(): Promise<void>;
	/** Task teardown. Releases whatever is held, whatever the setting says. */
	dispose(): Promise<void>;
}

function addUsage(into: ExpertUsage, from: ExpertUsage): ExpertUsage {
	return {
		inputTokens: into.inputTokens + from.inputTokens,
		outputTokens: into.outputTokens + from.outputTokens,
		generateTokens: into.generateTokens + from.generateTokens,
		generateMs: into.generateMs + from.generateMs,
		wallMs: into.wallMs + from.wallMs,
		requests: into.requests + from.requests,
		asks: into.asks + from.asks,
	};
}

const ZERO: ExpertUsage = {
	inputTokens: 0,
	outputTokens: 0,
	generateTokens: 0,
	generateMs: 0,
	wallMs: 0,
	requests: 0,
	asks: 0,
};

export function createEscalationController(
	options: EscalationControllerOptions,
): EscalationController {
	// Spend from conversations that have been closed. The open one is added on
	// read, so a held conversation's cost is visible while it is still running
	// rather than appearing all at once when it is released.
	let settled: ExpertUsage = { ...ZERO };
	let session: ExpertSession | undefined;
	let used = 0;

	const controller: EscalationController = {
		get used() {
			return used;
		},
		get remaining() {
			return Math.max(0, options.maxEscalations - used);
		},
		get session() {
			return session;
		},
		get usage() {
			return session ? addUsage(settled, session.usage) : { ...settled };
		},
		begin(): ExpertSession {
			if (controller.remaining <= 0) {
				throw new Error(
					`This task has already escalated ${options.maxEscalations} time${
						options.maxEscalations === 1 ? "" : "s"
					}, which is the limit. There is no expert left to hand this to: finish it yourself, or tell the user what is blocking you.`,
				);
			}
			used += 1;
			if (!session || session.closed) {
				session = options.createSession();
			}
			return session;
		},
		async refund(): Promise<void> {
			used = Math.max(0, used - 1);
			if (!session || session.deliveries > 0) {
				return;
			}
			settled = addUsage(settled, session.usage);
			const closing = session;
			session = undefined;
			try {
				await closing.close("the escalation did not happen");
			} catch {
				// A conversation that will not close cleanly must not leave the
				// task believing an expert is still holding a slot.
			}
		},
		async end(): Promise<void> {
			if (!session) {
				return;
			}
			if (!options.closeAfterEscalation) {
				return;
			}
			// Settled before the close, because a closed conversation reports
			// its own usage and nothing would carry it afterwards.
			settled = addUsage(settled, session.usage);
			const closing = session;
			session = undefined;
			await closing.close("escalation finished");
		},
		async dispose(): Promise<void> {
			if (!session) {
				return;
			}
			settled = addUsage(settled, session.usage);
			const closing = session;
			session = undefined;
			await closing.close("task ended");
		},
	};

	return controller;
}

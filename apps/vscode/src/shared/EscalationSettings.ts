/**
 * The escalation path's budgets and switches.
 *
 * One stored blob rather than four keys, the way the change protocol's own
 * settings travel: the group is edited together, read together, and a new
 * field then costs one line here instead of a plumbing change in seven files.
 *
 * Which model the expert is does NOT live here. That is the Escalation tab's
 * provider snapshot, stored outside `providers.json` beside Vision and Agents,
 * and `escalationModelEnabled` is its switch.
 */
export interface EscalationSettings {
	/**
	 * Ask before each escalation, showing the brief and the harness's own
	 * assessment of why the model says it is stuck.
	 *
	 * Off by default. On, the user sees both accounts side by side -- the
	 * model's own is the one piece of evidence it has an interest in -- and a
	 * refusal spends nothing, because the budget rations the model and a person
	 * saying no is not the model overspending.
	 */
	requireApproval: boolean
	/**
	 * Release the expert's conversation when an escalation ends.
	 *
	 * Off by default, and the two answers are right on different hardware. Held
	 * keeps a hosted provider's prompt cache warm, so a follow-up does not pay
	 * to send the whole exchange again. Released frees the slot a local server
	 * was holding, which is what lets another model load at all.
	 */
	closeAfterEscalation: boolean
	/** Escalations allowed in one task. */
	maxEscalations: number
	/** Follow-ups within one escalation, after the first delivery. */
	maxFollowUps: number
	/**
	 * When a stuck session is offered the expert.
	 *
	 * These decide whether the escalation path is ever taken, and the right
	 * numbers are still being measured -- on one arm (jackod4ac, protocol on,
	 * three runs) the trigger fired zero times, because the change protocol
	 * produces successful tool calls carrying bad verdicts rather than failed
	 * calls, and the behavioural half counts failures. That is a judgement
	 * about someone's own workload, not a constant, so it is theirs to set.
	 *
	 * Zero or absent means "use the built-in default", which is the
	 * corpus-fitted operating point.
	 */
	struggleFailedCalls: number
	/** Distress-lexicon hits in the window that satisfy the lexical half. */
	struggleDistressHits: number
	/** Iterations of history the trigger reads. */
	struggleWindow: number
	/** Before this iteration nothing fires, whatever the evidence says. */
	struggleMinIteration: number
	/** Offers of help per task. */
	struggleMaxPerTask: number
	/**
	 * Consecutive refused edits before the model is told to consider the expert.
	 *
	 * A different measurement from `struggleFailedCalls`, not a smaller one:
	 * that one reads a window of every tool the session called, this one reads
	 * an unbroken run of calls that tried to change a file.
	 */
	struggleEditStreak: number
	/**
	 * Let the base model run while the expert is working.
	 *
	 * Off by default, because on the most common setup it costs real time and
	 * we cannot tell that setup apart from the one where it is free. A local
	 * ollama serves a cloud expert through the same endpoint as the local base,
	 * so "same endpoint" says nothing about whether the two contend, and with
	 * `OLLAMA_MAX_LOADED_MODELS` at its default every alternation between two
	 * local models is an unload and a load. The user knows which of those their
	 * machine is doing; nothing in here can find out.
	 *
	 * OFF is the hand-over this started as: the base waits, and sees the
	 * delivery and nothing else.
	 *
	 * ON is the supervision: batched notes while the expert works, the guards
	 * watching for an expert going in circles, and a message channel in both
	 * directions.
	 */
	alternateWithBase: boolean
	/**
	 * Keep the base running, and relay nothing to it until the delivery.
	 *
	 * Only read when {@link alternateWithBase} is on, and there for the machine
	 * where a model swap is expensive. The base still runs -- it may read, run
	 * the check and think while it stands down from edits, and a steer from the
	 * user still reaches it -- but nothing about the expert's work is relayed
	 * while that work is happening, and nothing is saved up for the end: a
	 * batch is only worth a wake-up while it can still change something.
	 */
	relayNothing: boolean
}

export const DEFAULT_ESCALATION_SETTINGS: EscalationSettings = {
	requireApproval: false,
	closeAfterEscalation: false,
	maxEscalations: 3,
	maxFollowUps: 20,
	// The detector's own corpus-fitted operating point, restated here so the
	// panel shows the number actually in force rather than an empty box. They
	// are kept in step by `escalation-thresholds.test.ts`.
	struggleFailedCalls: 6,
	struggleDistressHits: 2,
	struggleWindow: 10,
	struggleMinIteration: 20,
	struggleMaxPerTask: 2,
	struggleEditStreak: 3,
	alternateWithBase: false,
	relayNothing: false,
}

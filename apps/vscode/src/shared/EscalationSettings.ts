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
}

export const DEFAULT_ESCALATION_SETTINGS: EscalationSettings = {
	requireApproval: false,
	closeAfterEscalation: false,
	maxEscalations: 3,
	maxFollowUps: 20,
}

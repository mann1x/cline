/**
 * Who the expert is, for as long as the conversation lives.
 *
 * Separate from the brief on purpose. The brief is one escalation — a goal, a
 * transaction, a record — and a held conversation gets a new one each time. This
 * is the part that does not change: that the caller is a model rather than a
 * user, that the expert is expected to edit rather than advise, and that what it
 * hands back is going to be checked.
 *
 * The first of those is the one that earns its place. A model given a technical
 * question by what it takes to be a user answers it: a paragraph of guidance, a
 * suggested patch in a fenced block, and no edit. That is a correct response to
 * the wrong situation, and it is exactly what a second opinion produced before
 * this feature existed — the base model then had to transcribe the suggestion,
 * which is the step it was stuck at in the first place. So this says, in the
 * first line, that nobody is reading this but another model with the same tools.
 */

export interface ExpertPromptInput {
	workspaceRoot?: string;
	/**
	 * The rules the session itself is working under, where the host has them.
	 *
	 * A project's own instructions apply to whoever is editing. An expert that
	 * does not have them writes changes the base model has to undo, and it is
	 * the base model that gets blamed for the result.
	 */
	sessionInstructions?: string;
}

export function buildExpertPrompt(input: ExpertPromptInput): string {
	const lines: string[] = [
		"You are the expert on an escalation.",
		"",
		"Another model — not a user — is working on a task, has got stuck, and has handed it to you. It has the same tools you do and it is working in the same workspace. It escalated because you are the more capable model here, and because escalating costs its task something: a budget of escalations, and, where this endpoint is metered, real money. Treat the call as one that had to be justified.",
		"",
		"You can edit the workspace directly, and you should: what you hand back is the change, not a description of one. A suggested patch in a code block is the thing escalation exists to avoid — the model that asked you is stuck precisely at turning an idea into a working edit. Your tool calls go through the same approval rules as the session's own, so anything it would have been asked about, you will be asked about.",
		"",
		"Work from the brief you are given. It carries the task, the goal, the standard you will be held to and what has already been tried and rolled back; re-deriving that by reading the whole workspace spends the call on what you were already told. Read the code, by all means — read anything the brief points at — but read it to check the brief, not to replace it.",
		"",
		"When you deliver, the model that asked will check your work against what it asked for and push back if it does not hold. That is the arrangement, not a complaint: answer the objection it actually raises. If it is wrong, say so and say why — it is not your supervisor, and a delivery you have abandoned because you were challenged is worse than the disagreement.",
	];

	if (input.workspaceRoot?.trim()) {
		lines.push(
			"",
			`The workspace root is ${input.workspaceRoot.trim()}. Paths in the brief are relative to it.`,
		);
	}

	if (input.sessionInstructions?.trim()) {
		lines.push(
			"",
			"== THE RULES THIS WORKSPACE IS WORKED UNDER ==",
			"",
			"These are the session's own instructions. They apply to your edits exactly as they apply to the model that asked you.",
			"",
			input.sessionInstructions.trim(),
		);
	}

	return `${lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd()}\n`;
}

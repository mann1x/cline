/**
 * `escalate` — hand the task to a better model, and pay for it.
 *
 * The description below is the whole feature as far as the model is concerned,
 * and it has to hold two things at once that pull in opposite directions.
 *
 * The expert costs more. It is a bigger model, often on a metered account, often
 * shared, and always slower; a model that reads `escalate` as "ask for help"
 * calls it on its first failed edit and the account pays for a question it could
 * have answered by reading the file.
 *
 * And an expert nobody calls is worth nothing. The measured failure this feature
 * exists for is not over-asking — it is a model looping until a guard ends the
 * run: 25 of 61 jackod4ac runs broken and 5 timed out, with the loop guard
 * ending more of them than any other cohort in the study. A description that
 * only warns about cost produces a model that never escalates and stops anyway,
 * having spent the same hours to fail.
 *
 * So it says both, in that order, and gives concrete conditions rather than a
 * disposition: what to try first, and what being stuck actually looks like.
 */

import { type AgentTool, createTool } from "@cline/shared";

export const ESCALATE_TOOL_NAME = "escalate";

export const ESCALATE_TOOL_DESCRIPTION = `Hand this task to the expert: a larger, more capable model that works in this same workspace and can edit it directly.

WHAT IT COSTS. The expert is more expensive than you are. It may be a paid, metered account, a limited allowance, or hardware shared with other people, and it is slower than you. Your task gets a small, fixed number of escalations and no more. So do not escalate to save yourself reading a file, running the check, or thinking a problem through — that is the work, and it is yours.

WHEN TO USE IT ANYWAY. The expert is there to help, and not calling it is not a virtue. You are not being scored on doing this alone: a task that runs out of turns and stops is a worse outcome than one that cost an escalation and worked. Escalate when you are actually stuck, which looks like this — the same fix attempted and rolled back more than once; a symptom you have read the code for and still cannot explain; a check that keeps failing for a reason you cannot name; or a piece of the task that needs knowledge you do not have. When one of those is true, escalate now rather than after three more attempts: the earlier you hand over, the more budget is left to act on what comes back.

HOW TO USE IT. Say what you want done (\`goal\`) and how you will know it is right (\`expectation\`). Be specific — the expert starts with none of your conversation, only what you write here plus the task, the workspace state and what has already been tried and discarded. Name the files you have been working in (\`files\`).

WHAT COMES BACK. The expert's own account of what it changed and what it ran, as its reply. Read it and check it: run the check yourself, look at the files it says it edited, and satisfy yourself the change is a fix rather than a way around the symptom. You are still the one accountable for this task.

If the delivery does not hold up, say so — call this tool again with \`message\` to push back, quote what you found, and ask for the specific thing that is wrong. That is what the conversation is for, and it is much cheaper than a second escalation. When you are satisfied, call it once more with \`finished: true\` to end the exchange and release the expert.`;

export const ESCALATE_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		goal: {
			type: "string",
			description:
				"What you want the expert to achieve, in your own words. Required when you are starting an escalation. Be concrete: the symptom, what you have already established, and what you want done about it.",
		},
		expectation: {
			type: "string",
			description:
				"What you will accept as a correct delivery, and how you intend to check it. The expert is told this, so it knows what it is being held to.",
		},
		files: {
			type: "array",
			items: { type: "string" },
			description:
				"Files you have been working in, as paths relative to the workspace root. A starting point for the expert, not a boundary.",
		},
		message: {
			type: "string",
			description:
				"Your reply to the expert, once an escalation is open: a push-back on what it delivered, an answer to a question it asked, or a narrower follow-up. Quote what you actually found.",
		},
		finished: {
			type: "boolean",
			description:
				"Set when you are done with the expert. Ends the exchange and releases it. Nothing else ends it, and an exchange left open holds the expert's slot for the rest of the task.",
		},
	},
	required: [],
} as const;

/** What the model asked for, after the input has been read. */
export interface EscalationRequest {
	/** The goal, when this call is opening an escalation. */
	goal?: string;
	expectation?: string;
	files?: string[];
	/** The model's reply, when an exchange is already open. */
	message?: string;
	/** The model says it is done with the expert. */
	finished?: boolean;
}

export interface EscalationExchangeResult {
	/** What the expert said. */
	reply: string;
	/** Whether this call opened an escalation rather than continuing one. */
	opened: boolean;
	followUpsLeft: number;
	escalationsLeft: number;
	/** Whether the exchange is over — because the model said so, or the host. */
	closed?: boolean;
}

export interface EscalateToolOptions {
	/**
	 * Runs the exchange: budget, brief, the expert's conversation, and the
	 * accounting. Owned by the session, as `submit_transaction`'s settle is,
	 * because everything it touches outlives one tool call.
	 */
	consult: (request: EscalationRequest) => Promise<EscalationExchangeResult>;
	onError?: (message: string, error: unknown) => void;
}

function readString(
	input: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = input[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readFiles(input: Record<string, unknown>): string[] | undefined {
	const value = input.files;
	if (!Array.isArray(value)) {
		return undefined;
	}
	const files = value.filter(
		(entry): entry is string =>
			typeof entry === "string" && entry.trim().length > 0,
	);
	return files.length > 0 ? files : undefined;
}

export function readEscalationRequest(input: unknown): EscalationRequest {
	if (!input || typeof input !== "object") {
		return {};
	}
	const record = input as Record<string, unknown>;
	return {
		goal: readString(record, "goal"),
		expectation: readString(record, "expectation"),
		files: readFiles(record),
		message: readString(record, "message"),
		finished: record.finished === true,
	};
}

function describeResult(result: EscalationExchangeResult): string {
	const lines = [result.reply.trim() || "(the expert returned nothing)"];
	lines.push("", "== THIS IS A DELIVERY, NOT A VERDICT ==", "");
	lines.push(
		"Check it before you build on it: run the check yourself, read the files it says it changed, and satisfy yourself that what it did is a fix and not a way around the symptom. You are still the one accountable for this task.",
	);
	if (result.closed) {
		lines.push(
			"",
			`The exchange is closed and the expert has been released. ${
				result.escalationsLeft > 0
					? `${result.escalationsLeft} escalation${result.escalationsLeft === 1 ? "" : "s"} left if you need one.`
					: "There are no escalations left."
			}`,
		);
		return lines.join("\n");
	}
	lines.push(
		"",
		result.followUpsLeft > 0
			? `If it does not hold up, call \`${ESCALATE_TOOL_NAME}\` again with \`message\` and say exactly what you found — you have ${result.followUpsLeft} follow-up${result.followUpsLeft === 1 ? "" : "s"} left in this exchange, and they are much cheaper than another escalation. When you are satisfied, call it with \`finished: true\` to release the expert.`
			: `This exchange is out of follow-ups. Act on what you have, and call \`${ESCALATE_TOOL_NAME}\` with \`finished: true\` to release the expert.`,
	);
	return lines.join("\n");
}

export function createEscalateTool(options: EscalateToolOptions): AgentTool {
	return createTool({
		name: ESCALATE_TOOL_NAME,
		description: ESCALATE_TOOL_DESCRIPTION,
		inputSchema: ESCALATE_TOOL_INPUT_SCHEMA as unknown as Record<
			string,
			unknown
		>,
		execute: async (input: unknown): Promise<string> => {
			const request = readEscalationRequest(input);
			// A model that puts its whole ask in `message` is not making a
			// mistake worth a turn. It is stuck -- that is why it is here -- and
			// refusing over a field name teaches schema instead of getting help.
			// The host decides whether this opens an exchange or continues one;
			// carrying both fields lets it.
			if (!request.goal && request.message) {
				request.goal = request.message;
			}
			if (!request.goal && !request.finished) {
				return `Nothing was escalated: this call had no \`goal\` and no \`message\`. Say what you want the expert to do and how you will know it is right, then call \`${ESCALATE_TOOL_NAME}\` again. Nothing was spent.`;
			}
			try {
				return describeResult(await options.consult(request));
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				options.onError?.("[Escalation] the escalation did not happen", error);
				return `The escalation did not happen: ${reason}\n\nCarry on without the expert — the task is still yours to finish, and nothing about it has changed.`;
			}
		},
	});
}

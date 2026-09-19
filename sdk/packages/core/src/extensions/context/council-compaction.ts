/**
 * A second opinion on a compaction, before it replaces the transcript.
 *
 * A summary is written once, from the whole of a transcript, by a model that
 * has just spent its budget doing the work being summarised. It is the only
 * artifact in the system that is never checked against the thing it describes
 * -- and it is also the one artifact that, once written, *is* the thing it
 * describes. Every later turn reads it and never the conversation again.
 *
 * Measured on pandorum: summaries that reported a checker run as a success
 * when it had returned `ok:false` three times, that paraphrased the
 * instruction they had been asked to quote, and that narrated in the past
 * tense a prompt had asked three times to be present. None of these are
 * failures of intelligence. They are failures of a single pass over more
 * material than fits comfortably in one.
 *
 * So the summary is reviewed the way a council reviews a proposal. The
 * transcript is cut in half; each half is given to a fresh reviewer along with
 * the summary and the retrospective, and asked what is missing, what is
 * contradicted and what is misquoted **in that half**. A synthesiser then
 * glues the two corrected versions back into one.
 *
 * Three properties the shape is chosen for:
 *
 * - **Each reviewer sees half the evidence and all of the claim.** That is the
 *   point: a reviewer holding half a transcript has room to actually read it,
 *   where the original pass did not. It is also the danger, and the reviewer
 *   prompt spends most of its words on it -- a reviewer who deletes what its
 *   half does not cover turns a review into a truncation.
 * - **The reviewers are parallel, not chained.** Both correct the *original*.
 *   Chaining would make the second reviewer's job "review a text the first one
 *   already changed", and its corrections would compound rather than converge.
 * - **Nothing here may fail the compaction.** Every step falls back to what it
 *   was given. A council that cannot run leaves an unreviewed summary, which
 *   is exactly what shipped before it existed.
 */

import type { BasicLogger, MessageWithMetadata } from "@cline/shared";
import type { EstimateMessageTokens } from "./compaction-shared";
import { serializeConversation } from "./compaction-shared";

/** What a reviewer and the synthesiser are told they are. */
export const COUNCIL_SYSTEM_PROMPTS = {
	critic:
		"You are checking an account of your own work against the record of it. You are not rewriting it and you are not improving its prose: you are correcting it where the record shows it to be wrong, incomplete or misquoted, and leaving it alone everywhere else.",
	synthesizer:
		"You are merging two independent corrections of the same text into one. Both reviewers were correcting the same original and neither saw the other's work or the other's evidence. Your answer is the whole merged text, not an account of how you merged it.",
} as const;

/** Which half of the transcript a reviewer was given. */
export type CouncilHalf = "first" | "second";

export interface CouncilSections {
	replay?: string;
	retrospective?: string;
}

/**
 * The reviewer's instruction.
 *
 * Most of it is about what *not* to do, which is unusual here and is the
 * lesson of the shape: the failure mode of a reviewer holding half the
 * evidence is not missing a correction, it is confidently deleting a fact it
 * cannot see the support for. A replay covering the whole of the work will
 * always look half-unsupported to each reviewer, so saying it once is not
 * enough.
 */
export function buildCouncilCriticRequest(input: {
	half: CouncilHalf;
	summary: string;
	thinkingSummary?: string;
	transcript: string;
}): string {
	const other = input.half === "first" ? "second" : "first";
	const parts = [
		`You wrote the replay below, and the retrospective beside it, from a transcript that is about to be discarded. Here is the **${input.half} half** of that transcript. The ${other} half is not shown to you and you will never see it.`,
		"",
		`Everything the replay says about the ${other} half is outside what you can check. It is not unsupported — it is supported by evidence you were not given. **Leave it exactly as it stands.** Do not delete it, do not soften it, do not mark it as unverified, do not mention it. A reviewer who removes what it cannot see turns a review into a deletion, and the half it could not see is the half nobody else will check either.`,
		"",
		`What you are looking for, in your half and nowhere else:`,
		"",
		"- **Something that happened and is missing.** A call that was made, an answer that came back, an instruction that was given, a conclusion that was reached, an approach that was ruled out. Add it, in the voice the replay is written in.",
		"- **Something the replay states that your half contradicts.** A call reported as succeeding that returned an error; a file said to have been read that was refused; a count, a line number or a filename that does not match. Correct it to what the transcript shows.",
		"- **Something quoted that does not match.** The user's own words, error text, identifiers, paths and numbers have to be character for character what the transcript holds. Fix them against it.",
		"",
		"Then the retrospective, which is a judgement about how the work went rather than a record of what happened. Correct it only where your half shows the judgement itself to be wrong — an approach it calls wasteful that your half shows paying off, a failure mode it names that your half does not contain, a cost it misses that your half makes obvious. Its rules still hold: no file names, no identifiers, no narration of events, and terse.",
		"",
		"Keep the replay in the first person and the present tense, every step written as the step and its outcome as its own sentence after it. If you find a step written as a report of itself, that is one of the things to correct.",
		"",
		"Answer with exactly these two sections and nothing before, between or after them. Give the **whole** text of each, corrected — not a list of your changes, and not only the parts you touched:",
		"",
		"## Replay",
		"",
		"## Retrospective",
		"",
		"---",
		"",
		"The replay, as written:",
		"",
		input.summary,
	];
	if (input.thinkingSummary?.trim()) {
		parts.push(
			"",
			"---",
			"",
			"The retrospective, as written:",
			"",
			input.thinkingSummary.trim(),
		);
	}
	parts.push(
		"",
		"---",
		"",
		`The ${input.half} half of the transcript:`,
		"",
		input.transcript || "(empty)",
	);
	return parts.join("\n");
}

/**
 * The synthesiser's instruction.
 *
 * It is given the original as well as both corrections, because the diff is
 * the signal: a passage two reviewers left alone is a passage neither could
 * fault, and a passage one of them changed was changed by the only one holding
 * the evidence for it.
 */
export function buildCouncilSynthesizerRequest(input: {
	summary: string;
	thinkingSummary?: string;
	first: CouncilSections;
	second: CouncilSections;
}): string {
	const parts = [
		"Two reviewers have corrected the same replay. Each was given one half of the transcript it was written from — the first reviewer the first half, the second the second half — and neither saw the other's half or the other's corrections. Merge their work into one replay and one retrospective.",
		"",
		"How to decide, passage by passage:",
		"",
		"- **Both left it alone** — keep it as it is.",
		"- **One changed it and the other did not** — take the change. The reviewer who changed it is the one who was holding the evidence for that passage; the other was not saying it is right, only that it was not theirs to check.",
		"- **Both changed it, compatibly** — keep both facts.",
		"- **Both changed it, incompatibly** — prefer the version that quotes the transcript over the version that describes it.",
		"",
		"Do not shorten, summarise or tidy. Both reviewers were asked for the whole text and you are merging two whole texts into a third; a merge that comes out shorter than either input has dropped something. Keep the replay in the first person and the present tense.",
		"",
		"Answer with exactly these two sections and nothing else:",
		"",
		"## Replay",
		"",
		"## Retrospective",
		"",
		"---",
		"",
		"The original replay:",
		"",
		input.summary,
	];
	if (input.thinkingSummary?.trim()) {
		parts.push(
			"",
			"The original retrospective:",
			"",
			input.thinkingSummary.trim(),
		);
	}
	parts.push(
		"",
		"---",
		"",
		"The first reviewer's corrected replay:",
		"",
		input.first.replay ?? "(unchanged)",
	);
	if (input.first.retrospective) {
		parts.push(
			"",
			"The first reviewer's corrected retrospective:",
			"",
			input.first.retrospective,
		);
	}
	parts.push(
		"",
		"---",
		"",
		"The second reviewer's corrected replay:",
		"",
		input.second.replay ?? "(unchanged)",
	);
	if (input.second.retrospective) {
		parts.push(
			"",
			"The second reviewer's corrected retrospective:",
			"",
			input.second.retrospective,
		);
	}
	return parts.join("\n");
}

/**
 * Read the two sections back out of a reply.
 *
 * Tolerant of the heading level and of anything the model puts before the
 * first heading, because the alternative to tolerance here is discarding a
 * good correction over a `###`. A reply with no recognisable `Replay` section
 * yields nothing and is treated as a reviewer that declined.
 */
export function parseCouncilSections(text: string): CouncilSections {
	const headings = [
		...text.matchAll(/^#{1,4}\s*(replay|retrospective)\s*$/gim),
	];
	if (headings.length === 0) {
		return {};
	}
	const sections: CouncilSections = {};
	headings.forEach((match, index) => {
		const name = match[1].toLowerCase();
		const start = (match.index ?? 0) + match[0].length;
		const end = headings[index + 1]?.index ?? text.length;
		const body = text.slice(start, end).trim();
		if (!body) {
			return;
		}
		if (name === "replay") {
			sections.replay = body;
		} else {
			sections.retrospective = body;
		}
	});
	return sections;
}

/**
 * Where to cut the transcript in two.
 *
 * By measured tokens rather than by message count, because a transcript is
 * never evenly weighted -- one tool result can outweigh twenty turns -- and
 * the point of the split is that each reviewer gets an amount it can actually
 * read.
 *
 * The cut never lands between a tool call and its result. A reviewer handed a
 * call whose answer is in the other half would read it as a call that never
 * came back, which is the single most misleading thing a transcript can say.
 */
export function splitForCouncil(
	messages: readonly MessageWithMetadata[],
	estimateMessageTokens: EstimateMessageTokens,
): { first: MessageWithMetadata[]; second: MessageWithMetadata[] } {
	if (messages.length < 2) {
		return { first: [...messages], second: [] };
	}
	const weights = messages.map((message) => estimateMessageTokens(message));
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	let running = 0;
	let cut = 1;
	for (let index = 0; index < messages.length; index += 1) {
		running += weights[index];
		if (running * 2 >= total) {
			cut = index + 1;
			break;
		}
	}
	cut = Math.min(Math.max(1, cut), messages.length - 1);
	// Walk forward past an open tool call rather than back, so the pair stays
	// with the half that issued it.
	//
	// Bounded so the second half always keeps a message. A span ending on a
	// call that never came back -- an aborted turn, a provider that dropped the
	// result -- has an open call at every cut, and an unbounded walk would hand
	// the whole transcript to one reviewer and silently leave the other with
	// nothing to review. Splitting that one pair is the lesser cost: the
	// reviewer prompt already tells each half not to touch what it cannot see.
	while (cut < messages.length - 1 && hasUnansweredToolCall(messages, cut)) {
		cut += 1;
	}
	return {
		first: messages.slice(0, cut),
		second: messages.slice(cut),
	};
}

function hasUnansweredToolCall(
	messages: readonly MessageWithMetadata[],
	cut: number,
): boolean {
	const called = new Set<string>();
	const answered = new Set<string>();
	for (let index = 0; index < cut; index += 1) {
		const content = messages[index]?.content;
		if (!Array.isArray(content)) {
			continue;
		}
		for (const block of content) {
			if (block.type === "tool_use") {
				called.add(block.id);
			} else if (block.type === "tool_result") {
				answered.add(block.tool_use_id);
			}
		}
	}
	for (const id of called) {
		if (!answered.has(id)) {
			return true;
		}
	}
	return false;
}

export interface CouncilReviewResult {
	summary: string;
	thinkingSummary?: string;
	/** How many reviewers came back with something usable. */
	reviewers: number;
	/** Whether the synthesiser's merge replaced the original. */
	merged: boolean;
}

/**
 * Run the review. Returns what it was given if any part of it does not land.
 */
export async function runCouncilReview(input: {
	summary: string;
	thinkingSummary?: string;
	messages: readonly MessageWithMetadata[];
	estimateMessageTokens: EstimateMessageTokens;
	/** One model call. Throwing is allowed and is handled as a decline. */
	generate: (call: {
		systemPrompt: string;
		request: string;
	}) => Promise<string>;
	/**
	 * What the summarizer will accept as one request. A reviewer whose half
	 * does not fit declines rather than sending a call the provider refuses;
	 * the other half is still reviewed, which is why this is not a reason to
	 * abandon the council.
	 */
	maxRequestChars?: number;
	logger?: BasicLogger;
}): Promise<CouncilReviewResult> {
	const unchanged: CouncilReviewResult = {
		summary: input.summary,
		thinkingSummary: input.thinkingSummary,
		reviewers: 0,
		merged: false,
	};
	if (!input.summary.trim()) {
		return unchanged;
	}
	const { first, second } = splitForCouncil(
		input.messages,
		input.estimateMessageTokens,
	);
	if (first.length === 0 || second.length === 0) {
		// One half means one reviewer looking at everything the writer already
		// looked at, for the price of a request.
		input.logger?.debug("Skipped the compaction council: nothing to split", {
			messages: input.messages.length,
		});
		return unchanged;
	}

	const review = async (
		half: CouncilHalf,
		messages: MessageWithMetadata[],
	): Promise<CouncilSections> => {
		const request = buildCouncilCriticRequest({
			half,
			summary: input.summary,
			thinkingSummary: input.thinkingSummary,
			transcript: serializeConversation(messages),
		});
		if (
			typeof input.maxRequestChars === "number" &&
			request.length > input.maxRequestChars
		) {
			input.logger?.log(
				"A compaction reviewer's half does not fit; skipping it",
				{
					severity: "warn",
					half,
					requestChars: request.length,
					maxRequestChars: input.maxRequestChars,
				},
			);
			return {};
		}
		try {
			const text = await input.generate({
				systemPrompt: COUNCIL_SYSTEM_PROMPTS.critic,
				request,
			});
			return parseCouncilSections(text);
		} catch (error) {
			input.logger?.log("A compaction reviewer failed; ignoring it", {
				severity: "warn",
				half,
				errorMessage: error instanceof Error ? error.message : String(error),
			});
			return {};
		}
	};

	// Both reviewers correct the original, so neither inherits the other's
	// reading. In parallel because they do not depend on each other and a
	// council that costs two round trips in series is a council nobody leaves
	// switched on.
	const [firstSections, secondSections] = await Promise.all([
		review("first", first),
		review("second", second),
	]);
	const reviewers =
		(firstSections.replay ? 1 : 0) + (secondSections.replay ? 1 : 0);
	if (reviewers === 0) {
		input.logger?.log("No compaction reviewer returned a usable answer", {
			severity: "warn",
		});
		return unchanged;
	}

	try {
		const merged = parseCouncilSections(
			await input.generate({
				systemPrompt: COUNCIL_SYSTEM_PROMPTS.synthesizer,
				request: buildCouncilSynthesizerRequest({
					summary: input.summary,
					thinkingSummary: input.thinkingSummary,
					first: firstSections,
					second: secondSections,
				}),
			}),
		);
		if (!merged.replay?.trim()) {
			input.logger?.log(
				"The compaction synthesiser returned no replay; keeping the original",
				{ severity: "warn", reviewers },
			);
			return { ...unchanged, reviewers };
		}
		return {
			summary: merged.replay.trim(),
			thinkingSummary: merged.retrospective?.trim() || input.thinkingSummary,
			reviewers,
			merged: true,
		};
	} catch (error) {
		input.logger?.log(
			"The compaction synthesiser failed; keeping the original",
			{
				severity: "warn",
				reviewers,
				errorMessage: error instanceof Error ? error.message : String(error),
			},
		);
		return { ...unchanged, reviewers };
	}
}

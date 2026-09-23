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
import { serializeConversation } from "./compaction-shared";

/** What a reviewer and the synthesiser are told they are. */
export const COUNCIL_SYSTEM_PROMPTS = {
	critic:
		"You are rewriting one half of an account of your own work, with the record of that work in front of you. Correct what the record contradicts, add what it shows missing, fix every quotation against it, and improve the prose where it has drifted out of voice. You return your half and only your half: another writer is rewriting the other one, and the two will be joined into a single continuous replay.",
	synthesizer:
		"You are joining two independently rewritten halves of one replay into a single continuous piece, and revising a retrospective against the result. Each half was rewritten by someone holding the whole record but owning only that half, so both are grounded — and both could be wrong about the other's territory. Your answer is the finished text, not an account of how you produced it.",
} as const;

/**
 * What the replay's writer is told when a council will review it: where to
 * put the line that splits it in two.
 *
 * Its own prompt rather than a paragraph of the replay prompt, where it used
 * to live: it was sent with the council switched off, when nothing reads the
 * marker, and never with the full-compaction prompt, so a full compaction
 * reviewed by the council always fell back to a guessed split. It is appended
 * to whichever writer prompt runs, and only while the council is on.
 */
export const DEFAULT_COUNCIL_WRITER_PROMPT = `## Mark the halfway point

Exactly once, put a line containing \`<<<HALFWAY>>>\` and nothing else, at the
point where you are about half way through the work you are describing.

Measure the half by the **work**, not by the words: the marker goes where the
first half of what happened ends and the second half begins. It must sit on a
boundary between steps — after one step and its outcome are complete, never
inside a step, never between a call and what it returned, and never inside a
fenced block.

Nothing else about the replay changes. It is one continuous piece of prose that
happens to carry a marker; do not write headings for the halves, do not
summarise each half, and do not refer to the marker in the text.`;

/**
 * The reviewer's instruction, as a template.
 *
 * `{{half}}`, `{{other_half}}` and `{{half_length}}` are substituted; the two
 * halves, the numbered record and the transcript are appended by the harness
 * after it, so a custom prompt cannot drop the evidence it is asked to check.
 */
export const DEFAULT_COUNCIL_CRITIC_PROMPT = `You wrote the replay below from the transcript that follows it. The replay has been cut in two and you own the **{{half}} half**. Someone else is rewriting the {{other_half}} half from the same transcript, at the same time, and the two halves will be joined back into one continuous replay.

So: **return the {{half}} half only.** Do not return the {{other_half}} half, do not restate it, do not summarise it, do not lead into it or round it off. It is shown to you for one reason only — so you can check your own half against it and see where your half ends. Anything of it you reproduce will appear twice in the joined replay, once from you and once from the writer who owns it.

**The user's own words stay.** If your half quotes what the user asked for, that quotation is the most load-bearing text in it — it is the only place the instruction survives at all once the transcript is gone. Keep it word for word. Do not paraphrase it, do not shorten it, and never drop it to make room.

**You are revising a draft, not writing one.** Start from the text below and change what is wrong with it. Do not re-derive your half from the transcript and write it out afresh: a step that is already right is already done, and rewriting it from scratch is how a correct sentence becomes a different, shorter, wronger one.

**About the \`[#7]\` marks.** Those are citations, not step numbers and not part of the prose. Each one names a call in the numbered record, and the harness replaces it with that call before anyone reads this. So:

- **Keep every citation your half already has, exactly as it is, where it is.** Do not renumber them, do not turn them into a numbered list, do not write them out as "Step 7".
- **Only cite a number that appears in the record.** If your half describes something with no call behind it, leave it uncited — inventing a number attaches your sentence to somebody else's call, or to nothing.
- If the transcript shows a call your half never mentions, add the step and cite its number from the record.

What to change in your half:

- **Something that happened and is missing.** A call that was made, an answer that came back, an instruction that was given, a conclusion that was reached, an approach that was ruled out. Add it.
- **Something the transcript contradicts.** A call reported as succeeding that returned an error; a file said to have been read that was refused; a count, a line number or a filename that does not match. Correct it to what the transcript shows.
- **Something quoted that does not match.** The user's own words, error text, identifiers, paths and numbers have to be character for character what the transcript holds.
- **Something the {{other_half}} half contradicts.** Ground your half against it: the two are one account of one session, and a fact stated one way in your half and another way there is a fact to settle from the transcript.
- **Prose that has drifted.** Fix it. If a step is written as a report of itself — past tense, or narrated as something finished — rewrite it as the step and its outcome. First person, present continuous, the voice of someone picking the work back up rather than recounting it.

Write every step as the step itself, then what came back as its own short sentence after it. This holds in the middle of your half and not only at its ends.

**Length.** Your half is {{half_length}} characters. Return something close to that — within about 10% either way. You are correcting and rewriting it, not condensing it: material you drop is material nothing else will carry, because the transcript it came from is being deleted.

Answer with the {{half}} half of the replay and nothing else. No heading, no preamble, no note about what you changed, no marker line. Just the prose.`;

/**
 * The synthesiser's instruction, as a template.
 *
 * `{{original_length}}` and `{{max_length}}` are substituted. The retrospective
 * paragraph and the answer format come after it from the harness, because the
 * reply is parsed by its headings, and so do the halves themselves.
 */
export const DEFAULT_COUNCIL_SYNTHESIZER_PROMPT = `A replay of your recent work was cut in half, and each half was rewritten against the full transcript by a different writer. Join them back into one continuous replay.

Both writers had the whole transcript, so both halves are grounded in the record — but each owned only its own half, and either could be wrong about the seam between them or about a fact the other half settles differently. Cross-check the two against each other: where they disagree about the same fact, keep the version that quotes the transcript over the version that describes it; where one states something the other contradicts, keep the one that is specific.

What you are producing is one piece of prose, not two halves stacked up. Make the seam invisible: no heading between them, no marker line, no sentence that restarts or recaps. If the two writers both wrote the same step — once at the end of the first half and once at the start of the second — keep it once.

Keep it in the first person and the present continuous tense, every step written as the step and its outcome after it.

**Length.** The replay was {{original_length}} characters before it was rewritten. Aim at that. You may go up to {{max_length}} — about 10% more — and you should use that allowance only where it takes the extra room to keep something that would otherwise be lost. Do not use it to be more thorough for its own sake, and do not come in far under: material dropped here is material nothing else carries.`;

/** Substitute `{{name}}` placeholders; an unknown one is left as written. */
export function renderCouncilPrompt(
	template: string,
	values: Record<string, string | number>,
): string {
	return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, name: string) =>
		name in values ? String(values[name]) : whole,
	);
}

/**
 * A writer prompt with the council's marker instruction, when the council runs.
 *
 * Not appended twice: a custom prompt copied from an older default already
 * carries the section, marker and all.
 */
export function withCouncilWriterPrompt(
	prompt: string,
	writerPrompt?: string,
): string {
	if (/<<<\s*HALFWAY\s*>>>/.test(prompt)) {
		return prompt;
	}
	const section = writerPrompt?.trim() || DEFAULT_COUNCIL_WRITER_PROMPT;
	// Before the closing "stop" paragraph when the prompt has one, so the last
	// thing before the transcript is still the instruction not to continue it.
	const stop = prompt.lastIndexOf("\n\nWrite the replay and stop.");
	return stop >= 0
		? `${prompt.slice(0, stop)}\n\n${section}${prompt.slice(stop)}`
		: `${prompt.trimEnd()}\n\n${section}`;
}

/** The line the replay carries to say where its first half ends. */
export const COUNCIL_HALF_MARKER = "<<<HALFWAY>>>";

const HALF_MARKER_LINE = /^[ \t]*<<<\s*HALFWAY\s*>>>[ \t]*$/m;

/**
 * How far from the middle the model's own marker may land and still be used.
 *
 * The writer places the marker because only it knows where one stretch of work
 * ends -- but "about half way" is a judgement a small model makes badly, and
 * measured on pandorum it put the marker at 19%, leaving one writer 919
 * characters and the other 3,939. The oversized half came back byte-identical:
 * the writer handed four times the work did none of it.
 *
 * So the marker is respected inside a band and rebalanced outside it. The band
 * is wide, because a genuine boundary rarely falls exactly at the midpoint and
 * moving it costs the semantic split that made the marker worth asking for.
 */
const HALF_MARKER_BAND = 0.3;

/**
 * The replay in two pieces.
 *
 * Prefers the marker the writer placed, because a boundary between two
 * stretches of work is a thing only the writer knows. Falls back to the
 * nearest blank line to the midpoint when the marker is missing or lands far
 * enough off-centre that one writer would get most of the replay -- a
 * paragraph break is not a semantic boundary, but it is a boundary, and a
 * balanced split at a slightly wrong place beats a correct one that nobody
 * works on.
 */
export function splitReplayAtMarker(
	replay: string,
):
	| { first: string; second: string; source: "marker" | "rebalanced" }
	| undefined {
	const body = replay.trim();
	if (!body) {
		return undefined;
	}
	const match = HALF_MARKER_LINE.exec(body);
	if (match) {
		const first = body.slice(0, match.index).trim();
		const second = body.slice(match.index + match[0].length).trim();
		const total = first.length + second.length;
		if (first && second && total > 0) {
			const share = first.length / total;
			if (share >= HALF_MARKER_BAND && share <= 1 - HALF_MARKER_BAND) {
				return { first, second, source: "marker" };
			}
		}
	}
	return rebalance(stripHalfMarker(body));
}

/** Split at the blank line nearest the middle; then any line; else give up. */
function rebalance(
	body: string,
): { first: string; second: string; source: "rebalanced" } | undefined {
	const midpoint = body.length / 2;
	const boundaries: number[] = [];
	for (const pattern of [/\n[ \t]*\n/g, /\n/g]) {
		pattern.lastIndex = 0;
		for (let m = pattern.exec(body); m; m = pattern.exec(body)) {
			boundaries.push(m.index + m[0].length);
		}
		if (boundaries.length > 0) {
			break;
		}
	}
	if (boundaries.length === 0) {
		return undefined;
	}
	let best = boundaries[0];
	for (const at of boundaries) {
		if (Math.abs(at - midpoint) < Math.abs(best - midpoint)) {
			best = at;
		}
	}
	const first = body.slice(0, best).trim();
	const second = body.slice(best).trim();
	if (!first || !second) {
		return undefined;
	}
	return { first, second, source: "rebalanced" };
}

/** Strip any marker the model left behind, so it never reaches the context. */
export function stripHalfMarker(text: string): string {
	return text.replace(new RegExp(HALF_MARKER_LINE.source, "gm"), "").trim();
}

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
	/** The half this writer owns and returns. */
	ownReplay: string;
	/** The other half, for grounding only. */
	otherReplay: string;
	transcript: string;
	/**
	 * The numbered record the replay's `[#N]` citations point at.
	 *
	 * Without it the citations are unexplained punctuation. Measured on
	 * pandorum with thinking on, the writer wrote its own reading into its
	 * task list -- "write every step as `Step [number]. Outcome.`" -- and
	 * restructured its half around a step numbering that does not exist,
	 * returning 30% of what it was given.
	 */
	toolLedgerKey?: string;
	/** Replaces {@link DEFAULT_COUNCIL_CRITIC_PROMPT}; blank uses it. */
	instructions?: string;
}): string {
	const other = input.half === "first" ? "second" : "first";
	return [
		renderCouncilPrompt(
			input.instructions?.trim() || DEFAULT_COUNCIL_CRITIC_PROMPT,
			{
				half: input.half,
				other_half: other,
				half_length: input.ownReplay.length,
			},
		),
		"",
		"---",
		"",
		`The ${input.half} half of the replay — this is yours, rewrite it:`,
		"",
		input.ownReplay,
		"",
		"---",
		"",
		`The ${other} half of the replay — reference only, someone else owns it, do not return it:`,
		"",
		input.otherReplay || "(empty)",
		"",
		"---",
		"",
		...(input.toolLedgerKey?.trim()
			? [
					"The numbered record the citations point at:",
					"",
					input.toolLedgerKey.trim(),
					"",
					"---",
					"",
				]
			: []),
		"The transcript both halves were written from:",
		"",
		input.transcript || "(empty)",
	].join("\n");
}

/**
 * The synthesiser's instruction.
 *
 * It sees each half's original beside that half's rewrite, rather than the
 * whole original in one piece: the halves are what the two writers actually
 * worked on, so pairing them is what makes a change visible. It is also the
 * only role that touches the retrospective, which is deliberate -- a
 * retrospective is a judgement about how the work went, and a reviewer holding
 * one half of the evidence is the worst possible judge of it. By the time this
 * runs the merged replay exists, which is the thing the judgement is about.
 */
export function buildCouncilSynthesizerRequest(input: {
	firstOriginal: string;
	secondOriginal: string;
	firstRewritten: string;
	secondRewritten: string;
	thinkingSummary?: string;
	/** What the whole replay was before either half was rewritten. */
	originalLength: number;
	/** Replaces {@link DEFAULT_COUNCIL_SYNTHESIZER_PROMPT}; blank uses it. */
	instructions?: string;
}): string {
	const budget = Math.round(input.originalLength * 1.1);
	const parts = [
		renderCouncilPrompt(
			input.instructions?.trim() || DEFAULT_COUNCIL_SYNTHESIZER_PROMPT,
			{ original_length: input.originalLength, max_length: budget },
		),
		"",
	];
	if (input.thinkingSummary?.trim()) {
		parts.push(
			"Then the retrospective, which is a judgement about how the work went rather than a record of what happened. You are the first to see the finished replay, so you are the first who can judge it properly. Revise the retrospective against the replay you have just joined: drop a judgement the replay does not bear out, add one it makes obvious, sharpen one that is vague. Its rules hold — no file names, no identifiers, no narration of events, and terse. If it is already right, return it unchanged.",
			"",
			"Answer with exactly these two sections and nothing before, between or after them:",
			"",
			"## Replay",
			"",
			"## Retrospective",
		);
	} else {
		parts.push(
			"Answer with exactly this section and nothing before or after it:",
			"",
			"## Replay",
		);
	}
	parts.push(
		"",
		"---",
		"",
		"**First half — as originally written:**",
		"",
		input.firstOriginal,
		"",
		"**First half — as rewritten:**",
		"",
		input.firstRewritten,
		"",
		"---",
		"",
		"**Second half — as originally written:**",
		"",
		input.secondOriginal,
		"",
		"**Second half — as rewritten:**",
		"",
		input.secondRewritten,
	);
	if (input.thinkingSummary?.trim()) {
		parts.push(
			"",
			"---",
			"",
			"**The retrospective, as written:**",
			"",
			input.thinkingSummary.trim(),
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
 * How much of each intermediate text reaches the log.
 *
 * The host's logger writes the message string and drops the metadata object,
 * so anything that needs to be readable after the fact has to be inside the
 * sentence. That makes an unbounded excerpt a real hazard here -- a debug
 * default that logged every token once filled 260,774 of 261,885 lines and
 * took the host down with it -- so each stage gets a fixed, small budget.
 */
const COUNCIL_LOG_EXCERPT_CHARS = 1_500;

/**
 * How much of the original a merge must still be to be accepted.
 *
 * The council's one real danger is truncation, and it is written into the
 * shape: each reviewer sees half the evidence and all of the claim, so
 * everything the replay says about the other half looks unsupported to it. The
 * prompts spend most of their words telling reviewers not to delete that, and
 * the synthesiser is told outright that "a merge that comes out shorter than
 * either input has dropped something" -- but an instruction is not a guard,
 * and a summary is the one artifact with nothing downstream to catch it.
 *
 * So the ratio is checked rather than asked for. A merge that comes back at a
 * fraction of the original is not a correction, whatever it says about itself,
 * and the unreviewed original is strictly better than a confident excerpt of
 * it. Deliberately loose: a real merge rewrites sentences and drops
 * duplication, and only a collapse should trip this.
 */
const COUNCIL_MIN_MERGE_RATIO = 0.5;

/**
 * Head, middle and tail rather than the opening.
 *
 * The question these excerpts exist to answer is whether the replay holds its
 * voice all the way through, and the prompt says as much in as many words:
 * the rule "holds for the middle of the replay and not only its first and last
 * sentences". An excerpt that only ever showed the opening could not tell a
 * replay that drifts from one that does not.
 */
export function logExcerpt(
	text: string,
	limit = COUNCIL_LOG_EXCERPT_CHARS,
): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= limit) {
		return flat;
	}
	const slice = Math.floor(limit / 3);
	const middleStart = Math.floor(flat.length / 2 - slice / 2);
	return [
		flat.slice(0, slice),
		` …${middleStart - slice} chars… `,
		flat.slice(middleStart, middleStart + slice),
		` …${flat.length - middleStart - slice - slice} chars… `,
		flat.slice(-slice),
	].join("");
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
	/**
	 * The numbered record the replay's `[#N]` citations point at, passed
	 * through to both writers so the citations are not unexplained
	 * punctuation they have to guess a meaning for.
	 */
	toolLedgerKey?: string;
	logger?: BasicLogger;
	/**
	 * Review the halves one after the other instead of at once.
	 *
	 * Set when the agent runs inside an engine session it shares with a swarm:
	 * two concurrent reviewers are two concurrent requests against a window the
	 * other agents are drawing on, which is the load compaction is meant to
	 * relieve, not add to.
	 */
	serial?: boolean;
	/** Replaces the reviewers' instruction; blank uses the default. */
	criticPrompt?: string;
	/** Replaces the synthesiser's instruction; blank uses the default. */
	synthesizerPrompt?: string;
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
	// The replay says where its own halves meet. Only the writer that produced
	// it can place that boundary: it knows where one stretch of work ends, and
	// the harness would have to guess from prose. No marker means the replay
	// was written by something that did not follow the instruction, and a
	// guessed split would hand each writer a fragment starting mid-sentence.
	const halves = splitReplayAtMarker(input.summary);
	if (!halves) {
		// One unbroken block of prose with nowhere to cut. Nothing to review
		// half of, and nothing worth three model calls.
		input.logger?.log(
			"The compaction replay could not be split in two; skipping the council",
			{ severity: "warn", summaryChars: input.summary.length },
		);
		return { ...unchanged, summary: stripHalfMarker(input.summary) };
	}
	if (halves.source === "rebalanced") {
		input.logger?.log(
			"The compaction replay's halfway marker was missing or off-centre; split at the nearest paragraph instead",
			{
				severity: "warn",
				firstChars: halves.first.length,
				secondChars: halves.second.length,
			},
		);
	}
	const transcript = serializeConversation([...input.messages]);
	const originalLength = halves.first.length + halves.second.length;

	input.logger?.debug(
		`[council] original replay (${input.summary.length} chars, halves ${halves.first.length}/${halves.second.length} by ${halves.source}): ${logExcerpt(input.summary)}`,
	);
	if (input.thinkingSummary?.trim()) {
		input.logger?.debug(
			`[council] original retrospective (${input.thinkingSummary.length} chars): ${logExcerpt(input.thinkingSummary, 600)}`,
		);
	}

	// Both writers see the whole transcript. The halving is of the *replay*,
	// not of the evidence: a writer that owns the first half still needs the
	// second half's record to know that a call it describes was later refused.
	const rewrite = async (half: CouncilHalf): Promise<string | undefined> => {
		const ownReplay = half === "first" ? halves.first : halves.second;
		const otherReplay = half === "first" ? halves.second : halves.first;
		const request = buildCouncilCriticRequest({
			half,
			ownReplay,
			otherReplay,
			transcript,
			toolLedgerKey: input.toolLedgerKey,
			instructions: input.criticPrompt,
		});
		if (
			typeof input.maxRequestChars === "number" &&
			request.length > input.maxRequestChars
		) {
			input.logger?.log(
				"A compaction reviewer's request does not fit; keeping that half as written",
				{
					severity: "warn",
					half,
					requestChars: request.length,
					maxRequestChars: input.maxRequestChars,
				},
			);
			return undefined;
		}
		try {
			const text = await input.generate({
				systemPrompt: COUNCIL_SYSTEM_PROMPTS.critic,
				request,
			});
			// A writer that returned both halves anyway gets spliced back to
			// its own: the other half is about to arrive from the writer that
			// owns it, and keeping both would say every step twice.
			//
			// Only a marker proves it returned both. `splitReplayAtMarker`
			// falls back to `rebalance` when there is none, which is right for
			// phase 0 -- whose output *is* the whole replay -- and ruinous
			// here: a writer that correctly returned its own half and nothing
			// else has that half halved again and half of it dropped. That is
			// what every "the writer deleted instead of revising" measurement
			// turned out to be; the model was doing the job and the splice was
			// eating the answer.
			const emitted = splitReplayAtMarker(text);
			const kept = stripHalfMarker(
				emitted && emitted.source === "marker"
					? half === "first"
						? emitted.first
						: emitted.second
					: text,
			);
			if (!kept) {
				input.logger?.debug(
					`[council] ${half}-half writer returned nothing usable (raw=${text.length})`,
				);
				return undefined;
			}
			input.logger?.debug(
				`[council] ${half}-half rewritten (${kept.length} chars, was ${ownReplay.length}): ${logExcerpt(kept)}`,
			);
			return kept;
		} catch (error) {
			input.logger?.log("A compaction reviewer failed; keeping that half", {
				severity: "warn",
				half,
				errorMessage: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	};

	const [firstRewritten, secondRewritten] = input.serial
		? [await rewrite("first"), await rewrite("second")]
		: await Promise.all([rewrite("first"), rewrite("second")]);
	const reviewers = (firstRewritten ? 1 : 0) + (secondRewritten ? 1 : 0);
	if (reviewers === 0) {
		input.logger?.log("No compaction reviewer returned a usable half", {
			severity: "warn",
		});
		return { ...unchanged, summary: stripHalfMarker(input.summary) };
	}

	try {
		const mergedText = await input.generate({
			systemPrompt: COUNCIL_SYSTEM_PROMPTS.synthesizer,
			request: buildCouncilSynthesizerRequest({
				firstOriginal: halves.first,
				secondOriginal: halves.second,
				firstRewritten: firstRewritten ?? halves.first,
				secondRewritten: secondRewritten ?? halves.second,
				thinkingSummary: input.thinkingSummary,
				originalLength,
				instructions: input.synthesizerPrompt,
			}),
		});
		const merged = parseCouncilSections(mergedText);
		// With no retrospective the synthesiser is asked for one section, and a
		// model given one section often writes it without the heading.
		const mergedReplay = stripHalfMarker(
			merged.replay?.trim() || (input.thinkingSummary ? "" : mergedText),
		);
		if (mergedReplay) {
			input.logger?.debug(
				`[council] merged replay (${mergedReplay.length} chars, original ${originalLength}): ${logExcerpt(mergedReplay)}`,
			);
		}
		if (merged.retrospective?.trim()) {
			input.logger?.debug(
				`[council] merged retrospective (${merged.retrospective.trim().length} chars): ${logExcerpt(merged.retrospective, 600)}`,
			);
		}
		if (!mergedReplay) {
			input.logger?.log(
				"The compaction synthesiser returned no replay; keeping the original",
				{ severity: "warn", reviewers },
			);
			return {
				...unchanged,
				summary: stripHalfMarker(input.summary),
				reviewers,
			};
		}
		if (mergedReplay.length < originalLength * COUNCIL_MIN_MERGE_RATIO) {
			input.logger?.log(
				"The compaction council returned a merge far shorter than the original; keeping the original",
				{
					severity: "warn",
					reviewers,
					mergedChars: mergedReplay.length,
					originalChars: originalLength,
				},
			);
			return {
				...unchanged,
				summary: stripHalfMarker(input.summary),
				reviewers,
			};
		}
		return {
			summary: mergedReplay,
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
		return { ...unchanged, summary: stripHalfMarker(input.summary), reviewers };
	}
}

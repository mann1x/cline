/**
 * Verbatim self-repetition inside one completed reasoning block.
 *
 * The streaming guard next door (`reasoning-loop-guard.ts`) catches a channel
 * that has *collapsed* -- two lines flipping for 60k characters, an exact line
 * cycle, a phrase repeating inside one unbroken line. This catches something
 * milder and, on our data, far more common: a model that re-derives the same
 * conclusion in fresh-looking prose, paragraph after paragraph, and keeps
 * calling tools while it does it.
 *
 * Measured on pandorum session 1789026721979_kessj, assistant message 30 --
 * 9,728 characters, 65 paragraphs, 41 distinct, one paragraph appearing seven
 * times ("Actually, I think I found it! ... These should all be fine. Let me
 * look more carefully..."). All three signals of the streaming guard are blind
 * to it: the tightest 60-line window still holds 14 distinct lines against a
 * threshold of 4, the longest run at period <= 6 is 4 cycles against a
 * threshold of 20, and the block is full of newlines so the phrase test does
 * not apply. That turn also emitted a tool call, so every turn-level detector
 * saw a productive turn.
 *
 * WHAT IS COUNTED, AND WHY IT IS NOT SIMPLY "REPEATED TEXT". A model quoting
 * the same source line five times while comparing candidate edits is working.
 * Measured: `zssdm` msg 17 repeats one `dPw(c,x){...}` block five times and
 * `swpvy` msg 284 repeats a `function isOverlapping` body eight times, and
 * both are legitimate. So a paragraph counts only when it carries a sentence.
 * Code may ride along inside it -- the real loops read "I will try to replace
 * line 94 with `...` (Wait, no)" -- but a bare fenced quote is never counted.
 *
 * BOTH SIGNALS ARE REQUIRED. On the labelled set the legitimate blocks reach
 * `frac` 0.21 and `maxrep` 10 on their own, so either threshold alone admits
 * them; together they separate 12 of 12 by hand and 38 of 38 on inspection.
 *
 * IT NUDGES, IT NEVER CUTS. Across 3,229 blocks from 21 model families in the
 * harness logs it fires on 1.2%, and those fires land in runs that ended
 * `broken` 44% of the time -- but also in runs that ended FIXED 14% of the
 * time. Four runs in the sample contained a flagged block and still fixed the
 * task. A guard that aborted the turn would have destroyed all four. Looping
 * for a while and then getting there is a thing these models do.
 */

import type { ReasoningRepetitionConfig } from "@cline/shared";

/**
 * The shape lives in `@cline/shared` so a host can set it through
 * `execution.reasoningRepetition` without depending on this package; the
 * thresholds live here, with the measurements that set them.
 */
export type { ReasoningRepetitionConfig };

export const DEFAULT_REASONING_REPETITION: ReasoningRepetitionConfig = {
	minChars: 4000,
	minParagraphChars: 60,
	minStopwords: 3,
	maxRepeatTrip: 4,
	duplicateFractionTrip: 0.25,
	// One per run, matching `DEFAULT_MAX_NO_TOOL_CALL_NUDGES` next door and for
	// the reason measured there: on a 438-message session the model was nudged,
	// answered, was nudged again with the identical text, and answered with the
	// same sentence. The second nudge has never once changed an outcome. The
	// cooldown therefore almost never binds -- it is kept so that a host that
	// raises the budget does not get two in consecutive turns.
	cooldownTurns: 3,
	maxNudges: 1,
};

const STOPWORDS =
	/\b(the|is|are|to|and|of|it|that|this|be|for|but|so|if|will|need|should|let|now|then|because|actually|wait)\b/g;

export interface RepetitionMeasurement {
	/** Counted (prose-bearing) paragraphs. */
	paragraphs: number;
	/** How many counted paragraphs are duplicates of an earlier one. */
	duplicates: number;
	/** `duplicates / paragraphs`. */
	duplicateFraction: number;
	/** Occurrences of the most-repeated paragraph. */
	maxRepeat: number;
	/** That paragraph, for the message shown to the model. */
	sample: string;
}

/** Whether a paragraph carries a sentence rather than being a bare quote. */
function bearsProse(paragraph: string, minStopwords: number): boolean {
	const trimmed = paragraph.trim();
	const subject = trimmed.startsWith("```")
		? trimmed.replace(/```[\s\S]*?```/g, "")
		: trimmed;
	return (subject.toLowerCase().match(STOPWORDS) ?? []).length >= minStopwords;
}

/**
 * Measure one completed reasoning block, or `undefined` if there is nothing to
 * judge (too short, or no prose in it at all).
 */
export function measureReasoningRepetition(
	text: string,
	config: ReasoningRepetitionConfig = DEFAULT_REASONING_REPETITION,
): RepetitionMeasurement | undefined {
	if (text.length < config.minChars) {
		return undefined;
	}
	const paragraphs = text
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.trim())
		.filter(
			(paragraph) =>
				paragraph.length >= config.minParagraphChars &&
				bearsProse(paragraph, config.minStopwords),
		);
	if (paragraphs.length === 0) {
		return undefined;
	}

	const counts = new Map<string, number>();
	for (const paragraph of paragraphs) {
		counts.set(paragraph, (counts.get(paragraph) ?? 0) + 1);
	}
	let duplicates = 0;
	let maxRepeat = 0;
	let sample = "";
	for (const [paragraph, count] of counts) {
		duplicates += count - 1;
		if (count > maxRepeat) {
			maxRepeat = count;
			sample = paragraph;
		}
	}
	return {
		paragraphs: paragraphs.length,
		duplicates,
		duplicateFraction: duplicates / paragraphs.length,
		maxRepeat,
		sample,
	};
}

/** Whether a measurement crosses both thresholds. */
export function isRepetitionLoop(
	measurement: RepetitionMeasurement | undefined,
	config: ReasoningRepetitionConfig = DEFAULT_REASONING_REPETITION,
): boolean {
	if (!measurement) {
		return false;
	}
	return (
		measurement.maxRepeat >= config.maxRepeatTrip &&
		measurement.duplicateFraction >= config.duplicateFractionTrip
	);
}

/**
 * What the model is told.
 *
 * Quoting its own sentence back, because the useful information is *which*
 * thought it is stuck on -- a generic "you are repeating yourself" is one a
 * model agrees with and then repeats itself. It names the count, says the
 * thinking is not on the record for the user, and gives one instruction rather
 * than a list: act, or say what is blocking.
 */
export function describeRepetition(measurement: RepetitionMeasurement): string {
	const excerpt = measurement.sample.replace(/\s+/g, " ").slice(0, 200);
	return [
		`[SYSTEM] In your last reply you wrote this same passage ${measurement.maxRepeat} times, word for word:`,
		"",
		`    "${excerpt}${measurement.sample.length > 200 ? "…" : ""}"`,
		"",
		`That reply restated ${measurement.duplicates} of its ${measurement.paragraphs} paragraphs verbatim. Re-deriving a conclusion you have already reached will not produce a new one, and none of that reasoning is visible to the user.`,
		"",
		"Take the next concrete step instead: make the change, run the check, or say plainly what is blocking you and what you would need to get past it.",
	].join("\n");
}

/**
 * Rationed nudges: the guard may interrupt a cycle, not narrate it.
 *
 * A nudge costs a small model attention, so this refuses far more often than
 * it fires -- once per `cooldownTurns`, `maxNudges` in a run.
 */
export interface RepetitionNudger {
	/** The nudge for this turn's reasoning, or nothing. */
	inspect(text: string, turn: number): string | undefined;
	/** How many nudges have been spent. */
	readonly spent: number;
}

export function createRepetitionNudger(
	config: ReasoningRepetitionConfig = DEFAULT_REASONING_REPETITION,
): RepetitionNudger {
	let spent = 0;
	let lastTurn = Number.NEGATIVE_INFINITY;
	return {
		get spent() {
			return spent;
		},
		inspect(text, turn) {
			if (spent >= config.maxNudges) {
				return undefined;
			}
			if (turn - lastTurn < config.cooldownTurns) {
				return undefined;
			}
			const measurement = measureReasoningRepetition(text, config);
			if (!isRepetitionLoop(measurement, config) || !measurement) {
				return undefined;
			}
			spent += 1;
			lastTurn = turn;
			return describeRepetition(measurement);
		},
	};
}

/**
 * Per-session scorer for "this run is not going anywhere".
 *
 * Built from 360 harness run digests, replayed against every run's iteration
 * timeline. Two findings shaped it, and both cut against the obvious design:
 *
 * - **Absolute hedging does not separate anything.** `wait` spans 5.4 to 11.9
 *   per 1,000 reasoning words across thirteen cohorts with no relation to
 *   outcome: the highest rate in the study belongs to a mediocre model and the
 *   lowest to the weakest one in it. What separates a converging run from a
 *   stuck one is whether hedging *decays* -- `hmm` collapses to 14% of its
 *   opening rate in runs that end FIXED and holds at 57% in runs that do not.
 *   So the feature is the ratio of the current window to the run's own opening,
 *   which needs no cross-model calibration.
 * - **Lexical evidence alone is unusable.** `distress10 >= 2` catches 86% of
 *   failures and fires on 62% of successes -- 46% of successes by the good
 *   models, which should almost never be told they are struggling. Behavioural
 *   evidence alone is precise and far too late: `f10 >= 5` arrives with 46
 *   iterations left of a 300-iteration run.
 *
 * The conjunction is what earns its place. Replayed over the corpus it fires at
 * 42% of the way in, leaves 91 iterations of budget to spend differently, and
 * troubles a healthy good-model run once in twenty-five: 56% recall, 15% false
 * alarm overall, 4% on the good models.
 *
 * Diagnosis only, never the consequence -- the same separation the loop
 * detector next door keeps. What this says is what it measured; whether that
 * earns an offer of help, and in what words, belongs to the caller.
 */

import type { AgentEvent } from "@cline/shared";

/** Iterations of history the trigger reads. */
export const STRUGGLE_WINDOW = 10;

/**
 * Failed tool calls in that window before the behavioural half is satisfied.
 *
 * **Six, raised from four when the signal underneath it was corrected.** Four
 * was fitted against `content_end.error`, and our tools almost never set it: a
 * tool that refuses returns `{success: false, error: ...}` as its output and
 * the call is reported as a success. `refusalIn` below now counts both, which
 * moved the measurement by an order of magnitude rather than a little.
 *
 * Replayed over 288 harness runs -- 219 that reached FIXED, 69 that ended
 * broken or timed out -- with the old signal against the new one, at the same
 * thresholds:
 *
 * ```
 *          error only            error + refusal
 *   N=3    3% / 19%              47% / 91%          (false alarm / recall)
 *   N=4    3% / 10%              35% / 87%
 *   N=5    2% /  4%              25% / 74%
 *   N=6    1% /  3%              13% / 57%
 * ```
 *
 * The old four was not a conservative operating point, it was an unreachable
 * one: it caught 10% of the runs that failed. The new four is the opposite
 * problem -- the nudge fires one below the trigger, so four here means the
 * model is nudged on 47% of the runs that go on to succeed. Six restores the
 * intended rarity with 57% recall, which is better than the old number ever
 * delivered, and `STRUGGLE_EDIT_STREAK` covers the loops it gives up.
 */
export const STRUGGLE_FAILED_CALLS = 6;

/** Distress-lexicon hits in the window that satisfy the lexical half. */
export const STRUGGLE_DISTRESS_HITS = 2;

/**
 * Before this iteration nothing fires, whatever the evidence says.
 *
 * A run that is genuinely stuck at iteration 12 is indistinguishable from one
 * that is still reading the problem, and the corpus has no operating point
 * below 20 that is worth its false alarms.
 */
export const STRUGGLE_MIN_ITERATION = 20;

/** Suggestions per task. Two, and at most one per transaction. */
export const STRUGGLE_MAX_PER_TASK = 2;

/**
 * Consecutive failing edits before the model is told to consider the expert.
 *
 * Separate from `STRUGGLE_FAILED_CALLS` because it is a different measurement,
 * not a smaller one. That threshold reads a ten-turn window of every tool the
 * session called; this one reads an unbroken run of calls to the tools that
 * change a file, and it does not care how far apart the turns are.
 *
 * Three, measured. Across 307 harness runs and one 829-message plugin session,
 * the longest unbroken run of refused calls is 2 in a run that finishes and 4
 * to 8 in the three that do not, so 3 is the first value that separates them.
 * Two would fire on healthy runs; four arrives after the loop is established.
 */
export const STRUGGLE_EDIT_STREAK = 3;

/**
 * The operating point, as the user may set it.
 *
 * These are load-bearing and the right numbers are an empirical question we
 * have not finished answering -- the constants above are the best corpus fit
 * so far, and one measured arm (jackod4ac, oracle, n=3) fired the trigger zero
 * times because the change protocol produces no failed tool calls at all.
 * Rather than keep guessing centrally, they are exposed so a run can set them
 * and the defaults can be chosen from evidence.
 *
 * Every field is optional and falls back to the constant, so a host that says
 * nothing behaves exactly as it did.
 */
export interface StruggleThresholds {
	/** Iterations of history the trigger reads. */
	window?: number;
	/** Failed tool calls in that window before the behavioural half is satisfied. */
	failedCalls?: number;
	/** Distress-lexicon hits in the window that satisfy the lexical half. */
	distressHits?: number;
	/** Before this iteration nothing fires, whatever the evidence says. */
	minIteration?: number;
	/** Suggestions per task. */
	maxPerTask?: number;
	/** Consecutive failing edits before the model is told to consider the expert. */
	editStreak?: number;
}

/** A positive integer, or the default. Anything else is not an operating point. */
function positive(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: fallback;
}

export interface ResolvedStruggleThresholds {
	readonly window: number;
	readonly failedCalls: number;
	readonly distressHits: number;
	readonly minIteration: number;
	readonly maxPerTask: number;
	readonly editStreak: number;
}

export function resolveStruggleThresholds(
	given: StruggleThresholds | undefined,
): ResolvedStruggleThresholds {
	return {
		window: positive(given?.window, STRUGGLE_WINDOW),
		failedCalls: positive(given?.failedCalls, STRUGGLE_FAILED_CALLS),
		distressHits: positive(given?.distressHits, STRUGGLE_DISTRESS_HITS),
		minIteration: positive(given?.minIteration, STRUGGLE_MIN_ITERATION),
		maxPerTask: positive(given?.maxPerTask, STRUGGLE_MAX_PER_TASK),
		editStreak: positive(given?.editStreak, STRUGGLE_EDIT_STREAK),
	};
}

/**
 * Phrases that are distress rather than deliberation.
 *
 * `I'm confusing` is the most frequent match in the corpus at 1,628 hits and it
 * is two different things: `I'm confusing myself` is the marker, and `I'm
 * confusing X with Y` is a model correctly noticing it mixed up two names. The
 * first is anchored to `myself` here for exactly that reason -- a lexicon that
 * counted both would be counting competence as distress.
 *
 * `I'm in trouble` is deliberately absent: it was searched for across all 360
 * runs and does not occur.
 *
 * `regressing` was mined from the *plugin's* sessions rather than the harness's
 * runs, and the two populations disagree sharply about it: 86 occurrences in 19
 * of 198 sessions under `~/.cline/data/sessions`, against one in 323 harness
 * runs. It is unanchored, which the paragraph above argues against, and the
 * measurement is why it can be: across both corpora every single occurrence is
 * a report of losing ground -- `my edits keep regressing`, `the file keeps
 * regressing`, `I keep regressing` -- and the competent usage this lexicon
 * usually has to exclude, `avoid regressing the fix`, does not occur once.
 * `regression`, the noun, is a different word and `\b` already excludes it.
 */
const DISTRESS: readonly RegExp[] = [
	/\bi ?'?m confusing myself\b/i,
	/\bi ?'?m confused\b/i,
	/\bkeeps? failing\b/i,
	/\bi ?'?m stuck\b/i,
	/\bi ?'?m not sure\b/i,
	/\bthat makes no sense\b/i,
	/\bregressing\b/i,
];

/**
 * Hedging, counted for its decay and never for its level.
 *
 * See the header: the level is noise across cohorts. These are the markers
 * whose first-fifth-to-last-fifth ratio separated the two populations.
 */
const HEDGING: readonly RegExp[] = [
	/\bwait\b/gi,
	/\bhmm+\b/gi,
	/\blet me reconsider\b/gi,
	/\bdead end\b/gi,
	// `going circles`, without the preposition, was carried here for one
	// commit on a report from a live session, and the report was a typo: the
	// phrase occurs zero times in 198 plugin sessions and 323 harness runs,
	// where every instance is `going in circles`. Out again, on the same rule
	// that keeps `I'm in trouble` out of the distress list -- a pattern with no
	// occurrence behind it is a guess that reads like a measurement.
	/\bin circles\b/gi,
	/\bunexpected\b/gi,
];

/**
 * The refusal a tool reported inside a successful envelope, if it did.
 *
 * `content_end.error` is set only where the runtime marked the whole call an
 * error, and our own tools almost never are: a tool that refuses returns
 * `{success: false, error: "..."}` as its *output* and the call is reported as
 * having succeeded. Measured on one 829-message session, that gap is the whole
 * signal -- 3 calls carried `error`, 50 carried a refusal in the output, and
 * 46 of 162 `editor` calls were refused. A detector reading only the first
 * number is looking at 6% of what the model experienced.
 *
 * A call counts as refused only when nothing in it succeeded. The list-shaped
 * tools return one result per item, so a `read_files` that found two paths of
 * three did work the model can use and is not a failure.
 */
export function refusalIn(output: unknown): string | undefined {
	if (Array.isArray(output)) {
		if (output.length === 0) {
			return undefined;
		}
		let first: string | undefined;
		for (const item of output) {
			const refusal = refusalIn(item);
			if (refusal === undefined) {
				return undefined;
			}
			first ??= refusal;
		}
		return first;
	}
	if (typeof output === "string") {
		const text = output.trim();
		if (text === "" || !(text.startsWith("{") || text.startsWith("["))) {
			return undefined;
		}
		try {
			return refusalIn(JSON.parse(text));
		} catch {
			return undefined;
		}
	}
	if (typeof output !== "object" || output === null) {
		return undefined;
	}
	const record = output as {
		success?: unknown;
		error?: unknown;
		result?: unknown;
	};
	const error =
		typeof record.error === "string" && record.error.trim() !== ""
			? record.error
			: undefined;
	if (record.success === false) {
		// `success: false` is the refusal even where nobody wrote a message.
		return error ?? "the call did not succeed";
	}
	if (error !== undefined && record.success !== true) {
		return error;
	}
	// A wrapper whose own result is the refusal -- `{result: "{...}"}`.
	return record.success === undefined && record.result !== undefined
		? refusalIn(record.result)
		: undefined;
}

/** What one iteration contributed, kept so the window can slide over it. */
interface IterationRecord {
	iteration: number;
	failedCalls: number;
	distress: number;
	hedging: number;
	words: number;
}

export interface StruggleSignals {
	/** The iteration the verdict was asked for. */
	iteration: number;
	/** Failed tool calls in the last `STRUGGLE_WINDOW` iterations. */
	failedCalls: number;
	/** Distress-lexicon hits in the same window. */
	distress: number;
	/**
	 * Hedging in the window as a multiple of the run's own opening rate, or
	 * undefined where there is not yet an opening rate to compare against.
	 */
	hedgingRatio?: number;
}

export interface StruggleVerdict {
	/**
	 * `nudge` is the quieter one, and it arrives first.
	 *
	 * The offer at `suggest` is a real proposal: it costs money or somebody
	 * else's hardware, so it fires late and only on the disjunction. That left
	 * the turn before it silent, which is the turn where saying something is
	 * cheapest. A nudge is one failure short of the trigger, carries no
	 * proposal of its own, and stops as soon as the offer takes over.
	 */
	kind: "ok" | "nudge" | "suggest";
	/**
	 * Which measurement produced it, for a caller that words them differently.
	 *
	 * `failures` is the ten-turn window; `edit-streak` is an unbroken run of
	 * refused edits, which says something the window cannot -- that the model
	 * is not merely failing often but failing at the same thing, in a row.
	 */
	reason?: "failures" | "edit-streak";
	/** What was measured. Never what should be done about it. */
	message?: string;
	signals?: StruggleSignals;
	/**
	 * Files this session has changed, for a caller that can say something about
	 * them the detector cannot -- their complexity, which needs to read them.
	 */
	files?: readonly string[];
}

export interface StruggleTurn {
	iteration: number;
	/** The model's reasoning for that turn, where the provider reports it. */
	reasoning?: string;
}

export interface StruggleToolOutcome {
	iteration: number;
	failed: boolean;
	/** The tool that ran, where the caller knows it. */
	tool?: string;
	/** What the tool said when it refused, where it said anything. */
	refusal?: string;
}

export interface StruggleInspection {
	iteration: number;
}

function count(
	text: string,
	patterns: readonly RegExp[],
	global: boolean,
): number {
	let hits = 0;
	for (const pattern of patterns) {
		if (global) {
			hits += text.match(pattern)?.length ?? 0;
		} else if (pattern.test(text)) {
			hits += 1;
		}
	}
	return hits;
}

function words(text: string): number {
	const trimmed = text.trim();
	return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/** Hedging per 1,000 words, or undefined where there are too few to divide by. */
function rate(hedging: number, wordCount: number): number | undefined {
	return wordCount === 0 ? undefined : (hedging * 1000) / wordCount;
}

/**
 * What the detector measured, in the model's own terms.
 *
 * Written as observation and nothing else. The loop detector's header explains
 * why at length: a message that names a consequence the caller has not decided
 * on describes something that did not happen.
 */
export function describeStruggle(
	signals: StruggleSignals,
	// The operating point can be set per host, and a message that quotes the
	// default window while the detector used another one describes a
	// measurement nobody took.
	thresholds?: StruggleThresholds,
): string {
	const limits = resolveStruggleThresholds(thresholds);
	const lines = [
		`Over your last ${limits.window} turns: ${signals.failedCalls} tool call${
			signals.failedCalls === 1 ? "" : "s"
		} came back as failures or refusals.`,
	];
	if (signals.distress >= limits.distressHits) {
		lines.push(
			`Your own reasoning said so ${signals.distress} times over the same turns — stuck, confused, or that something keeps failing.`,
		);
	}
	if (signals.hedgingRatio !== undefined && signals.hedgingRatio >= 1) {
		lines.push(
			`You are hedging at ${signals.hedgingRatio.toFixed(2)}× the rate you opened this run with, and a run that is converging hedges less as it goes, not the same or more.`,
		);
	}
	return lines.join(" ");
}

/**
 * What an unbroken run of refused edits looks like, in the model's own terms.
 *
 * Observation, like `describeStruggle` next door, and for the same reason: the
 * caller owns what follows from it. What this adds over the window is the word
 * *row* -- a model failing four calls out of ten is having a bad patch, and a
 * model whose last three edits were all refused is trying the same thing.
 */
export function describeEditStreak(
	streak: number,
	lastRefusal?: string,
): string {
	const lines = [
		`Your last ${streak} attempts to change a file were all refused or failed, one after another, with nothing landing in between.`,
	];
	if (lastRefusal !== undefined && lastRefusal.trim() !== "") {
		lines.push(`The most recent said: ${lastRefusal.trim()}`);
	}
	lines.push(
		"Repeating an edit that was refused does not make it land; the reading of the file that produced it is what has to change.",
	);
	return lines.join(" ");
}

/**
 * Tools whose call is an attempt to change a file.
 *
 * `restore_file` is deliberately absent. It changes a file, so it earns its
 * place in `CHANGING_TOOLS` below, but it is a rollback rather than an attempt
 * -- counting it here would read a model correctly undoing its own work as a
 * model failing to edit.
 */
const EDIT_TOOLS = new Set(["editor", "apply_patch"]);

/**
 * Per-session struggle scorer.
 *
 * The caller feeds it turns and tool outcomes and asks `inspect` at a boundary
 * of its choosing. Nothing here reads the clock, the provider or the workspace.
 */
export class StruggleDetector {
	private readonly limits: ResolvedStruggleThresholds;
	private readonly history: IterationRecord[] = [];
	/** The run's opening hedging rate, frozen once the baseline window closes. */
	private baseline?: number;
	private baselineHedging = 0;
	private baselineWords = 0;
	private firedInTask = 0;
	private firedInTransaction = false;
	private transaction = 0;
	private lastFiredKey?: string;
	/**
	 * The nudge repeats while the evidence holds, and the evidence holds for
	 * many calls at a time. Keyed so that saying the same thing twice in a row
	 * -- which inspecting after every tool call would otherwise do several
	 * times per turn -- says it once.
	 */
	private lastNudgeKey?: string;
	/** Consecutive refused edits, counted over edit calls and nothing else. */
	private editStreak = 0;
	private lastEditRefusal?: string;
	/**
	 * Files the session has changed, for the rule that a diagnosis is never
	 * repeated over an unchanged file set.
	 *
	 * A model told it is struggling, which then changes nothing, has been told
	 * everything this can tell it -- and the two-per-task allowance is there
	 * for a run that moved on to different code, not for one saying the same
	 * thing about the same file twice.
	 */
	private readonly changedFiles = new Set<string>();

	constructor(thresholds?: StruggleThresholds) {
		this.limits = resolveStruggleThresholds(thresholds);
	}

	/** The operating point in force, for whoever has to report it. */
	get thresholds(): ResolvedStruggleThresholds {
		return this.limits;
	}

	/** Record a file this session has changed. */
	noteFileChanged(path: string): void {
		this.changedFiles.add(path);
	}

	/** Record a turn's reasoning, which is where both lexicons are counted. */
	noteTurn(turn: StruggleTurn): void {
		const record = this.recordFor(turn.iteration);
		const text = turn.reasoning ?? "";
		if (text === "") {
			return;
		}
		record.distress += count(text, DISTRESS, false);
		record.hedging += count(text, HEDGING, true);
		record.words += words(text);
		this.absorbBaseline(turn.iteration);
	}

	/** Record one tool call's outcome. Only the failures are counted. */
	noteToolOutcome(outcome: StruggleToolOutcome): void {
		// The streak runs over edit calls alone: a read or a command between
		// two refused edits is the model looking for the reason, not a break
		// in the pattern, and resetting on it would hide the loop it is in.
		if (outcome.tool !== undefined && EDIT_TOOLS.has(outcome.tool)) {
			if (outcome.failed) {
				this.editStreak += 1;
				this.lastEditRefusal = outcome.refusal;
			} else {
				this.editStreak = 0;
				this.lastEditRefusal = undefined;
			}
		}
		if (!outcome.failed) {
			// Still recorded, so the iteration exists in the window even when
			// every call in it succeeded.
			this.recordFor(outcome.iteration);
			return;
		}
		this.recordFor(outcome.iteration).failedCalls += 1;
	}

	/**
	 * Context was compacted.
	 *
	 * Never fire across one. Compaction is normal for a long task -- 545
	 * occurrences in the corpus -- and the reasoning the window was counting is
	 * no longer in the conversation, so the evidence for a diagnosis the model
	 * would now be reading for the first time has been deleted. The window
	 * rebuilds from here.
	 */
	noteCompaction(): void {
		this.history.length = 0;
		this.editStreak = 0;
		this.lastEditRefusal = undefined;
		this.lastNudgeKey = undefined;
	}

	/**
	 * The change protocol opened a transaction.
	 *
	 * At most one suggestion per transaction: a second inside the same one is a
	 * repeat of a diagnosis the model has already been given and has not been
	 * able to act on yet.
	 */
	noteTransaction(transaction: number): void {
		if (transaction === this.transaction) {
			return;
		}
		this.transaction = transaction;
		this.firedInTransaction = false;
		this.editStreak = 0;
		this.lastEditRefusal = undefined;
		this.lastNudgeKey = undefined;
	}

	/** The signals as they stand, without the caps or the firing decision. */
	signalsAt(iteration: number): StruggleSignals {
		const window = this.history.filter(
			(record) => record.iteration > iteration - this.limits.window,
		);
		const hedging = window.reduce((sum, record) => sum + record.hedging, 0);
		const wordCount = window.reduce((sum, record) => sum + record.words, 0);
		const current = rate(hedging, wordCount);
		return {
			iteration,
			failedCalls: window.reduce((sum, record) => sum + record.failedCalls, 0),
			distress: window.reduce((sum, record) => sum + record.distress, 0),
			...(this.baseline !== undefined &&
			this.baseline > 0 &&
			current !== undefined
				? { hedgingRatio: current / this.baseline }
				: {}),
		};
	}

	inspect(input: StruggleInspection): StruggleVerdict {
		const { iteration } = input;
		// The offer has already been made in this transaction. Everything below
		// is a way of working up to it, so there is nothing left to say.
		if (this.firedInTransaction) {
			return { kind: "ok" };
		}
		// The streak is deliberately outside `minIteration`. That floor exists
		// because a run stuck at iteration 12 is indistinguishable from one
		// still reading the problem -- true of a hedging rate, and not true of
		// three refused edits in a row, which mean the same thing whenever they
		// happen.
		const streak = this.editStreakVerdict();
		if (streak !== undefined) {
			return streak;
		}
		if (iteration < this.limits.minIteration) {
			return { kind: "ok" };
		}
		const signals = this.signalsAt(iteration);
		if (
			signals.failedCalls < this.limits.failedCalls ||
			this.firedInTask >= this.limits.maxPerTask
		) {
			return this.nudgeAt(signals);
		}
		// The disjunction: either the model said so, or it has stopped getting
		// less unsure. One of the two, never neither -- the failures on their own
		// are the late-and-precise operating point this exists to improve on.
		const lexical = signals.distress >= this.limits.distressHits;
		const noDecay =
			signals.hedgingRatio !== undefined && signals.hedgingRatio >= 1;
		if (!lexical && !noDecay) {
			return this.nudgeAt(signals);
		}
		// Same diagnosis, same files: nothing has happened since it was last
		// said, so saying it again is noise the model has already ignored once.
		const key = `${lexical ? "d" : ""}${noDecay ? "h" : ""}|${[...this.changedFiles].sort().join("\u0000")}`;
		if (key === this.lastFiredKey) {
			return this.nudgeAt(signals);
		}
		this.lastFiredKey = key;
		this.firedInTransaction = true;
		this.firedInTask += 1;
		return {
			kind: "suggest",
			reason: "failures",
			message: describeStruggle(signals, this.limits),
			signals,
		};
	}

	/**
	 * The quieter verdict, one failure short of the offer.
	 *
	 * `failedCalls - 1`, derived rather than configured: the point of it is to
	 * speak on the turn before the trigger, so it has to move when the trigger
	 * moves. A host that sets `failedCalls: 1` gets no nudge at all, which is
	 * right -- there is no turn before the first one.
	 *
	 * It repeats while the count stays in the band, and the band is one wide by
	 * construction, so "repeats" is bounded by how long the model sits at
	 * exactly that many failures.
	 */
	private nudgeAt(signals: StruggleSignals): StruggleVerdict {
		if (
			this.limits.failedCalls <= 1 ||
			signals.failedCalls < this.limits.failedCalls - 1
		) {
			return { kind: "ok" };
		}
		return this.nudge(
			"failures",
			`f${signals.failedCalls}`,
			describeStruggle(signals, this.limits),
			signals,
		);
	}

	/**
	 * Three refused edits in a row, said once per new value of "three".
	 *
	 * It speaks again only once as much evidence has accumulated again -- at
	 * three, then six, then nine. A model that has already been told about the
	 * third refusal learns nothing from being told about the fourth, and a
	 * nudge that arrives on every one of them is how a diagnosis stops being
	 * read. The longest streak in the corpus is nine, so this is at most three
	 * messages in the worst run measured.
	 */
	private editStreakVerdict(): StruggleVerdict | undefined {
		if (
			this.editStreak < this.limits.editStreak ||
			this.editStreak % this.limits.editStreak !== 0
		) {
			return undefined;
		}
		const verdict = this.nudge(
			"edit-streak",
			`e${this.editStreak}`,
			describeEditStreak(this.editStreak, this.lastEditRefusal),
		);
		return verdict.kind === "ok" ? undefined : verdict;
	}

	/**
	 * Emit a nudge, or nothing if it would repeat the last one verbatim.
	 *
	 * `inspect` is asked after every tool call and every block of reasoning, so
	 * the same evidence is read many times per turn. Without this the model
	 * would be told the same thing four times in one reply, which is how a
	 * diagnosis stops being read.
	 */
	private nudge(
		reason: "failures" | "edit-streak",
		key: string,
		message: string,
		signals?: StruggleSignals,
	): StruggleVerdict {
		const full = `${reason}:${key}`;
		if (full === this.lastNudgeKey) {
			return { kind: "ok" };
		}
		this.lastNudgeKey = full;
		return {
			kind: "nudge",
			reason,
			message,
			...(signals ? { signals } : {}),
			files: [...this.changedFiles],
		};
	}

	private recordFor(iteration: number): IterationRecord {
		const last = this.history.at(-1);
		if (last?.iteration === iteration) {
			return last;
		}
		const record: IterationRecord = {
			iteration,
			failedCalls: 0,
			distress: 0,
			hedging: 0,
			words: 0,
		};
		this.history.push(record);
		// Only the window is ever read, and a long run would otherwise hold
		// every iteration it has had.
		while (this.history.length > this.limits.window * 2) {
			this.history.shift();
		}
		return record;
	}

	/**
	 * Fold a turn into the run's opening rate while the baseline is still open.
	 *
	 * Frozen after the first `STRUGGLE_WINDOW` iterations, because the
	 * comparison is against how this run started and a baseline that kept
	 * moving would converge on the window it is being compared to.
	 */
	private absorbBaseline(iteration: number): void {
		if (iteration > this.limits.window) {
			return;
		}
		// Recomputed from the records rather than accumulated, so two turns
		// noted for one iteration cannot double-count into the baseline.
		const opening = this.history.filter(
			(entry) => entry.iteration <= this.limits.window,
		);
		this.baselineHedging = opening.reduce(
			(sum, entry) => sum + entry.hedging,
			0,
		);
		this.baselineWords = opening.reduce((sum, entry) => sum + entry.words, 0);
		this.baseline = rate(this.baselineHedging, this.baselineWords);
	}
}

/**
 * Tools that change a file, so the detector can tell one diagnosis from the
 * next by what has moved since.
 */
const CHANGING_TOOLS = new Set(["editor", "apply_patch", "restore_file"]);

export interface StruggleFeed {
	/** Fold one agent event into the detector, and inspect at a turn's end. */
	observe(event: AgentEvent): void;
}

/**
 * Drive a detector from the session's own event stream.
 *
 * Everything the trigger needs is already on the wire: `iteration_start`
 * carries the cursor, `content_end` carries the turn's reasoning and each tool
 * call's error, and `content_start` carries the tool input the file set is read
 * from. Nothing here reaches into the runtime.
 *
 * `onVerdict` fires after every tool result, after every block of reasoning,
 * and at the end of a turn. It used to fire only at the turn boundary, on the
 * argument that a diagnosis arriving between two tool calls of one reply lands
 * in the middle of work the model has already decided on. That argument was
 * wrong about where the message goes: the caller holds the verdict and attaches
 * it to the next tool result, so inspecting sooner does not interrupt anything
 * -- it only stops the evidence waiting for a turn that a looping model may
 * take hundreds of calls to end. The detector dedupes, so reading the same
 * evidence four times in one reply still says it once.
 *
 * It receives both verdicts that carry something -- the offer and the nudge
 * below it -- and never `ok`.
 */
export function createStruggleFeed(
	detector: StruggleDetector,
	onVerdict: (verdict: StruggleVerdict) => void,
): StruggleFeed {
	let iteration = 0;
	/**
	 * Whether this session's provider reports reasoning separately.
	 *
	 * Both lexicons are counted over the model's reasoning, and a model with
	 * thinking off has none -- it reasons in the message, in the open. Until a
	 * reasoning block has actually arrived, the text block is read as the
	 * reasoning it is standing in for; after one has, text is the answer and
	 * counting it would be counting the reply to the user as distress.
	 */
	let sawReasoning = false;
	const publish = (verdict: StruggleVerdict): void => {
		if (verdict.kind !== "ok") {
			onVerdict(verdict);
		}
	};
	return {
		observe(event: AgentEvent): void {
			switch (event.type) {
				case "iteration_start":
					iteration = event.iteration;
					return;
				case "content_start": {
					if (
						event.contentType !== "tool" ||
						!event.toolName ||
						!CHANGING_TOOLS.has(event.toolName)
					) {
						return;
					}
					const input = event.input;
					const path =
						input && typeof input === "object"
							? (input as { path?: unknown }).path
							: undefined;
					if (typeof path === "string" && path !== "") {
						detector.noteFileChanged(path);
					}
					return;
				}
				case "content_end":
					if (event.contentType === "reasoning") {
						const reasoning = event.reasoning ?? event.text ?? "";
						sawReasoning = sawReasoning || reasoning.trim() !== "";
						detector.noteTurn({ iteration, reasoning });
						publish(detector.inspect({ iteration }));
					} else if (event.contentType === "text") {
						if (sawReasoning) {
							return;
						}
						detector.noteTurn({ iteration, reasoning: event.text ?? "" });
						publish(detector.inspect({ iteration }));
					} else if (event.contentType === "tool") {
						// Both halves of what the model experienced: the error
						// the runtime raised, and the refusal the tool returned
						// inside a result it called a success.
						const refusal = event.error ?? refusalIn(event.output);
						detector.noteToolOutcome({
							iteration,
							failed: refusal !== undefined,
							tool: event.toolName,
							...(refusal !== undefined ? { refusal } : {}),
						});
						publish(detector.inspect({ iteration }));
					}
					return;
				case "iteration_end":
					publish(detector.inspect({ iteration: event.iteration }));
					return;
				default:
					return;
			}
		},
	};
}

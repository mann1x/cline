/**
 * Streaming repetition guard for the model's reasoning channel.
 *
 * A model that collapses into a repetition cycle mid-thought will keep
 * generating until something stops it. Locally that is `think_budget`, which
 * cuts the block at a token budget -- but a provider that does not implement a
 * thinking budget (Ollama Cloud, today) leaves nothing between a degenerate
 * draw and the context window. This is the first client-side enforcement of a
 * thinking limit in this codebase; everywhere else a budget is only ever sent
 * to a provider and inferred back (see extensions/context/capped-thinking.ts).
 *
 * Three signals, all derived from real collapses rather than invented:
 *
 *   low-uniqueness  a full window of completed lines carrying almost no
 *                   distinct lines. mann1x/cline#69 (GLM-5.3-Flash) spent its
 *                   first 60k characters flipping two checklist items between
 *                   "[ ]" and "[x]", which defeats an exact-period test but is
 *                   unmistakable by this measure.
 *   line-cycle      the same 1..N lines repeating with an exact period.
 *   phrase-cycle    no newlines at all -- one fragment repeating inside a
 *                   single unbroken line ("and I'll do it, and I'll do it...").
 *
 * Length is never the signal. Healthy agentic reasoning on our own harness runs
 * to 150k-260k characters per turn, and a guard that fired on volume would kill
 * every good turn. Only periodicity trips it.
 *
 * Thresholds were set against real data, not intuition: 1,556 reasoning blocks
 * from 82 recorded v7-coder sessions, plus 196k characters of reasoning from a
 * run that successfully completed its task. The deliberately-omitted signal is
 * the answer-channel oracle (tail distinct-5-gram ratio < 0.30), which fires on
 * 2 of 5 healthy blocks from a successful run -- fine for offline labelling,
 * unusable for a guard that aborts live turns.
 */

import type { AgentMessage, ReasoningLoopDetectionConfig } from "@cline/shared";

/**
 * The detector's thresholds. Defined in `@cline/shared` so a host can set them
 * through `execution.reasoningLoopDetection` without depending on this package.
 */
export type ReasoningLoopGuardConfig = ReasoningLoopDetectionConfig;

export const DEFAULT_REASONING_LOOP_GUARD: ReasoningLoopGuardConfig = {
	minChars: 4000,
	window: 60,
	maxPeriod: 6,
	minCycles: 20,
	maxUniqueInWindow: 4,
	minLineChars: 2000,
	phraseMaxPeriod: 120,
	phraseMinCycles: 12,
	maxConsecutiveTrips: 3,
};

export type ReasoningLoopKind =
	| "low-uniqueness"
	| "line-cycle"
	| "phrase-cycle";

export interface ReasoningLoopVerdict {
	kind: ReasoningLoopKind;
	/** Characters of reasoning seen when the guard tripped. */
	chars: number;
	/** Cycle length in lines, or in characters for a phrase cycle. */
	period?: number;
	cycles?: number;
	distinct?: number;
	/** A short excerpt of the repeating unit, for the message shown to the user. */
	sample: string;
}

/**
 * Describes what was detected. Deliberately the diagnosis only, never the
 * consequence -- the caller decides what to do about it, the same rule the
 * tool-call loop detector follows.
 */
export function describeReasoningLoop(v: ReasoningLoopVerdict): string {
	const where = `after ${v.chars.toLocaleString()} characters of reasoning`;
	const sample = v.sample ? ` Repeating: ${JSON.stringify(v.sample)}` : "";
	switch (v.kind) {
		case "low-uniqueness":
			return `The model's reasoning collapsed into ${v.distinct} distinct lines over ${where}.${sample}`;
		case "line-cycle":
			return `The model's reasoning repeated a ${v.period}-line block ${v.cycles} times ${where}.${sample}`;
		case "phrase-cycle":
			return `The model's reasoning repeated a ${v.period}-character phrase ${v.cycles} times ${where}.${sample}`;
	}
}

/**
 * What the model was handed in this conversation: the user's text and every
 * tool result, as plain text. Not its own earlier turns -- a loop the model
 * wrote last turn must not excuse the same loop this turn.
 */
export function contentGivenToModel(messages: readonly AgentMessage[]): string {
	const out: string[] = [];
	const collect = (value: unknown, depth: number): void => {
		if (typeof value === "string") {
			if (value) out.push(value);
		} else if (depth < 6 && Array.isArray(value)) {
			for (const entry of value) collect(entry, depth + 1);
		} else if (depth < 6 && value !== null && typeof value === "object") {
			for (const entry of Object.values(value)) collect(entry, depth + 1);
		}
	};
	for (const message of messages) {
		if (message.role === "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text") {
				collect((part as { text?: unknown }).text, 0);
			} else if (part.type === "tool-result") {
				collect((part as { output?: unknown }).output, 0);
			}
		}
	}
	return out.join("\n");
}

/** A `read_files` line number, which a model restating the line leaves off. */
const LINE_NUMBER_PREFIX = /^\d+\s*\|\s?/;

function comparableLine(line: string): string {
	return line.trim().replace(LINE_NUMBER_PREFIX, "").trim();
}

export interface ReasoningLoopGuardOptions {
	/**
	 * The content the model was given, asked for only when the guard is about
	 * to trip. Repetition that is already in it, at least as long, is the model
	 * restating what it read and not a collapse.
	 *
	 * The run it comes from (pandorum, session 91q5q, 2026-08-03): asked to
	 * embed a sound in a page, the model read `coin.mp3` as base64 and copied
	 * it into its reasoning. The file's padding is 484 `V` characters in a row,
	 * and thirteen `VVVV` is a phrase cycle. Four blocks of that session are
	 * that; a fifth ran on to 2,942 where the file has 484, and is the collapse
	 * the guard exists for. So the measure is length against the source, never
	 * "it appears in the source". Replayed over 22,252 stored reasoning blocks
	 * and 65,716 recorded ones, this excuses those four blocks and no other.
	 */
	given?: () => string;
}

export class ReasoningLoopGuard {
	private readonly cfg: ReasoningLoopGuardConfig;
	private readonly given: (() => string) | undefined;
	private chars = 0;
	private lines: string[] = [];
	/** Every completed line of the block, kept only when there is a source. */
	private history: string[] = [];
	private pending = "";
	private verdict: ReasoningLoopVerdict | null = null;
	private source: { text: string; lines: string[] } | undefined;
	private readonly sourceRuns = new Map<string, number>();

	constructor(
		config: Partial<ReasoningLoopGuardConfig> = {},
		options: ReasoningLoopGuardOptions = {},
	) {
		this.cfg = { ...DEFAULT_REASONING_LOOP_GUARD, ...config };
		this.given = options.given;
	}

	get tripped(): ReasoningLoopVerdict | null {
		return this.verdict;
	}

	/**
	 * Feed one reasoning delta. Returns a verdict the first time the block is
	 * judged degenerate, and the same verdict on every call after that, so a
	 * caller that keeps streaming does not act on it twice.
	 */
	push(delta: string): ReasoningLoopVerdict | null {
		if (this.verdict || !delta) return this.verdict;
		this.chars += delta.length;
		this.pending += delta;

		let nl: number;
		while ((nl = this.pending.indexOf("\n")) !== -1) {
			const line = this.pending.slice(0, nl).trim();
			this.pending = this.pending.slice(nl + 1);
			if (line) {
				this.lines.push(line);
				if (this.lines.length > this.cfg.window) this.lines.shift();
				if (this.given) this.history.push(line);
			}
		}
		if (this.chars < this.cfg.minChars) return null;

		const found =
			this.detectLowUniqueness() ??
			this.detectLineCycle() ??
			this.detectPhraseCycle();
		if (found) this.verdict = found;
		return this.verdict;
	}

	/** The source, read once, and only when a verdict is about to be given. */
	private readSource(): { text: string; lines: string[] } | undefined {
		if (!this.given) return undefined;
		if (!this.source) {
			let text = "";
			try {
				text = this.given();
			} catch {
				// No source is no excuse: the guard behaves as it does without one.
			}
			this.source = {
				text,
				lines: text
					.split("\n")
					.map(comparableLine)
					.filter((line) => line !== ""),
			};
		}
		return this.source.text ? this.source : undefined;
	}

	private remembered(key: string, measure: () => number): number {
		let run = this.sourceRuns.get(key);
		if (run === undefined) {
			run = measure();
			// Rotations of one phrase are different keys; a long excused stretch
			// must not grow this without bound.
			if (this.sourceRuns.size > 512) this.sourceRuns.clear();
			this.sourceRuns.set(key, run);
		}
		return run;
	}

	/** Longest run of `unit` back to back in the source, in repeats. */
	private phraseRunInSource(unit: string): number {
		const source = this.readSource();
		if (!source) return 0;
		return this.remembered(`p\n${unit}`, () => {
			let best = 0;
			let at = source.text.indexOf(unit);
			while (at !== -1) {
				let run = 1;
				let next = at + unit.length;
				while (source.text.startsWith(unit, next)) {
					run++;
					next += unit.length;
				}
				if (run > best) best = run;
				at = source.text.indexOf(unit, next);
			}
			return best;
		});
	}

	/** Longest run of this block of lines back to back in the source. */
	private blockRunInSource(block: readonly string[]): number {
		const source = this.readSource();
		if (!source) return 0;
		const unit = block.map(comparableLine);
		return this.remembered(`b\n${unit.join("\n")}`, () => {
			const lines = source.lines;
			const p = unit.length;
			let best = 0;
			for (let i = 0; i + p <= lines.length; i++) {
				let run = 0;
				let at = i;
				while (at + p <= lines.length) {
					let same = true;
					for (let k = 0; k < p; k++) {
						if (lines[at + k] !== unit[k]) {
							same = false;
							break;
						}
					}
					if (!same) break;
					run++;
					at += p;
				}
				if (run > best) best = run;
				// A run ending here cannot be beaten by one starting inside it.
				if (run > 1) i = at - p;
			}
			return best;
		});
	}

	/** Longest stretch of source lines drawn only from `distinct`. */
	private stretchInSource(distinct: ReadonlySet<string>): number {
		const source = this.readSource();
		if (!source) return 0;
		const allowed = new Set([...distinct].map(comparableLine));
		return this.remembered(`s\n${[...allowed].sort().join("\n")}`, () => {
			let best = 0;
			let run = 0;
			for (const line of source.lines) {
				run = allowed.has(line) ? run + 1 : 0;
				if (run > best) best = run;
			}
			return best;
		});
	}

	private detectLowUniqueness(): ReasoningLoopVerdict | null {
		if (this.lines.length < this.cfg.window) return null;
		const distinct = new Set(this.lines);
		if (distinct.size > this.cfg.maxUniqueInWindow) return null;
		if (this.given) {
			// How long this block has now stayed inside those few lines, less how
			// long the source does: what is left has to fill a window by itself.
			// A restated stretch followed by one line of the model's own is
			// still a window of few distinct lines, and still not a collapse.
			let stretch = 0;
			for (
				let i = this.history.length - 1;
				i >= 0 && distinct.has(this.history[i] as string);
				i--
			) {
				stretch++;
			}
			if (stretch - this.stretchInSource(distinct) < this.cfg.window) {
				return null;
			}
		}
		return {
			kind: "low-uniqueness",
			distinct: distinct.size,
			chars: this.chars,
			sample: [...distinct].join(" / ").slice(0, 160),
		};
	}

	private detectLineCycle(): ReasoningLoopVerdict | null {
		const n = this.lines.length;
		if (n < this.cfg.maxPeriod * 2) return null;
		for (let p = 1; p <= this.cfg.maxPeriod; p++) {
			let cycles = 0;
			for (let i = n - p; i - p >= 0; i -= p) {
				let same = true;
				for (let k = 0; k < p; k++) {
					if (this.lines[i + k] !== this.lines[i - p + k]) {
						same = false;
						break;
					}
				}
				if (!same) break;
				cycles++;
			}
			if (cycles >= this.cfg.minCycles) {
				if (this.given) {
					// The window holds 60 lines, so it cannot say whether the block
					// has outrun a source that repeats for longer. The history can.
					const all = this.history;
					let repeats = 1;
					for (let i = all.length - p; i - p >= 0; i -= p) {
						let same = true;
						for (let k = 0; k < p; k++) {
							if (all[i + k] !== all[i - p + k]) {
								same = false;
								break;
							}
						}
						if (!same) break;
						repeats++;
					}
					if (repeats <= this.blockRunInSource(this.lines.slice(n - p))) {
						continue;
					}
				}
				return {
					kind: "line-cycle",
					period: p,
					cycles: cycles + 1,
					chars: this.chars,
					sample: this.lines
						.slice(n - p)
						.join(" / ")
						.slice(0, 160),
				};
			}
		}
		return null;
	}

	private detectPhraseCycle(): ReasoningLoopVerdict | null {
		const tail = this.pending;
		if (tail.length < this.cfg.minLineChars) return null;
		for (let p = 4; p <= this.cfg.phraseMaxPeriod; p++) {
			const unit = tail.slice(tail.length - p);
			let cycles = 0;
			let at = tail.length - p;
			while (at - p >= 0 && tail.startsWith(unit, at - p)) {
				cycles++;
				at -= p;
			}
			if (cycles >= this.cfg.phraseMinCycles) {
				if (cycles + 1 <= this.phraseRunInSource(unit)) continue;
				return {
					kind: "phrase-cycle",
					period: p,
					cycles: cycles + 1,
					chars: this.chars,
					sample: unit.replace(/\s+/g, " ").slice(0, 160),
				};
			}
		}
		return null;
	}
}

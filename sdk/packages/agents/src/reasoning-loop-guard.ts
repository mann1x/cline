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

import type { ReasoningLoopDetectionConfig } from "@cline/shared";

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

export class ReasoningLoopGuard {
	private readonly cfg: ReasoningLoopGuardConfig;
	private chars = 0;
	private lines: string[] = [];
	private pending = "";
	private verdict: ReasoningLoopVerdict | null = null;

	constructor(config: Partial<ReasoningLoopGuardConfig> = {}) {
		this.cfg = { ...DEFAULT_REASONING_LOOP_GUARD, ...config };
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

	private detectLowUniqueness(): ReasoningLoopVerdict | null {
		if (this.lines.length < this.cfg.window) return null;
		const distinct = new Set(this.lines);
		if (distinct.size > this.cfg.maxUniqueInWindow) return null;
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

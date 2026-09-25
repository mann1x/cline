/**
 * Why a compaction ran, in the four words a reader of an agent's row can use.
 *
 * The notice's `kind` already separates manual from automatic from overflow
 * recovery, but "automatic" folds two different stories together: an agent
 * that filled its own window, and one that was compacted because the server
 * was short of cells for everybody else (global KV pressure). With every agent
 * given the same 64k window, those are the two answers to "why did this one
 * compact" -- so the notice names which.
 *
 * Precedence: a request that crossed its own threshold is "auto" even when the
 * server was also under pressure -- it would have compacted anyway. Pressure
 * is named only when it is the reason the compaction happened at all.
 */
export type CompactionCause = "auto" | "pressure" | "overflow" | "manual";

export const COMPACTION_CAUSES: readonly CompactionCause[] = [
	"auto",
	"pressure",
	"overflow",
	"manual",
];

export function resolveCompactionCause(input: {
	mode: "auto" | "manual" | "overflow_recovery";
	/** The provider reported this session's request over its window. */
	contextOverflow: boolean;
	/** The request crossed this session's own trigger threshold. */
	overOwnThreshold: boolean;
	/** The window-bound output cap fell below what a reply needs. */
	outputCapStarved: boolean;
	/** The engine's pressure signals: PolyKV capacity or global KV pressure. */
	pressure: boolean;
}): CompactionCause {
	if (input.mode === "manual") {
		return "manual";
	}
	if (input.mode === "overflow_recovery" || input.contextOverflow) {
		return "overflow";
	}
	if (input.overOwnThreshold || input.outputCapStarved) {
		return "auto";
	}
	return input.pressure ? "pressure" : "auto";
}

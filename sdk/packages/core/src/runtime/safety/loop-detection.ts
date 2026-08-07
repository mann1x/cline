/**
 * Repeated tool-call loop detection.
 *
 * @see PLAN.md §3.1 — helpers moved from `packages/agents/src/context/loop-detection.ts`.
 * @see PLAN.md §3.2.3 — public surface of `LoopDetectionTracker`.
 *
 * The pure helpers (`createLoopDetectionState`, `resetLoopDetectionState`,
 * `toolCallSignature`, `checkRepeatedToolCall`) are ported verbatim. The
 * `LoopDetectionTracker` class is a thin wrapper that owns a
 * `LoopDetectionState` and exposes the `inspect()` / `reset()` surface that
 * `SessionRuntime` installs as a `beforeTool` hook per §3.2.3.
 */

import type { LoopDetectionConfig } from "@cline/shared";

// =============================================================================
// Pure helpers (verbatim port)
// =============================================================================

/**
 * How many times one call may fail, be interrupted, and be sent again.
 *
 * The consecutive counter is defeated by any call in between. Measured on a
 * live session: the same `editor` call — same path, same range, the same 684
 * characters — was sent twelve times and reported "No change" every time. Two
 * calls to a different line in the middle reset the consecutive count twice,
 * so the hard stop did not arrive until the twelfth. Counting per signature
 * instead of per adjacency ends it at the fifth.
 *
 * Only failures count, which is what makes this safe. Re-running the same test
 * command after each edit, or re-checking the same file, is how work gets done;
 * those calls succeed, and a success clears the tally for that signature. What
 * accrues here is strictly a call that has been tried and got nowhere.
 */
const BARREN_REPEAT_LIMIT = 5;

export interface LoopDetectionState {
	lastToolName: string;
	lastToolSignature: string;
	consecutiveIdenticalCount: number;
	/** Per `name:signature`, how many times it has been tried and failed. */
	barrenCounts: Map<string, number>;
	/**
	 * Signatures the tool has declared no-ops. Separate from `barrenCounts`
	 * because this is not a tally: one such outcome is already conclusive.
	 */
	futileKeys: Set<string>;
	/** The call awaiting its outcome, so the result can be attributed. */
	pendingKey: string;
}

export function createLoopDetectionState(): LoopDetectionState {
	return {
		lastToolName: "",
		lastToolSignature: "",
		consecutiveIdenticalCount: 0,
		barrenCounts: new Map(),
		futileKeys: new Set(),
		pendingKey: "",
	};
}

export function resetLoopDetectionState(state: LoopDetectionState): void {
	state.lastToolName = "";
	state.lastToolSignature = "";
	state.consecutiveIdenticalCount = 0;
	state.barrenCounts.clear();
	state.futileKeys.clear();
	state.pendingKey = "";
}

function sortKeys(value: unknown): unknown {
	if (value == null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(sortKeys);
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
	}
	return sorted;
}

export function toolCallSignature(input: unknown): string {
	if (input == null) return "null";
	if (typeof input === "string") return input;
	if (typeof input !== "object") return String(input);
	try {
		return JSON.stringify(sortKeys(input));
	} catch {
		return String(input);
	}
}

export interface LoopCheckResult {
	softWarning: boolean;
	hardEscalation: boolean;
}

export function checkRepeatedToolCall(
	state: LoopDetectionState,
	toolName: string,
	signature: string,
	config: LoopDetectionConfig,
): LoopCheckResult {
	if (
		toolName === state.lastToolName &&
		signature === state.lastToolSignature
	) {
		state.consecutiveIdenticalCount++;
	} else {
		state.consecutiveIdenticalCount = 1;
	}
	state.lastToolName = toolName;
	state.lastToolSignature = signature;

	return {
		softWarning: state.consecutiveIdenticalCount === config.softThreshold,
		hardEscalation: state.consecutiveIdenticalCount >= config.hardThreshold,
	};
}

// =============================================================================
// Class wrapper (new — per PLAN.md §3.2.3)
// =============================================================================

/**
 * Verdict returned by {@link LoopDetectionTracker.inspect}.
 *
 * - `"ok"`   — no repeated call detected.
 * - `"soft"` — soft-warning threshold reached; SessionRuntime may surface a
 *              recovery notice but should not block the call.
 * - `"hard"` — hard-escalation threshold reached; SessionRuntime should
 *              stop the run with the provided `message`.
 */
export interface LoopDetectionVerdict {
	kind: "ok" | "soft" | "hard";
	message?: string;
}

/** Minimal call shape the tracker needs; matches `AgentToolCallPart` subset. */
export interface LoopDetectionCall {
	name: string;
	input: unknown;
}

const DEFAULT_CONFIG: LoopDetectionConfig = {
	softThreshold: 3,
	hardThreshold: 5,
};

/**
 * Per-session repeated-tool-call detector.
 *
 * `SessionRuntime` owns the instance and installs a `beforeTool` hook
 * (see `AgentRuntimeHooks.beforeTool`) that calls `inspect()` to decide
 * whether to return `{ skip, stop, reason }`.
 */
export class LoopDetectionTracker {
	private readonly config: LoopDetectionConfig;
	private readonly state: LoopDetectionState = createLoopDetectionState();

	constructor(config?: Partial<LoopDetectionConfig>) {
		this.config = {
			softThreshold: config?.softThreshold ?? DEFAULT_CONFIG.softThreshold,
			hardThreshold: config?.hardThreshold ?? DEFAULT_CONFIG.hardThreshold,
		};
	}

	inspect(call: LoopDetectionCall): LoopDetectionVerdict {
		const signature = toolCallSignature(call.input);
		const key = `${call.name}:${signature}`;
		this.state.pendingKey = key;

		// A call the tool has already declared a no-op does not get five tries.
		// The barren counter is for calls that fail for reasons that might change
		// — a file that was locked, a range that has since moved. This is not one
		// of those: the tool compared the payload against the file and found them
		// identical, and the payload is byte-for-byte the same one. Measured: the
		// same `editor` call, lines 94-96 and the same 1,336 characters, sent
		// seven times against six "No change" refusals, with a full re-read of
		// the file between four of them. Twenty-four minutes, no edit, and the
		// run died on the loop stop anyway — so the only thing the extra five
		// attempts bought was the time.
		if (this.state.futileKeys.has(key)) {
			return {
				kind: "hard",
				message: `This exact call to \`${call.name}\` was already refused because what it sends is character-for-character what the file already holds. The arguments are unchanged, so the result cannot be either. Stopping to avoid a loop — the fix belongs somewhere other than this call: a different range, different text, or a different tool.`,
			};
		}

		const barren = this.state.barrenCounts.get(key) ?? 0;
		if (barren >= BARREN_REPEAT_LIMIT) {
			return {
				kind: "hard",
				message: `This exact call to \`${call.name}\` has already been made ${barren} times and failed every time; stopping to avoid a loop. The arguments have not changed between attempts, so neither will the result — the next attempt needs different arguments or a different tool.`,
			};
		}

		const result = checkRepeatedToolCall(
			this.state,
			call.name,
			signature,
			this.config,
		);
		if (result.hardEscalation) {
			return {
				kind: "hard",
				message: `Detected ${this.state.consecutiveIdenticalCount} consecutive identical calls to \`${call.name}\`; stopping to avoid a loop.`,
			};
		}
		if (result.softWarning) {
			return {
				kind: "soft",
				message: `Detected ${this.state.consecutiveIdenticalCount} consecutive identical calls to \`${call.name}\`; consider trying a different approach.`,
			};
		}
		return { kind: "ok" };
	}

	/**
	 * Attribute an outcome to the call `inspect()` last saw.
	 *
	 * A productive call clears its own tally rather than merely not adding to
	 * it: a command that works, stops working, then works again is a normal
	 * edit-test cycle, and it should not inherit a count from the failures in
	 * between.
	 */
	noteOutcome(productive: boolean, futile = false): void {
		const key = this.state.pendingKey;
		if (key === "") {
			return;
		}
		if (productive) {
			this.state.barrenCounts.delete(key);
			this.state.futileKeys.delete(key);
			return;
		}
		if (futile) {
			// Recorded rather than counted: the next identical call is stopped on
			// sight, because the tool has already compared this payload against
			// the file and found nothing to do.
			this.state.futileKeys.add(key);
			return;
		}
		this.state.barrenCounts.set(
			key,
			(this.state.barrenCounts.get(key) ?? 0) + 1,
		);
	}

	reset(): void {
		resetLoopDetectionState(this.state);
	}
}

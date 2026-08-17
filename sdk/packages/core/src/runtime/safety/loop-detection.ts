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
 * How many times one call may fail, be told so, and be sent again unchanged
 * before the run is stopped.
 *
 * Counted per signature, not per adjacency: the consecutive counter is defeated
 * by any call in between. Measured on a live session, the same `editor` call —
 * same path, same range, the same 684 characters — was sent twelve times and
 * reported "No change" every time, because two calls to a different line in the
 * middle reset the consecutive count twice.
 *
 * Only failures count, which is what makes this safe. Re-running the same test
 * command after each edit, or re-checking the same file, is how work gets done;
 * those calls succeed, and a success clears the tally for that signature. What
 * accrues here is strictly a call that has been tried and got nowhere.
 *
 * The value matches `maxConsecutiveMistakes` deliberately: those two are the
 * only things that stop a run for repetition, and a model told it has "strikes
 * left" should not discover that a second, shorter budget was also counting.
 * The first failure is free of any countdown — one failure is ordinary, and a
 * warning there would cry wolf. Every attempt after it is warned by name, so by
 * the time the run stops the model has been told five times, ending with the
 * last-strike notice.
 */
const STRIKE_LIMIT = 6;

/**
 * The same countdown, for a call the tool has already answered in advance.
 *
 * Six strikes is a budget for failures that might come out differently -- a
 * locked file, a range that has since moved. A refusal the tool reached by
 * comparing the payload against the file is not one of those: identical
 * arguments give an identical answer, provably, and every strike after the
 * advice runs out buys another turn of the same thing. Measured live, at six:
 * one 4,991-character replacement sent seven times, ~5,000 output tokens each,
 * and the run stopped anyway.
 *
 * Four, so the ladder finishes rather than repeats. The three warnings are
 * distinct moves -- look at what is there, address it differently, leave it and
 * work on something else -- and the fourth attempt is the one taken after all
 * three were read. Stopping there is stopping when the advice is spent, which
 * is the last moment the stop can still be about the model's behaviour rather
 * than about the budget.
 */
const FUTILE_STRIKE_LIMIT = 4;

/**
 * The countdown itself, in the model's own second person.
 *
 * Escalating rather than uniform because a repeated identical warning reads as
 * boilerplate — the point is that the last one cannot be mistaken for the first.
 */
function strikeWarning(remaining: number): string {
	if (remaining <= 1) {
		return "WARNING: this is the LAST strike! Another failure and the system will STOP the session! Do not send this call again — change the arguments, use a different tool, or say what you are stuck on.";
	}
	return `Warning: you have only ${remaining} strikes left before the system will stop the session. Sending the same call again spends one for nothing.`;
}

/**
 * Somewhere to go, which the countdown alone does not give.
 *
 * Measured: one transaction took nine `strikes left` warnings and the
 * last-strike notice — ten in all — and was still stopped for repeating the
 * same call. Every one of those told it the run was ending and none told it
 * what to do instead, so it kept doing the only thing it had. The transcripts
 * show the model reaching for this by itself: "let me take a fundamentally
 * different approach" appears fourteen times in one transaction, arrived at
 * unaided and too late.
 *
 * So the warning now carries a different concrete move each time, and they
 * escalate in scope rather than in volume: check the state, then change how
 * the call is addressed, then change what is being worked on at all. A model
 * that has read the same instruction three times has learned nothing from the
 * third; one that is handed a new thing to try has somewhere to put the turn.
 *
 * Kept to one short paragraph each. This rides on a tool result the model is
 * already reading, and a wall of advice under a failed call is skimmed.
 */
function steeringFor(attempt: number, toolName: string): string {
	if (attempt <= 1) {
		return `Before sending anything else: look at what this call targets as it is right now, with a tool that reads rather than writes, and compare that against what you meant it to be. If it already says what you wanted, this piece is done — record that and move to the next one.`;
	}
	if (attempt === 2) {
		// The addressing advice is only true for a tool that edits by matching
		// text, and naming the wrong remedy is worse than naming none: a model
		// told to "use coordinates" on a shell command will invent something.
		return EDITING_TOOL_NAMES.has(toolName)
			? `If it does not say what you wanted, this call is not landing where you think it is. Change how it addresses the file rather than what it writes: give \`start_line\` and \`start_column\` in place of \`old_text\`, keeping \`new_text\` — the replacement body is still required and is still called \`new_text\`. Matching text is exactly what fails on a long or minified line, and a position cannot be mistyped into matching nothing.`
			: `If the answer matters, change what produces it rather than asking again. Nothing about this call has changed, so nothing about its answer can — something has to happen first: make the edit, or use a different tool that answers the same question from the file itself.`;
	}
	return `Leave this alone now. Take the next thing that is still wrong and work on that; come back here only with something you have not already tried. If there is nothing else wrong, say in one sentence what is blocking you and stop — that is more use than another attempt.`;
}

/**
 * What a stop says, which is not what a warning says.
 *
 * The terminal message used to end with `steeringFor(3, ...)` -- "leave this
 * alone now, take the next thing that is still wrong" -- addressed to a model
 * that has just been stopped and will not take anything. It reached the person
 * instead, under a red row offering Retry and Start New Task, as advice nobody
 * could act on: reported as "not useful, the 'leave this alone now' when it
 * ends in retry/new task and it stops".
 *
 * So the stop reports. The reader needs to know what was repeated, how many
 * times, and that the run had already said so before ending -- everything that
 * decides whether to retry as-is or steer by hand. The advice keeps its place
 * in the warnings, where there are still turns left to use it.
 */
function stoppedNotAdvised(attempts: number): string {
	return `The run is being stopped here. It was warned about this call ${attempts > 3 ? "three times" : "on each earlier attempt"} and the same arguments came back, so further attempts would spend turns without changing anything. Retry to run it again as it stands, or send a message saying what to do differently.`;
}

/**
 * Tools whose calls address a file by matching its text, and can therefore be
 * redirected to address it by position instead.
 *
 * Named rather than inferred: the steering above hands out a specific remedy,
 * and it has to be one the tool actually takes.
 */
const EDITING_TOOL_NAMES = new Set(["editor", "apply_patch"]);

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
	/**
	 * Signatures that have succeeded at least once this session.
	 *
	 * A repeat of one of these is a different situation from a repeat that has
	 * only ever failed: the work is done and the model has not registered it.
	 */
	appliedKeys: Set<string>;
	/** Signatures already told once that their work had landed. */
	settledKeys: Set<string>;
	/**
	 * Per futile signature, how many strikes it has spent.
	 *
	 * Kept apart from `barrenCounts` because a futile call is refused before it
	 * runs, so it never reaches `noteOutcome` to be tallied there.
	 */
	futileStrikes: Map<string, number>;
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
		appliedKeys: new Set(),
		settledKeys: new Set(),
		futileStrikes: new Map(),
		pendingKey: "",
	};
}

export function resetLoopDetectionState(state: LoopDetectionState): void {
	state.lastToolName = "";
	state.lastToolSignature = "";
	state.consecutiveIdenticalCount = 0;
	state.barrenCounts.clear();
	state.futileKeys.clear();
	state.appliedKeys.clear();
	state.settledKeys.clear();
	state.futileStrikes.clear();
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
 * - `"hard"` — hard-escalation threshold reached; SessionRuntime decides what
 *              follows from it.
 *
 * `message` is the diagnosis only, never the consequence. What happens next is
 * the consumer's to decide and to word: the first hard verdict is delivered to
 * the model as a last warning and the run continues, so a message that ended
 * "stopping to avoid a loop" would have described something that did not
 * happen. See `inspectLoopForToolCall` in the session orchestrator.
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

		// A call the tool has already declared a no-op is on a countdown. The
		// barren counter is for calls that fail for reasons that might change — a
		// file that was locked, a range that has since moved. This is not one of
		// those: the tool compared the payload against the file and found them
		// identical, and the payload is byte-for-byte the same one. Measured: the
		// same `editor` call, lines 94-96 and the same 1,336 characters, sent
		// seven times against six "No change" refusals, with a full re-read of the
		// file between four of them. Twenty-four minutes, and no edit.
		//
		// What that run never got was a warning it could act on: every refusal
		// read the same, so nothing marked the run as being about to end. The
		// budget is spent out loud instead, counting down by name.
		if (this.state.futileKeys.has(key)) {
			const strike = (this.state.futileStrikes.get(key) ?? 0) + 1;
			this.state.futileStrikes.set(key, strike);
			const remaining = FUTILE_STRIKE_LIMIT - strike;
			if (remaining > 0) {
				// One case is not a loop: the same call already *worked*, and what is
				// being repeated is a success the model did not register. Measured: an
				// `editor` call applied lines 94-97, then was sent twice more
				// unchanged; the second was refused as a no-op and the third stopped
				// the run, with two successful edits in the four turns before it. The
				// model was told the text matched the file, which is true and reads
				// like a failure, and never that its own edit was what put it there.
				// So the first warning says which of the two situations this is.
				const explanation = this.state.settledKeys.has(key)
					? `This \`${call.name}\` call is unchanged from the one that was just refused.`
					: this.state.appliedKeys.has(key)
						? `This \`${call.name}\` call already succeeded earlier in this task, and the file still holds exactly what it wrote — that is why sending it again is refused as a no-op rather than applied. Nothing is wrong and nothing was lost: this edit is done. Move on to the next thing that still needs changing, and if you are unsure what that is, re-read the file and compare it against what you set out to fix.`
						: `This \`${call.name}\` call was refused as a no-op: what it sends is character-for-character what the file already holds, so the change it asks for is already in place. Nothing failed and nothing was lost. Sending it again unchanged cannot do anything — move on to the next thing that still needs changing, and if this is not the state you meant the file to be in, the range or the text has to differ, not the attempt.`;
				this.state.settledKeys.add(key);
				return {
					kind: "soft",
					message: `${explanation}\n\n${steeringFor(strike, call.name)}\n\n${strikeWarning(remaining)}`,
				};
			}
			return {
				kind: "hard",
				message: `This exact call to \`${call.name}\` was refused ${strike} times because the tool compared it against the file and answered it in advance. The arguments are unchanged, so the result cannot be either.\n\n${stoppedNotAdvised(strike)}`,
			};
		}

		const barren = this.state.barrenCounts.get(key) ?? 0;
		if (barren >= STRIKE_LIMIT) {
			return {
				kind: "hard",
				message: `This exact call to \`${call.name}\` has already been made ${barren} times and failed every time. The arguments have not changed between attempts, so neither will the result.\n\n${stoppedNotAdvised(barren)}`,
			};
		}
		// The same countdown for a call that keeps failing outright. The first
		// failure is the tool's own error and nothing more — a single failure is
		// ordinary and does not need a warning attached to it.
		if (barren > 0) {
			return {
				kind: "soft",
				message: `This \`${call.name}\` call has now failed ${barren} time${barren === 1 ? "" : "s"} with these exact arguments, and nothing about them has changed between attempts.\n\n${steeringFor(barren, call.name)}\n\n${strikeWarning(STRIKE_LIMIT - barren)}`,
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
				message: `Detected ${this.state.consecutiveIdenticalCount} consecutive identical calls to \`${call.name}\`. The arguments have not changed between them, so neither will the result.\n\n${stoppedNotAdvised(this.state.consecutiveIdenticalCount)}`,
			};
		}
		if (result.softWarning) {
			return {
				kind: "soft",
				message: `Detected ${this.state.consecutiveIdenticalCount} consecutive identical calls to \`${call.name}\`.\n\n${steeringFor(this.state.consecutiveIdenticalCount - 2, call.name)}`,
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
			// The warning is spent with the episode it belonged to: if this
			// payload goes futile again later, that is a new situation and gets
			// its own warning before the stop.
			this.state.settledKeys.delete(key);
			this.state.futileStrikes.delete(key);
			this.state.appliedKeys.add(key);
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

/**
 * The loop guard over a tool call's arguments, while they are written.
 *
 * A model can loop inside a call as well as before it. On pandorum
 * (2026-10-20, v9-agentic on xOllama) an `editor` call ran to the 96,000-token
 * output cap: about 81,000 tokens of arguments, streamed to the client from
 * the first minute, and nothing read them but the `intent` guard, which by
 * design measures `intent` alone. The server then dropped the call (`path`
 * was still to come) and the turn was lost whole.
 *
 * So each call gets the reasoning guard's own detector -- periodicity, never
 * length, since `new_text` can rightly be a whole file -- fed with what the
 * call has written so far, and the content the model was given as the
 * source a restated block is measured against. Replayed over 54,605 stored
 * calls from 3,348 sessions it trips 25 times, every one on a call that
 * failed and every one a loop: `=` for 5,000 characters, "most importantly."
 * 110 times, one grep alternative 190 times.
 *
 * A loop whose copies differ gets past both block tests, which want the same
 * lines at an exact period. On pandorum (2026-10-22, session f099u) an
 * `editor` call wrote one 590-line script 13 times over in 12 minutes, 265,328
 * characters, each copy a few lines off the last; the call before it wrote
 * the same script 9 times. So a call is also measured by how much of it it
 * has already written: see `RestatedLines`.
 *
 * The text arrives in whatever form the provider streams. A server passing the
 * model's own notation through (xOllama's `tool_call_progress`) has the file's
 * line breaks in it; JSON arguments have them as `\n`, and a detector that
 * reads lines would see one line. JSON is decoded as it streams.
 */

import {
	comparableLine,
	ReasoningLoopGuard,
	type ReasoningLoopGuardConfig,
	type ReasoningLoopGuardOptions,
	type ReasoningLoopVerdict,
} from "./reasoning-loop-guard";

export interface ToolArgumentLoop {
	toolCallId: string;
	toolName?: string;
	verdict: ReasoningLoopVerdict;
}

const JSON_ESCAPES: Record<string, string> = {
	n: "\n",
	t: "\t",
	r: "",
	'"': '"',
	"\\": "\\",
	"/": "/",
};

interface CallState {
	guard: ReasoningLoopGuard;
	restated: RestatedLines;
	/** Decided on the first character that is not white space. */
	json?: boolean;
	/** A backslash ended the last delta, so the escape it opens is split. */
	escaping: boolean;
}

export class ToolArgumentLoopGuard {
	private readonly calls = new Map<string, CallState>();
	private verdict: ToolArgumentLoop | undefined;

	constructor(
		private readonly config: Partial<ReasoningLoopGuardConfig> = {},
		private readonly options: ReasoningLoopGuardOptions = {},
	) {}

	/**
	 * Feed the text a call has added since the last delta. Returns the first
	 * call judged to be looping, and the same answer on every push after it.
	 */
	push(
		toolCallId: string,
		text: string,
		toolName?: string,
	): ToolArgumentLoop | undefined {
		if (this.verdict || !text) return this.verdict;
		let call = this.calls.get(toolCallId);
		if (!call) {
			call = {
				guard: new ReasoningLoopGuard(this.config, this.options),
				restated: new RestatedLines(this.options.given),
				escaping: false,
			};
			this.calls.set(toolCallId, call);
		}
		if (call.json === undefined) {
			const first = text.trimStart()[0];
			if (first !== undefined) call.json = first === "{" || first === "[";
		}
		const decoded = call.json ? decode(call, text) : text;
		const found =
			call.guard.push(decoded) ?? call.restated.push(decoded) ?? undefined;
		if (found) {
			this.verdict = {
				toolCallId,
				...(toolName ? { toolName } : {}),
				verdict: found,
			};
		}
		return this.verdict;
	}
}

/**
 * Long lines written a third time or more. Set against every stored call of
 * 2,000+ characters, 3,890 of them from 3,895 sessions (2026-10-22): once a
 * call has 300 long lines, no healthy one has more than 6% of them as third
 * copies, and both f099u loops pass 30% within their first 720 -- about a
 * fifth of the way into the larger. Below 300 lines the only calls that
 * score high are `spawn_agent` task lists, whose boilerplate repeats per agent
 * by design, and every one of them worked.
 *
 * A third copy, not a second: a call that rewrites a file it read holds each
 * line once more than the source, and one that moves a block holds it twice.
 * Lines the source already repeats are allowed that many again.
 */
const RESTATED_MIN_LINE_CHARS = 24;
const RESTATED_MIN_LINES = 300;
const RESTATED_FRACTION = 0.3;
/** After the source excuses a call, how many more lines before asking again. */
const RESTATED_RECHECK_LINES = 50;

class RestatedLines {
	private readonly counts = new Map<string, number>();
	private pending = "";
	private chars = 0;
	private lines = 0;
	/** Copies past the second, before the source is consulted. */
	private excess = 0;
	private nextCheck = RESTATED_MIN_LINES;
	private source: Map<string, number> | undefined;

	constructor(private readonly given?: () => string) {}

	push(text: string): ReasoningLoopVerdict | undefined {
		this.chars += text.length;
		this.pending += text;
		let nl: number;
		while ((nl = this.pending.indexOf("\n")) !== -1) {
			const line = comparableLine(this.pending.slice(0, nl));
			this.pending = this.pending.slice(nl + 1);
			if (line.length < RESTATED_MIN_LINE_CHARS) continue;
			const count = (this.counts.get(line) ?? 0) + 1;
			this.counts.set(line, count);
			this.lines++;
			if (count > 2) this.excess++;
		}
		if (
			this.lines < this.nextCheck ||
			this.excess < RESTATED_FRACTION * this.lines
		) {
			return undefined;
		}
		const excess = this.excessBeyondSource();
		if (excess < RESTATED_FRACTION * this.lines) {
			this.nextCheck = this.lines + RESTATED_RECHECK_LINES;
			return undefined;
		}
		let sample = "";
		let most = 0;
		for (const [line, count] of this.counts) {
			if (count > most) {
				most = count;
				sample = line;
			}
		}
		return {
			kind: "restated-lines",
			chars: this.chars,
			cycles: most,
			distinct: this.counts.size,
			sample: sample.slice(0, 160),
		};
	}

	private excessBeyondSource(): number {
		if (this.source === undefined) {
			this.source = new Map();
			let text = "";
			try {
				text = this.given?.() ?? "";
			} catch {
				// No source is no excuse.
			}
			for (const raw of text.split("\n")) {
				const line = comparableLine(raw);
				if (line.length >= RESTATED_MIN_LINE_CHARS) {
					this.source.set(line, (this.source.get(line) ?? 0) + 1);
				}
			}
		}
		let excess = 0;
		for (const [line, count] of this.counts) {
			excess += Math.max(
				0,
				count - Math.max(2, (this.source.get(line) ?? 0) + 1),
			);
		}
		return excess;
	}
}

/** JSON string escapes as the characters they stand for, across deltas. */
function decode(call: CallState, text: string): string {
	let out = "";
	for (const char of text) {
		if (call.escaping) {
			call.escaping = false;
			out += JSON_ESCAPES[char] ?? `\\${char}`;
		} else if (char === "\\") {
			call.escaping = true;
		} else {
			out += char;
		}
	}
	return out;
}

/** What stands in the turn where the call was. */
export function describeToolArgumentLoopStub(loop: ToolArgumentLoop): string {
	const called = loop.toolName ? `\`${loop.toolName}\`` : "a tool";
	return `(A call to ${called} was begun here and cut before it was complete, so nothing ran. Its text is not kept.)`;
}

function repeated(verdict: ReasoningLoopVerdict): string {
	return verdict.kind === "phrase-cycle"
		? `the same ${verdict.period}-character run ${verdict.cycles} times`
		: verdict.kind === "low-uniqueness"
			? `the same ${verdict.distinct} lines over and over`
			: verdict.kind === "restated-lines"
				? `lines already written twice, one of them ${verdict.cycles} times`
				: `the same ${verdict.period}-line block ${verdict.cycles} times`;
}

/** What the model is told about it, before its next turn. */
export function buildToolArgumentLoopNudge(loop: ToolArgumentLoop): string {
	const called = loop.toolName ? `\`${loop.toolName}\`` : "a tool";
	return `[SYSTEM] Your call to ${called} was cut while you were writing it, and nothing ran: its arguments had come to repeat ${repeated(loop.verdict)}. Make the call again with only what it needs.`;
}

/**
 * The turn after a reply cut for looping. Without it the stub is the turn's
 * only text, and a turn with text and no call reads as the run's answer.
 */
export function buildReplyLoopNudge(verdict: ReasoningLoopVerdict): string {
	return `[SYSTEM] Your reply was cut while you were writing it, and none of it is kept: it had come to repeat ${repeated(verdict)}. Carry on with the task from where it stands.`;
}

/**
 * The turn after thinking cut for looping. The stub that replaces the
 * thinking says it was removed, but not what to do next, and the turn made no
 * call: without this the model was told only that a turn with no tool call
 * was about to end the run (pandorum, 2026-10-21).
 */
export function buildReasoningLoopNudge(verdict: ReasoningLoopVerdict): string {
	return `[SYSTEM] Your thinking was cut while you were writing it, and none of it is kept: it had come to repeat ${repeated(verdict)}. Carry on with the task from where it stands: make the next tool call now rather than working the plan out again.`;
}

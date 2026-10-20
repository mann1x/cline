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
 * The text arrives in whatever form the provider streams. A server passing the
 * model's own notation through (xOllama's `tool_call_progress`) has the file's
 * line breaks in it; JSON arguments have them as `\n`, and a detector that
 * reads lines would see one line. JSON is decoded as it streams.
 */

import {
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
				escaping: false,
			};
			this.calls.set(toolCallId, call);
		}
		if (call.json === undefined) {
			const first = text.trimStart()[0];
			if (first !== undefined) call.json = first === "{" || first === "[";
		}
		const found = call.guard.push(call.json ? decode(call, text) : text);
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

/** What the model is told about it, before its next turn. */
export function buildToolArgumentLoopNudge(loop: ToolArgumentLoop): string {
	const called = loop.toolName ? `\`${loop.toolName}\`` : "a tool";
	const { verdict } = loop;
	const what =
		verdict.kind === "phrase-cycle"
			? `the same ${verdict.period}-character run ${verdict.cycles} times`
			: verdict.kind === "low-uniqueness"
				? `the same ${verdict.distinct} lines over and over`
				: `the same ${verdict.period}-line block ${verdict.cycles} times`;
	return `[SYSTEM] Your call to ${called} was cut while you were writing it, and nothing ran: its arguments had come to repeat ${what}. Make the call again with only what it needs.`;
}

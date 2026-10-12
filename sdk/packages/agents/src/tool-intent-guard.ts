/**
 * Streaming guard on a tool call's `intent` argument.
 *
 * `intent` is one sentence saying what the call does. A model that has stopped
 * using its reasoning channel does its reasoning there instead: session x8yap
 * (pandorum, 2026-10-12, v9-agentic on xOllama) wrote an `editor` call whose
 * `intent` began "Fix bracket imbalance ..." and went on "Wait, let's
 * re-examine line 110 ..." for 82,325 characters. The call could not be read
 * and nothing ran; the turn cost 28,120 tokens and 5m48s. The next two went
 * the same way for 45,943 and 43,274 tokens. The intents of the calls that
 * worked in that run were 60 to 250 characters.
 *
 * Length is the signal here, unlike the reasoning guard next door: reasoning
 * has no sane upper bound and an `intent` does. Only `intent` is measured.
 * `new_text` and its like are payload and can rightly be a whole file.
 *
 * It reads the argument text as it streams, so it can only act where the
 * provider streams it. A server that holds the reply back until the call is
 * complete (xOllama and ollama do, for every tool call) gives it nothing to
 * read until there is nothing left to save.
 */

/** Past any `intent` a working call has carried, and well short of the damage. */
export const DEFAULT_TOOL_INTENT_MAX_CHARS = 2_000;

export interface ToolIntentLimitConfig {
	/** Characters an `intent` may run to before the call is cut. */
	maxChars: number;
}

export interface ToolIntentOverrun {
	toolCallId: string;
	toolName?: string;
	/** Characters of `intent` read when the call was cut. */
	chars: number;
	maxChars: number;
}

interface CallScan {
	toolName?: string;
	depth: number;
	inString: boolean;
	escaped: boolean;
	/** At depth 1: the next string is a key, not a value. */
	expectKey: boolean;
	/** The string being read is a key at depth 1. */
	readingKey: boolean;
	/** The string being read is the value of `intent` at depth 1. */
	readingIntent: boolean;
	key: string;
	intentChars: number;
}

/** Keys longer than this are not `intent`; stop collecting them. */
const KEY_CAPTURE_CHARS = 32;

/**
 * Reads tool-call argument text as it arrives, one call at a time, and
 * answers the first time a call's top-level `intent` string passes the limit.
 *
 * The text is JSON being written, so it is scanned, not parsed: nothing here
 * waits for the document to close, because the call this exists for never
 * closes it.
 */
export class ToolIntentGuard {
	private readonly maxChars: number;
	private readonly calls = new Map<string, CallScan>();

	constructor(config?: Partial<ToolIntentLimitConfig>) {
		this.maxChars = config?.maxChars ?? DEFAULT_TOOL_INTENT_MAX_CHARS;
	}

	push(
		toolCallId: string,
		text: string,
		toolName?: string,
	): ToolIntentOverrun | undefined {
		let scan = this.calls.get(toolCallId);
		if (!scan) {
			scan = {
				depth: 0,
				inString: false,
				escaped: false,
				expectKey: false,
				readingKey: false,
				readingIntent: false,
				key: "",
				intentChars: 0,
			};
			this.calls.set(toolCallId, scan);
		}
		if (toolName) {
			scan.toolName = toolName;
		}
		for (const char of text) {
			if (scan.inString) {
				if (scan.escaped) {
					scan.escaped = false;
				} else if (char === "\\") {
					scan.escaped = true;
				} else if (char === '"') {
					scan.inString = false;
					scan.readingKey = false;
					scan.readingIntent = false;
					continue;
				}
				if (scan.readingKey) {
					if (scan.key.length < KEY_CAPTURE_CHARS) {
						scan.key += char;
					}
				} else if (scan.readingIntent) {
					scan.intentChars += 1;
					if (scan.intentChars > this.maxChars) {
						return {
							toolCallId,
							...(scan.toolName ? { toolName: scan.toolName } : {}),
							chars: scan.intentChars,
							maxChars: this.maxChars,
						};
					}
				}
				continue;
			}
			if (char === '"') {
				scan.inString = true;
				if (scan.depth === 1) {
					if (scan.expectKey) {
						scan.readingKey = true;
						scan.key = "";
						scan.expectKey = false;
					} else if (scan.key === "intent") {
						scan.readingIntent = true;
						scan.intentChars = 0;
					}
				}
				continue;
			}
			if (char === "{" || char === "[") {
				scan.depth += 1;
				if (scan.depth === 1 && char === "{") {
					scan.expectKey = true;
				}
				continue;
			}
			if (char === "}" || char === "]") {
				scan.depth -= 1;
				continue;
			}
			if (char === "," && scan.depth === 1) {
				scan.expectKey = true;
				scan.key = "";
			}
		}
		return undefined;
	}
}

/** What stands in the assistant's turn where the cut call was being written. */
export function describeToolIntentOverrunStub(
	overrun: ToolIntentOverrun,
): string {
	const called = overrun.toolName ? `\`${overrun.toolName}\`` : "a tool";
	return `(A call to ${called} was begun here and cut before it was complete, so nothing ran. Its text is not kept.)`;
}

/** What the model is told about it. */
export function buildToolIntentOverrunNudge(
	overrun: ToolIntentOverrun,
): string {
	const called = overrun.toolName ? `\`${overrun.toolName}\`` : "a tool";
	const limit = overrun.maxChars.toLocaleString("en-US");
	return `[SYSTEM] Your call to ${called} was cut while you were writing it, and nothing ran. Its \`intent\` had passed ${limit} characters. \`intent\` is one sentence saying what the call does. Decide what to do before you begin the call, then make the call again with \`intent\` as that one sentence.`;
}

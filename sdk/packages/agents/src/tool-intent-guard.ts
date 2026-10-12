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

/**
 * How the argument text is written.
 *
 * `json` is what a provider streams as a call's arguments. The others are a
 * model's own call syntax, for a server that passes the call through as it is
 * generated and parses it only at the end. Text in a syntax nobody here reads
 * is not measured: no cut is better than a wrong one.
 */
export type ToolCallSyntax = "json" | "gemma4";

export function isToolCallSyntax(value: unknown): value is ToolCallSyntax {
	return value === "json" || value === "gemma4";
}

interface CallScan {
	toolName?: string;
	syntax: ToolCallSyntax;
	depth: number;
	inString: boolean;
	escaped: boolean;
	/** At depth 1: the next string (JSON) or bare word (gemma4) is a key. */
	expectKey: boolean;
	/** The string being read is a key at depth 1. */
	readingKey: boolean;
	/** The string being read is the value of `intent` at depth 1. */
	readingIntent: boolean;
	key: string;
	intentChars: number;
	/** gemma4: text held back because it may be the start of a delimiter. */
	held: string;
}

/** Keys longer than this are not `intent`; stop collecting them. */
const KEY_CAPTURE_CHARS = 32;

/** gemma4 opens and closes every string argument with this token. */
const GEMMA4_STRING_DELIMITER = '<|"|>';

/**
 * Reads tool-call argument text as it arrives, one call at a time, and
 * answers the first time a call's top-level `intent` string passes the limit.
 *
 * The text is a document being written, so it is scanned, not parsed: nothing
 * here waits for it to close, because the call this exists for never closes
 * it.
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
		syntax: ToolCallSyntax = "json",
	): ToolIntentOverrun | undefined {
		let scan = this.calls.get(toolCallId);
		if (!scan) {
			scan = {
				syntax,
				depth: 0,
				inString: false,
				escaped: false,
				expectKey: false,
				readingKey: false,
				readingIntent: false,
				key: "",
				intentChars: 0,
				held: "",
			};
			this.calls.set(toolCallId, scan);
		}
		if (toolName) {
			scan.toolName = toolName;
		}
		const over =
			scan.syntax === "gemma4"
				? this.scanGemma4(scan, text)
				: this.scanJson(scan, text);
		return over
			? {
					toolCallId,
					...(scan.toolName ? { toolName: scan.toolName } : {}),
					chars: scan.intentChars,
					maxChars: this.maxChars,
				}
			: undefined;
	}

	private scanJson(scan: CallScan, text: string): boolean {
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
						return true;
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
		return false;
	}

	/**
	 * `call:editor{intent:<|"|>...<|"|>,new_text:<|"|>...<|"|>,start_line:91}`
	 *
	 * Keys are bare words and a string runs from one delimiter token to the
	 * next, with no escaping inside it. A delta can end part-way through a
	 * delimiter, so the last few characters are held until the next one says
	 * what they were.
	 */
	private scanGemma4(scan: CallScan, text: string): boolean {
		const input = scan.held + text;
		scan.held = "";
		let at = 0;
		while (at < input.length) {
			if (scan.inString) {
				const close = input.indexOf(GEMMA4_STRING_DELIMITER, at);
				// Everything up to the close, or up to what may be its start.
				const end =
					close >= 0 ? close : input.length - partialDelimiterLength(input, at);
				if (scan.readingIntent) {
					scan.intentChars += Math.max(0, end - at);
					if (scan.intentChars > this.maxChars) {
						return true;
					}
				}
				if (close < 0) {
					scan.held = input.slice(end);
					return false;
				}
				scan.inString = false;
				scan.readingIntent = false;
				at = close + GEMMA4_STRING_DELIMITER.length;
				continue;
			}
			if (input.startsWith(GEMMA4_STRING_DELIMITER, at)) {
				scan.inString = true;
				if (scan.depth === 1 && !scan.expectKey && scan.key === "intent") {
					scan.readingIntent = true;
					scan.intentChars = 0;
				}
				at += GEMMA4_STRING_DELIMITER.length;
				continue;
			}
			if (
				input[at] === "<" &&
				GEMMA4_STRING_DELIMITER.startsWith(input.slice(at))
			) {
				scan.held = input.slice(at);
				return false;
			}
			const char = input[at] as string;
			at += 1;
			if (char === "{" || char === "[") {
				scan.depth += 1;
				if (scan.depth === 1 && char === "{") {
					scan.expectKey = true;
					scan.key = "";
				}
			} else if (char === "}" || char === "]") {
				scan.depth -= 1;
			} else if (scan.depth === 1) {
				if (char === ",") {
					scan.expectKey = true;
					scan.key = "";
				} else if (char === ":") {
					scan.expectKey = false;
				} else if (
					scan.expectKey &&
					scan.key.length < KEY_CAPTURE_CHARS &&
					/\S/.test(char)
				) {
					scan.key += char;
				}
			}
		}
		return false;
	}
}

/** How many characters at the end of `input` could be a delimiter beginning. */
function partialDelimiterLength(input: string, from: number): number {
	const longest = Math.min(
		GEMMA4_STRING_DELIMITER.length - 1,
		input.length - from,
	);
	for (let length = longest; length > 0; length--) {
		if (
			GEMMA4_STRING_DELIMITER.startsWith(input.slice(input.length - length))
		) {
			return length;
		}
	}
	return 0;
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

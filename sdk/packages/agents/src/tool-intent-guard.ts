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
 * One rule for every model. The call may arrive as JSON arguments from a
 * provider that streams them, or in a model's own notation from a server that
 * passes the call through as it is written (xOllama's `tool_call_progress`:
 * gemma4's `call:NAME{key:<|"|>...}`, qwen's `<parameter=key>`, and whatever
 * comes next). Reading each notation would mean a guard that exists for some
 * models and not for others, and nobody remembers which. So nothing here
 * reads a notation. It knows the names of the tools' arguments, and the rule
 * is: once `intent` has begun, another argument must begin within the limit.
 * An argument's name standing where a key stands looks alike in all of them.
 *
 * It can only act where the call's text arrives while it is being written. A
 * server that holds the reply back until the call is complete gives it
 * nothing to read until there is nothing left to save.
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
	/** Characters read since `intent` began when the call was cut. */
	chars: number;
	maxChars: number;
}

/**
 * The host's switch, for every runtime in the process: the lead, and each
 * agent and teammate it starts. A setting that reached the lead alone would be
 * a box that is ticked and half read; agents build their own runtime
 * configuration and none of it is copied from the lead's.
 */
let enabledByHost = true;

export function setToolIntentGuardEnabled(enabled: boolean): void {
	enabledByHost = enabled;
}

export function isToolIntentGuardEnabled(): boolean {
	return enabledByHost;
}

interface CallScan {
	toolName?: string;
	phase: "seeking" | "counting" | "closed";
	/** The end of what has been read, kept so a key split by a delta is seen. */
	tail: string;
	chars: number;
}

const INTENT = "intent";

function escapeForRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A name standing where a key stands, in any notation met so far:
 *
 *   JSON      `{"intent":`  `,"path" :`
 *   gemma4    `{intent:`    `<|"|>,path:`
 *   qwen      `<parameter=intent>`
 *   glm       `<arg_key>intent</arg_key>`
 *
 * Something structural before it, never a space: prose says "the path: ..."
 * and does not say `,path:`.
 */
function keyPattern(names: readonly string[]): RegExp | undefined {
	if (names.length === 0) {
		return undefined;
	}
	const alternatives = [...names]
		.sort((a, b) => b.length - a.length)
		.map(escapeForRegExp)
		.join("|");
	return new RegExp(`[,{"'=>]\\s*(?:${alternatives})["']?\\s*[:=><]`);
}

/**
 * Reads tool-call text as it arrives, one call at a time, and answers the
 * first time a call has gone the limit past the start of `intent` without
 * beginning another argument.
 *
 * `argumentNames` is every argument of every tool the model may call. Without
 * it nothing is measured: a call whose `intent` comes first and whose payload
 * is a whole file would look exactly like the call this exists to cut.
 */
export class ToolIntentGuard {
	private readonly maxChars: number;
	private readonly calls = new Map<string, CallScan>();
	private readonly intentKey: RegExp | undefined;
	private readonly otherKey: RegExp | undefined;
	private readonly tailChars: number;

	constructor(
		config?: Partial<ToolIntentLimitConfig> & {
			argumentNames?: Iterable<string>;
		},
	) {
		this.maxChars = config?.maxChars ?? DEFAULT_TOOL_INTENT_MAX_CHARS;
		const others = [...new Set(config?.argumentNames ?? [])].filter(
			(name) => name.length > 0 && name !== INTENT,
		);
		this.otherKey = keyPattern(others);
		this.intentKey = this.otherKey ? keyPattern([INTENT]) : undefined;
		// Enough to hold the longest key with its punctuation on both sides.
		this.tailChars =
			Math.max(INTENT.length, ...others.map((name) => name.length)) + 8;
	}

	push(
		toolCallId: string,
		text: string,
		toolName?: string,
	): ToolIntentOverrun | undefined {
		if (!this.intentKey || !this.otherKey || text.length === 0) {
			return undefined;
		}
		let scan = this.calls.get(toolCallId);
		if (!scan) {
			scan = { phase: "seeking", tail: "", chars: 0 };
			this.calls.set(toolCallId, scan);
		}
		if (toolName) {
			scan.toolName = toolName;
		}
		if (scan.phase === "closed") {
			return undefined;
		}
		let window = scan.tail + text;
		let fresh = text.length;
		if (scan.phase === "seeking") {
			const begun = this.intentKey.exec(window);
			if (!begun) {
				scan.tail = window.slice(-this.tailChars);
				return undefined;
			}
			scan.phase = "counting";
			window = window.slice(begun.index + begun[0].length);
			fresh = window.length;
		}
		if (this.otherKey.test(window)) {
			// The next argument began: `intent` is behind it, whatever its size
			// was, and one `intent` is all a call has.
			scan.phase = "closed";
			scan.tail = "";
			return undefined;
		}
		scan.chars += fresh;
		scan.tail = window.slice(-this.tailChars);
		if (scan.chars <= this.maxChars) {
			return undefined;
		}
		return {
			toolCallId,
			...(scan.toolName ? { toolName: scan.toolName } : {}),
			chars: scan.chars,
			maxChars: this.maxChars,
		};
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

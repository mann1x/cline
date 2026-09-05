export function formatFileContentBlock(path: string, content: string): string {
	return `<file_content path="${path}">\n${content}\n</file_content>`;
}

export function formatUserInputBlock(
	input: string,
	mode: "act" | "plan" | "yolo" = "act",
): string {
	return `<user_input mode="${mode}">${input}</user_input>`;
}

export function formatUserCommandBlock(input: string, slash: string): string {
	return `<user_command slash="${slash}">${input}</user_command>`;
}

// Mirrors exactly what formatUserInputBlock writes (lowercase tag, lowercase
// mode values), but searches rather than anchors: persisted user content can
// carry prepended <mode_notice> elements or trailing attachment blocks
// around the wrapper.
const USER_INPUT_MODE_RE = /<user_input\b[^>]*\bmode="(act|plan|yolo)"/;

/**
 * Recovers the agent mode a persisted user message was sent in from its
 * <user_input mode="..."> wrapper. Returns undefined when the input isn't
 * wrapped (plain text, user_command envelopes, older transcripts).
 */
export function parseUserInputMode(
	input?: string,
): "act" | "plan" | "yolo" | undefined {
	const match = USER_INPUT_MODE_RE.exec(input ?? "");
	return match ? (match[1] as "act" | "plan" | "yolo") : undefined;
}

/**
 * Marks the exact point in the conversation where the user switched between
 * plan and act modes. Prepended to the first user message sent after the
 * switch. It survives normalizeUserInput (so the outbound sanitize in
 * prepareTurnInput delivers it to the model) and is hidden from transcript
 * display by stripModeNotices at display boundaries.
 */
export function formatModeSwitchNotice(
	from: "act" | "plan",
	to: "act" | "plan",
): string {
	return `<mode_notice>The user switched from ${from} mode to ${to} mode before sending this message.</mode_notice>`;
}

export type ModeSwitchNotice = {
	from: "act" | "plan";
	to: "act" | "plan";
};

/**
 * Tracks a user-initiated mode switch so the next user message can carry a
 * <mode_notice> marking it. Only UI toggles should be recorded: the
 * model-initiated switch_to_act_mode path already announces itself via the
 * continuation prompt. A round trip (plan -> act -> plan before sending
 * anything) cancels out, since the mode the model last saw never effectively
 * changed.
 */
export function createModeSwitchNoticeTracker() {
	let pending: ModeSwitchNotice | null = null;
	return {
		record(from: "act" | "plan", to: "act" | "plan"): void {
			if (from === to) {
				return;
			}
			if (pending) {
				pending = pending.from === to ? null : { from: pending.from, to };
				return;
			}
			pending = { from, to };
		},
		consume(): ModeSwitchNotice | null {
			const notice = pending;
			pending = null;
			return notice;
		},
	};
}

export type ModeSwitchNoticeTracker = ReturnType<
	typeof createModeSwitchNoticeTracker
>;

export type UserCommandEnvelope = {
	slash: string;
	content: string;
};

function extractFullTagContent(
	input: string,
	tag: string,
): { attrs: string; content: string } | undefined {
	const trimmed = input.trim();
	const match = new RegExp(
		`^<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>$`,
		"i",
	).exec(trimmed);
	if (!match) {
		return undefined;
	}
	return {
		attrs: match[1] ?? "",
		content: match[2] ?? "",
	};
}

function readAttribute(attrs: string, key: string): string | undefined {
	const match = new RegExp(`${key}="([^"]+)"`, "i").exec(attrs);
	return match?.[1]?.trim() || undefined;
}

export function parseUserCommandEnvelope(
	input?: string,
): UserCommandEnvelope | undefined {
	if (!input?.trim()) {
		return undefined;
	}
	const extracted = extractFullTagContent(input, "user_command");
	if (!extracted) {
		return undefined;
	}
	const slash = readAttribute(extracted.attrs, "slash");
	if (!slash) {
		return undefined;
	}
	return {
		slash,
		content: extracted.content.trim(),
	};
}

export function normalizeUserInput(input?: string): string {
	if (!input?.trim()) return "";
	let next = input.trim();
	for (const tag of ["user_input", "user_command"] as const) {
		const extracted = xmlTagsRemoval(next, tag);
		next = (
			extracted !== next
				? extracted
				: next.replace(new RegExp(`<${tag}[^>]*>`, "g"), "")
		).trim();
	}
	return next;
}

/**
 * What a run is told when a turn produced no tool calls and no completion
 * policy had anything to say about it.
 *
 * A turn with no tool calls ends the run, on the assumption that a model with
 * nothing left to call has nothing left to do. That assumption fails on models
 * that announce their plan and stop — "I will use multiple editor calls to fix
 * this" — which ends the task with none of the work done. Measured on gemma4:
 * 7 of 7 replays of one captured request returned text and no tool call.
 *
 * It lives here, beside the other text that is generated rather than typed,
 * because two layers need to agree on it: the runtime appends it as a user
 * turn, and the display layer has to recognise it to keep it out of the
 * transcript. A nudge rendered as a user message is a message the user never
 * sent, and it makes the turn it interrupts look like it ended on a question
 * from them.
 */
export const NO_TOOL_CALL_NUDGE_MESSAGE =
	"[SYSTEM] Your last message contained no tool calls, so the run was about to end. " +
	"If the task is not finished, continue now by emitting the tool calls it needs - do not " +
	"describe what you are going to do without doing it. If the task really is finished, " +
	"say so in one short sentence.";

/**
 * The second nudge, for the model that answered the first by announcing again.
 *
 * The budget for the message above is one, and rightly: it asks a question
 * with two branches -- keep working, or say you are finished -- and a model
 * that answers "the task is fully complete" answers it. Sending that model the
 * identical text a second time has never changed an outcome.
 *
 * But a model that answers by announcing *more* work has not answered it. It
 * has restated the plan, which is the very behaviour the first nudge exists to
 * catch, and the counter cannot tell the two apart because it counts turns
 * rather than what they said. Measured on a live run: "Let me propose a check,
 * then fix them" -- twice, once either side of the nudge -- and the run was
 * reported Completed with the file untouched and no check ever proposed.
 *
 * So this is not the same message again. It quotes the model its own sentence
 * and names the gap between saying and calling, and it is allowed once per
 * run, which keeps the bound that stops a nudge from making a run immortal.
 *
 * @see ANNOUNCED_INTENT_NUDGE_PREFIX
 */

/**
 * The fixed opening of the intent nudge.
 *
 * It quotes the model, so the message is not a constant and cannot be
 * recognised by equality the way the generic nudge is. The display layer has
 * to keep it out of the transcript all the same -- a nudge rendered as a user
 * bubble is a message the user never sent -- so the stable prefix is exported
 * rather than left for someone to re-type as a literal.
 */
export const ANNOUNCED_INTENT_NUDGE_PREFIX = "[SYSTEM] You wrote ";

export function buildAnnouncedIntentNudge(announcement: string): string {
	const quoted = announcement.trim().replace(/\s+/g, " ").slice(0, 200);
	return (
		ANNOUNCED_INTENT_NUDGE_PREFIX +
		`"${quoted}" ` +
		"and then called nothing, for the second turn running. Saying what you " +
		"are about to do is not doing it, and the run ends on the next silent " +
		"turn with the work undone. Emit the tool call itself now - the first " +
		"one, not a description of it. If you cannot, say plainly what is " +
		"stopping you in one sentence."
	);
}

/**
 * Whether a turn that called nothing announced an action rather than finishing.
 *
 * Deliberately narrow: a first-person statement of imminent action, in the
 * last part of the message, and no claim of completion anywhere in it. A
 * model that says it is done gets no second nudge no matter how it phrases
 * that, because the whole point of the one-nudge budget is that such a model
 * has already answered.
 */
const ANNOUNCED_INTENT =
	/\b(?:let me|i'?ll|i will|i'?m going to|i am going to|now i(?:'?ll| will)|next,? i(?:'?ll| will)|let'?s)\b/i;
const CLAIMS_COMPLETION =
	/\b(?:task (?:is )?(?:complete|finished|done)|all done|is now (?:complete|finished|fixed|working)|i(?:'?m| am) (?:done|finished)|nothing (?:else|more) to do|no further changes)\b/i;

export function announcedIntentWithoutActing(
	text: string | undefined,
): string | undefined {
	const trimmed = text?.trim();
	if (!trimmed || CLAIMS_COMPLETION.test(trimmed)) {
		return undefined;
	}
	// The announcement has to be how the message *ends*. A turn that did work,
	// described it, and closed with a summary is not this; a turn whose last
	// word is a promise is.
	const tail = trimmed.slice(-400);
	return ANNOUNCED_INTENT.test(tail) ? trimmed : undefined;
}

/**
 * Removes runtime-generated <mode_notice> elements (content included): they
 * are not user-typed text and must not render as such. Deliberately NOT part
 * of normalizeUserInput -- that function also sanitizes outbound prompts
 * before the host wraps them (prepareTurnInput), and stripping there deletes
 * the notice before the model ever sees it.
 */
export function stripModeNotices(input?: string): string {
	if (!input?.trim()) return "";
	return removeTagElements(input, "mode_notice").trim();
}

// indexOf-based rather than a regex: a lazy dot-all pattern re-scans to the
// end of the string from every unmatched opening tag, which is polynomial on
// adversarial transcript content (CodeQL js/polynomial-redos).
function removeTagElements(input: string, tag: string): string {
	const open = `<${tag}>`;
	const close = `</${tag}>`;
	let result = input;
	let start = result.indexOf(open);
	while (start !== -1) {
		const end = result.indexOf(close, start + open.length);
		if (end === -1) {
			break;
		}
		result = result.slice(0, start) + result.slice(end + close.length);
		start = result.indexOf(open, start);
	}
	return result;
}

export function formatDisplayUserInput(input?: string): string {
	const normalized = stripModeNotices(normalizeUserInput(input));
	const envelope = parseUserCommandEnvelope(input);
	if (!envelope) {
		return normalized;
	}
	if (envelope.slash.toLowerCase() === "team") {
		const prefix = "spawn a team of agents for the following task:";
		const stripped = normalized.toLowerCase().startsWith(prefix)
			? normalized.slice(prefix.length).trim()
			: normalized;
		return stripped ? `/team ${stripped}` : "/team";
	}
	return normalized ? `/${envelope.slash} ${normalized}` : `/${envelope.slash}`;
}

export const SESSION_SEARCH_TITLE_MAX_LENGTH = 240;
export const SESSION_SEARCH_PREVIEW_MAX_LENGTH = 480;

function compactSessionSearchText(input: string, maxLength: number): string {
	const compact = input.replace(/\s+/gu, " ").trim();
	if (compact.length <= maxLength) return compact;
	return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

export function formatSessionSearchTitle(input?: string): string {
	return compactSessionSearchText(
		formatDisplayUserInput(input),
		SESSION_SEARCH_TITLE_MAX_LENGTH,
	);
}

export function formatSessionSearchPreview(
	role: string,
	input?: string,
): string {
	const trimmed = input?.trim() ?? "";
	const normalizedRole = role.toLowerCase();
	const display =
		normalizedRole === "user" || normalizedRole === "session"
			? formatDisplayUserInput(trimmed)
			: trimmed;
	return compactSessionSearchText(display, SESSION_SEARCH_PREVIEW_MAX_LENGTH);
}

export function xmlTagsRemoval(input?: string, tag?: string): string {
	if (!input?.trim()) return "";
	if (!tag) return input;
	const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g");
	return input.replace(regex, "$1");
}

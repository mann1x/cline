/**
 * Continuation notes for a turn whose thinking ran out of budget.
 *
 * A model that hits its thinking cap does not stop reasoning — it stops
 * mid-sentence, emits whatever tool call it can, and on the next turn starts the
 * same reasoning from the beginning. Observed on a live session: the same
 * ground covered a dozen times, each pass reaching "this is the final plan" and
 * then "wait, I just realised…", each one ending at the same cap, and each one
 * producing a differently-malformed call because the argument-writing was the
 * part that got cut.
 *
 * The reasoning is in the transcript, so in principle nothing is lost. In
 * practice seventeen thousand tokens of interrupted rambling is not something a
 * model reads and continues from; it is something it re-derives. So when the cap
 * fires, that turn's thinking is replaced — for the next request only — with a
 * short note of what it settled, what it ruled out, and what the tool call it
 * managed to make came back as. Short enough to be read, and framed as
 * conclusions rather than as a transcript to resume.
 */

import {
	createHandlerAsync,
	resolveLlamaCppThinkBudgetTokens,
} from "@cline/llms";
import type {
	BasicLogger,
	DiscardedTurnCondensation,
	DiscardedTurnInput,
	MessageWithMetadata,
	PrepareTurnUsage,
} from "@cline/shared";
import type { CoreCompactionSummarizerConfig } from "../../types/config";
import type { ProviderConfig } from "../../types/provider-settings";
import {
	buildThinkingSummaryRequest,
	estimateThinkingTokens,
	flattenToolResultContent,
	formatToolInput,
	resolveSummarizerConfig,
	truncateText,
} from "./compaction-shared";
import { continuationCompactionExcluded } from "./continuation-compaction";

/**
 * How close to the budget counts as having hit it.
 *
 * Not equality: a budget is enforced on whole tokens as they are produced, and
 * the turn stops on the first one that does not fit, so the last few are never
 * spent. A turn that spent nine tenths of its allowance was cut short in every
 * way that matters here.
 *
 * What this is compared against matters more than the ratio. The first version
 * of this compared an *estimate* — reasoning characters over the request-wide
 * chars-per-token ratio, 3.8 to 4.4 on a serialized request full of JSON and
 * code — against a budget denominated in the model's own tokens. A turn that
 * spent all 16,000 of its allowance, about 43,000 characters of prose,
 * therefore measured as ~10,300 and never crossed the line. The cap fired on
 * nearly 300 requests in one session and the detector saw none of them.
 */
const CAP_PROXIMITY = 0.9;

/**
 * How far back from the end of the reasoning the budget message can be.
 *
 * It is appended when the budget runs out, so it is at the end. Scanning only
 * the tail keeps a model that happens to *discuss* its thinking budget
 * mid-reasoning from being read as one that ran out of it.
 */
const BUDGET_MESSAGE_TAIL_MARGIN_CHARS = 400;

/**
 * Whether the server's own budget message is at the end of this reasoning.
 *
 * Only ever called with a message the session actually knows: either Cline set
 * it on the request, or Ollama reported the model's own via `/api/show`. There
 * is no guessing at the wording — a model with no message configured has no
 * marker to find, and this is not consulted for one.
 */
function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * The line of the message to look for.
 *
 * The longest one, not the first. A message from a Modelfile arrives as the
 * author wrote it — `v7-coder_tb` opens its with two blank lines — and one a
 * user typed into the settings box can open with anything at all, including a
 * word short enough to appear in ordinary reasoning. The longest line is the
 * one least likely to be either.
 */
function budgetMessageMarker(message: string): string {
	let marker = "";
	for (const line of message.split("\n")) {
		const collapsed = collapseWhitespace(line);
		if (collapsed.length > marker.length) {
			marker = collapsed;
		}
	}
	return marker;
}

function endsWithBudgetMessage(thinking: string, message: string): boolean {
	const marker = budgetMessageMarker(message);
	if (!marker) {
		return false;
	}
	// Both sides collapsed: the same sentence is not always laid out the same
	// way twice. A Modelfile writes its line breaks as `\n` escapes, a user
	// types real ones, and the model's own copy of the message is whatever the
	// server streamed — which is not required to keep either.
	return collapseWhitespace(
		thinking.slice(-(marker.length + BUDGET_MESSAGE_TAIL_MARGIN_CHARS)),
	).includes(marker);
}

/**
 * The engine's own admission that it ran out, in the words every budget
 * message the fork has met uses: "I have used my thinking budget".
 *
 * Only for a session that does not know its message -- a delegated worker on
 * a node whose server sets `--reasoning-budget-message` itself, say. Anchored
 * to the tail like the exact match, so reasoning that merely *mentions* a
 * budget mid-thought is not read as one that ran out of it.
 */
const GENERIC_BUDGET_ADMISSION =
	/\b(?:used|exhausted|spent|run out of|ran out of|reached) (?:my|the) (?:thinking|reasoning) budget\b/i;

/**
 * Whether this reasoning ended because the thinking budget ran out.
 *
 * With the session's budget message, the exact marker test the capped-thinking
 * condenser uses. Without one, the generic admission above, in the same tail
 * window.
 */
export function reasoningHitBudget(
	thinking: string,
	budgetMessage?: string,
): boolean {
	const message = budgetMessage?.trim();
	if (message) {
		return endsWithBudgetMessage(thinking, message);
	}
	return GENERIC_BUDGET_ADMISSION.test(
		thinking.slice(-BUDGET_MESSAGE_TAIL_MARGIN_CHARS * 2),
	);
}

/** What the note is allowed to cost. It is a handful of lines by design. */
/**
 * Guard against a runaway note becoming the thing that fills the window.
 *
 * Generous, because the note is the only surviving record of a think that ran
 * to twenty or thirty thousand characters and it has to be detailed enough to
 * work from -- it is a summary, not a retrospective. A summary of that think
 * lands nowhere near this in practice, which is what makes it a guard rather
 * than a target.
 */
const CONDENSED_THINKING_MAX_CHARS = 16_000;

/**
 * The output cap for the condensation call itself.
 *
 * A fixed cap was removed once, for a good reason: at 700 tokens against a
 * summariser that reasons, the whole budget went into thinking and the call
 * returned no text at all. The condensation call now asks for no reasoning, so
 * the budget is the note -- and something has to bound it, because a small
 * model asked for prose in its own voice can fall into repeating itself.
 * Measured live: a note that opened "Summary-of-thought process:" and then said
 * a variant of that line thirty times.
 *
 * Set well above what the note needs, so it is a stop rather than a limit the
 * note is written to.
 */
/**
 * What the note itself has to have room for, whatever else shares the budget.
 *
 * The instruction above asks for every call the turn made and what each one
 * returned, so this is a working budget rather than a stop: 2,000 tokens is
 * about 5,000 characters, and the two notes this was measured against were 624
 * and 768. It is also the ceiling that stops a small model that has started
 * repeating itself, which is why it stays a fixed number and not a share.
 */
export const CONDENSED_THINKING_NOTE_TOKENS = 2_000;

/**
 * The note's length target: a tenth of the think it replaces, kept between
 * 1,000 and 2,000 tokens (user ruling, 2026-10-18: "1k-2k if there's enough
 * context/output available").
 *
 * The floor is the point. A note is asked for only when a think ran to its
 * budget, and the notes measured so far were 250 to 450 tokens -- a hundredth
 * of what they replaced, too little to carry the calls, the findings and what
 * was set aside, so the next pass re-derived them.
 */
export const CONDENSED_THINKING_NOTE_MIN_TOKENS = 1_000;
const CONDENSED_THINKING_NOTE_SHARE = 0.1;
/** The least a note is asked for when the window leaves less than the floor. */
const CONDENSED_THINKING_NOTE_SHRUNK_TOKENS = 300;
/**
 * The cap over the target, so the cap is a stop against a runaway and not a
 * wall the note is written into: a model aiming at 1,500 words lands either
 * side of it.
 */
const CONDENSED_THINKING_NOTE_HEADROOM = 1.5;
/** Characters per token, for sizing the condensation request before it is sent. */
const NOTE_REQUEST_CHARS_PER_TOKEN = 3;
/** Slack on that sizing: the chat template's own tokens. */
const NOTE_REQUEST_SLACK_TOKENS = 512;

/**
 * How long a note to ask for, and the output cap that goes with it.
 *
 * The target comes from the think; the room only ever lowers it. With a
 * window to fit, the condensation request and its cap must both be inside
 * it, so the target steps down until they are -- to a short note rather than
 * none, because a request that does not fit is refused either way. With no
 * window known the target stands, and the server sizes the call as before.
 */
export function resolveCondensedThinkingNoteTokens(options: {
	thinkingChars: number;
	/** The condensation request as it will be sent, in characters. */
	requestChars: number;
	/** The tokens the call has to fit in, when known. */
	roomTokens?: number;
	providerConfig: Partial<ProviderConfig>;
}): { noteTokens: number; maxTokens: number } {
	const capFor = (note: number) =>
		resolveCondensedThinkingOutputCap(
			options.providerConfig,
			Math.ceil(note * CONDENSED_THINKING_NOTE_HEADROOM),
		);
	const thinkTokens = estimateThinkingTokens(options.thinkingChars);
	const wanted = Math.min(
		CONDENSED_THINKING_NOTE_TOKENS,
		Math.max(
			CONDENSED_THINKING_NOTE_MIN_TOKENS,
			Math.round(thinkTokens * CONDENSED_THINKING_NOTE_SHARE),
		),
		// Never more than half of what it condenses: a short think is not
		// worth a long note.
		Math.max(
			CONDENSED_THINKING_NOTE_SHRUNK_TOKENS,
			Math.floor(thinkTokens / 2),
		),
	);
	const room = options.roomTokens;
	if (room === undefined || !(room > 0)) {
		return { noteTokens: wanted, maxTokens: capFor(wanted) };
	}
	const request =
		Math.ceil(options.requestChars / NOTE_REQUEST_CHARS_PER_TOKEN) +
		NOTE_REQUEST_SLACK_TOKENS;
	for (
		let note = wanted;
		note > CONDENSED_THINKING_NOTE_SHRUNK_TOKENS;
		note -= 100
	) {
		if (request + capFor(note) <= room) {
			return { noteTokens: note, maxTokens: capFor(note) };
		}
	}
	return {
		noteTokens: CONDENSED_THINKING_NOTE_SHRUNK_TOKENS,
		maxTokens: capFor(CONDENSED_THINKING_NOTE_SHRUNK_TOKENS),
	};
}

/**
 * The cap the condensation request carries.
 *
 * Static when nothing bounds the thinking, and a ladder off the level when
 * something does -- because the server takes the thinking allowance out of this
 * same number *first*. `ThinkBudgetWindow` prefers `num_predict` over the
 * context length, so the share is a share of this cap: at `max` ({4,5}) a
 * 2,000-token cap leaves the note 400 tokens, which is less than either note
 * measured on pandorum already used.
 *
 * Whether that bites depends on the provider, which is why the ladder is a
 * guard rather than a fix for a live fault. Measured on eleven2go 2026-09-19:
 * `think:false` returns 0 characters of thinking against 2,743 with it unset,
 * so on Ollama the switch `resolveSummarizerConfig` sets really does hold, and
 * on llama.cpp `enabled: false` sends `reasoning_budget_tokens: 0`. The ladder
 * is what keeps the note whole on a provider that ignores the switch and reads
 * only the budget -- which is what opencoti does with `reasoning_effort`.
 *
 * A count rather than a level is the number the user typed. It is not a share
 * of anything, so it is added rather than solved for, and it outranks a level
 * the same way the request path ranks the two.
 */
export function resolveCondensedThinkingOutputCap(
	providerConfig: Partial<ProviderConfig>,
	noteTokens = CONDENSED_THINKING_NOTE_TOKENS,
): number {
	// The condenser asks for no thinking. Where that is honoured the whole cap
	// is the note; where it is not, the branches below still hold.
	if (providerConfig.thinking === false) {
		return noteTokens;
	}
	const sampling = providerConfig.sampling;
	const handSet =
		readTokenCount(sampling?.thinkBudget) ??
		(sampling?.thinkBudget === undefined
			? readTokenCount(providerConfig.thinkingBudgetTokens)
			: undefined);
	if (handSet !== undefined) {
		return noteTokens + handSet;
	}
	const level = sampling?.thinkBudget ?? providerConfig.reasoningEffort;
	if (!level) {
		return noteTokens;
	}
	// The share is read from the resolver rather than from the fraction table,
	// so the ladder cannot drift from what the request path actually sends. A
	// large probe window recovers the fraction exactly for every level in the
	// table, and `cap - share x cap >= note` then solves in one step. Iterating
	// towards the fixpoint instead converges as `share^n`, which at `max` is
	// still 40 tokens short after two dozen rounds.
	const probe = 1_000_000;
	const think = resolveLlamaCppThinkBudgetTokens(level, probe) ?? 0;
	if (think <= 0 || think >= probe) {
		// A level the table does not carry bounds nothing, and one that claimed
		// the whole window would leave no note to size.
		return noteTokens;
	}
	// Kept in integers. `note / (1 - 4/5)` in floating point is
	// 10000.000000000002, and the ceiling of that is a cap one token wider than
	// the ladder it is supposed to be a rung of.
	return Math.ceil((noteTokens * probe) / (probe - think));
}

function readTokenCount(value: unknown): number | undefined {
	const parsed = typeof value === "string" ? Number(value) : value;
	return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0
		? Math.floor(parsed)
		: undefined;
}

/**
 * Whether a note is the model repeating itself rather than writing.
 *
 * Degeneration is not a graceful failure here: the note goes into the thinking
 * channel as the model's own reasoning, so thirty near-identical lines are read
 * as thirty things it thought. No note at all is strictly better -- the turn
 * then re-derives, which is the behaviour this feature improves on rather than
 * one it breaks.
 *
 * Two cheap tests, because the shape is unmistakable: mostly-repeated lines, or
 * one line that repeats a phrase over and over.
 */
export function isDegenerateNote(note: string): boolean {
	const lines = note
		.split("\n")
		.map((line) => line.trim().toLowerCase())
		.filter((line) => line.length > 0);
	if (lines.length >= 6) {
		// Thresholds set against the observed sample rather than by taste: ten
		// lines, five of them exact repeats and four sharing an opening. Prose
		// that is actually written repeats neither way, so the gap between a real
		// note and this one is wide.
		const distinct = new Set(lines).size;
		if (distinct / lines.length <= 0.6) {
			return true;
		}
		// Near-identical rather than identical: "Summary-of-thought process:" and
		// "Summary of the task at hand is at the thought process:" are different
		// strings and the same failure. Compare on the first few words.
		const stems = lines.map((line) => line.split(/\s+/).slice(0, 4).join(" "));
		if (new Set(stems).size / stems.length <= 0.5) {
			return true;
		}
	}
	const words = note.trim().toLowerCase().split(/\s+/);
	if (words.length >= 40) {
		const distinct = new Set(words).size;
		if (distinct / words.length < 0.35) {
			return true;
		}
	}
	return false;
}

/**
 * The instruction half of the retrospective call.
 *
 * The user half is the compaction's own retrospective prompt; this only says
 * who is writing and for whom.
 */
const CAPPED_THINKING_RETROSPECTIVE_SYSTEM_PROMPT =
	"You are recording what a train of reasoning established about the problem it was working on, for the agent that is about to reason about the same problem again. Not what it decided -- that is written down elsewhere -- but what it found out: the constraints, the dead ends and why they were dead, the facts about the code that took work to establish. Plain prose, no headings, no preamble.";

/**
 * The line the condensed reasoning arrives under, inside the thinking channel.
 *
 * First person, because of where it lands. The note replaces a thinking block
 * and is read as thinking; a line announcing "this is the note you left
 * yourself" turns the model's own reasoning into a document handed to it, and a
 * document gets checked rather than continued. Measured on a live run: the
 * model opened its next turn quoting the note back and arguing with a tool
 * result about it, then re-read the same file and reasoned to the budget again.
 *
 * Present continuous, like the note under it, and silent about the budget.
 * The line it replaced -- "I have already reasoned this far ... up to the point
 * where I ran out of thinking budget" -- told the story of an interruption in
 * the past perfect, which is the one thing the note is asked to leave out, and
 * put "ran out of thinking budget" at the head of every condensed think. The
 * same voice as the compaction retrospective's "I am picking the work back up
 * from here."
 */
const CONDENSED_THINKING_LEAD_IN =
	"I'm picking my reasoning back up from where it stands.";

/**
 * The instruction half of the condensation request.
 *
 * Short on purpose, and separate from the task itself, which travels as the
 * user message: the same split the compaction summariser uses. It says what the
 * note is for; `DEFAULT_CAPPED_THINKING_PROMPT` says what it must contain.
 */
export const CAPPED_THINKING_SYSTEM_PROMPT =
	"You are condensing a train of thought, in the voice of the person who is thinking it. What you write goes back into that same reasoning as the part of it already done, and is read as thinking, so write it the way thinking is written: first person, present continuous tense, plain prose, one thought after another. Keep every specific: paths, symbols, line numbers, error text, and what is set aside and why.";

/**
 * What the note must contain, and the voice it is in.
 *
 * Built on the replay compaction prompt (`DEFAULT_REPLAY_COMPACTION_PROMPT`),
 * the one that holds its voice: first person, present continuous, shapes to
 * reuse, and its own labels in the tense it asks for. The version this
 * replaces asked for "present tense" while framing everything in the past --
 * "You were reasoning", "how far you got", "what you then called" -- forbade
 * lists inside a bullet list, and ended on "Do not" lines. A prompt that
 * disagrees with itself is read as an instruction that is optional, and a
 * negative exemplar is still an exemplar. On pandorum the note it produced
 * sent the next turn into a loop: re-reasoning the note rather than going on
 * from it.
 *
 * The length is not in here. It is a target the request builder appends,
 * sized to the think and the room (`resolveCondensedThinkingNoteTokens`), so a
 * replacement prompt gets it too.
 */
export const DEFAULT_CAPPED_THINKING_PROMPT = `Your thinking on this turn has reached its budget, and the reasoning below is about to be replaced by what you write now. Write the reasoning that takes its place.

It goes back into **your own thinking channel**, as the thinking you are in the middle of. Your next pass reads it as its own train of thought and carries on from the end of it, so write it the way you think: in the **first person, present continuous tense**, in plain prose, one thought after another, the same voice as the reasoning it replaces.

Write every step as the step itself, then what is coming back. These are the shapes — reuse them:

- "I'm working out why the collision check misses the left wall."
- "I'm reading \`game.js\` around line 274, and the bounds test there compares against \`width\` where it needs \`width - size\`."
- "I'm running \`check_file\` on it, and it is reporting an unterminated regular expression at line 274."
- "I'm setting the loop rewrite aside: the fault is in the bounds test, and the loop is sound."
- "The bounds test is the cause, so what I'm doing next is editing line 274."

Every sentence holds that voice, the middle as much as the first and the last.

Carry all of this:

- **What you are being asked to do**, in a sentence.
- **Every tool call in this turn**, by name, with the argument that matters and what it is returning: the file and what is at the line you are looking at, the edit and whether it is applying, the command and what it is printing. These results are not in front of your next pass any more, so this is the only place they survive.
- **What you are treating as settled**, stated as settled.
- **What you are setting aside, and why**, a clause each. This is what keeps the next pass off ground this one has already covered.
- **Where you are**, ending on the one question still open and the single next action, stated concretely.

Name files and lines and say what you are concluding about them; the files themselves are on disk, and the next tool result is what shows their current state.

Begin with the problem itself and end on the next action.`;

interface ToolOutcome {
	name: string;
	input: string;
	result: string;
}

/** What the capped turn actually called, and what came back. */
function collectToolOutcomes(
	messages: readonly MessageWithMetadata[],
	index: number,
): ToolOutcome[] {
	const message = messages[index];
	if (!Array.isArray(message?.content)) {
		return [];
	}
	const results = new Map<string, string>();
	for (const later of messages.slice(index + 1)) {
		if (!Array.isArray(later.content)) {
			continue;
		}
		for (const block of later.content) {
			if (block.type === "tool_result") {
				results.set(block.tool_use_id, flattenToolResultContent(block.content));
			}
		}
	}
	const outcomes: ToolOutcome[] = [];
	for (const block of message.content) {
		if (block.type !== "tool_use") {
			continue;
		}
		outcomes.push({
			name: block.name,
			input: truncateText(formatToolInput(block.input), 1_000),
			result: truncateText(results.get(block.id) ?? "(no result yet)", 2_000),
		});
	}
	return outcomes;
}

function thinkingText(message: MessageWithMetadata): string {
	if (!Array.isArray(message.content)) {
		return "";
	}
	return message.content
		.filter((block) => block.type === "thinking")
		.map((block) => block.thinking)
		.join("\n")
		.trim();
}

/**
 * What this turn's reasoning cost, in the model's own tokens.
 *
 * Measured rather than estimated wherever the turn reported its output: the
 * ratio between the characters a turn produced and the tokens the provider
 * counted for them is that turn's own, and needs no assumption about how prose
 * tokenizes. The estimate is the fallback, and uses the reasoning-specific
 * ratio rather than the request-wide one, which is what made the first version
 * of this never fire.
 */
function measuredThinkingTokens(
	message: MessageWithMetadata,
	thinking: string,
): number {
	const outputTokens = (message as { metrics?: { outputTokens?: number } })
		.metrics?.outputTokens;
	if (
		typeof outputTokens === "number" &&
		Number.isFinite(outputTokens) &&
		outputTokens > 0
	) {
		const producedChars = producedCharacters(message);
		if (producedChars > 0) {
			return Math.round((thinking.length / producedChars) * outputTokens);
		}
	}
	return estimateThinkingTokens(thinking.length);
}

/** Everything the turn wrote, which is what its output tokens were spent on. */
function producedCharacters(message: MessageWithMetadata): number {
	if (!Array.isArray(message.content)) {
		return 0;
	}
	let chars = 0;
	for (const block of message.content) {
		if (block.type === "thinking") {
			chars += block.thinking.length;
		} else if (block.type === "text") {
			chars += block.text.length;
		} else if (block.type === "tool_use") {
			chars += formatToolInput(block.input).length + block.name.length;
		}
	}
	return chars;
}

/**
 * Why a look for a capped turn came back with nothing.
 *
 * Every one of these has been mistaken for "the feature is broken" at least
 * once, and from the outside they are indistinguishable: no note, no error, no
 * line. They are distinguishable from in here, so they are reported.
 */
export type CappedThinkingStandDown =
	| "no-budget"
	| "no-assistant-turn"
	| "turn-did-not-reason"
	| "budget-message-absent"
	| "under-budget";

export interface CappedThinkingLookup {
	index: number;
	reason?: CappedThinkingStandDown;
	/** Characters of reasoning on the turn that was examined. */
	thinkingChars?: number;
	/** Its last few hundred characters, which is where the message would be. */
	thinkingTail?: string;
	/** What the estimate made of it, when the estimate is what decided. */
	measuredTokens?: number;
	/** Call-only assistant messages stepped over on the way back. */
	skippedFragments?: number;
}

/** How much of the reasoning tail a stand-down line carries. */
const STAND_DOWN_TAIL_CHARS = 240;

/**
 * The most recent turn whose reasoning hit the cap, and why not when not.
 *
 * Only the most recent: older capped turns have already had their consequences
 * play out in the transcript, and rewriting history the model has since acted on
 * is a different and more dangerous idea than helping it continue.
 */
export function locateCappedThinking(
	messages: readonly MessageWithMetadata[],
	budgetTokens: number | undefined,
	options?: { budgetMessage?: string },
): CappedThinkingLookup {
	if (
		typeof budgetTokens !== "number" ||
		!Number.isFinite(budgetTokens) ||
		budgetTokens <= 0
	) {
		return { index: -1, reason: "no-budget" };
	}
	let skippedFragments = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") {
			continue;
		}
		const thinking = thinkingText(message);
		if (!thinking) {
			if (isToolCallOnly(message)) {
				// Not a turn — a fragment of one. A turn reaches the transcript
				// as its reasoning and its call, and depending on how it was
				// assembled those can arrive as one message or two. Stopping at
				// the half without the reasoning would mean never finding a
				// capped turn at all, so the search steps over it while its
				// sibling is still the most recent thing that reasoned.
				skippedFragments += 1;
				continue;
			}
			// An assistant turn that answered without reasoning ends the search:
			// the capped turn we care about is the latest one, and anything
			// before this has already been superseded.
			return {
				index: -1,
				reason: "turn-did-not-reason",
				thinkingChars: 0,
				skippedFragments,
			};
		}
		const found = {
			thinkingChars: thinking.length,
			thinkingTail: thinking.slice(-STAND_DOWN_TAIL_CHARS),
			skippedFragments,
		};
		// A known budget message settles it either way. The measurement above is
		// good but not certain — it cannot tell which cap stopped a turn, and it
		// falls back to a ratio for turns that reported no usage — whereas the
		// message is the server stating what it did. So where the session knows
		// the wording, presence confirms and absence denies, and the estimate is
		// what runs when nobody configured one.
		const budgetMessage = options?.budgetMessage?.trim();
		if (budgetMessage) {
			return endsWithBudgetMessage(thinking, budgetMessage)
				? { index, ...found }
				: { index: -1, reason: "budget-message-absent", ...found };
		}
		const measuredTokens = measuredThinkingTokens(message, thinking);
		return measuredTokens >= budgetTokens * CAP_PROXIMITY
			? { index, measuredTokens, ...found }
			: { index: -1, reason: "under-budget", measuredTokens, ...found };
	}
	return { index: -1, reason: "no-assistant-turn", skippedFragments };
}

/**
 * An assistant message carrying calls and nothing else.
 *
 * Text would make it a turn that answered; reasoning is handled by the caller.
 * Anything else — a bare call, or a call beside an image — is half of a turn
 * whose other half is the message before it.
 */
function isToolCallOnly(message: MessageWithMetadata): boolean {
	if (!Array.isArray(message.content) || message.content.length === 0) {
		return false;
	}
	return message.content.every((block) => block.type === "tool_use");
}

/** The index alone, for callers that have nothing to report it to. */
export function findCappedThinkingIndex(
	messages: readonly MessageWithMetadata[],
	budgetTokens: number | undefined,
	options?: { budgetMessage?: string },
): number {
	return locateCappedThinking(messages, budgetTokens, options).index;
}

/**
 * The last few messages, as roles and block types.
 *
 * The detector reads the transcript the runtime hands it, which is not
 * necessarily the one on disk — and the difference between those two is the
 * only thing a stand-down cannot be diagnosed without. Written as
 * `assistant:thinking(35438),tool_use` so one line says what was there.
 */
function describeTranscriptTail(
	messages: readonly MessageWithMetadata[],
	count = 3,
): string {
	return messages
		.slice(-count)
		.map((message) => {
			if (!Array.isArray(message.content)) {
				return `${message.role}:text`;
			}
			const blocks = message.content.map((block) =>
				block.type === "thinking"
					? `thinking(${block.thinking.length})`
					: block.type,
			);
			return `${message.role}:${blocks.join("+") || "empty"}`;
		})
		.join(" ");
}

/** One readable line saying which stand-down this was, and on what evidence. */
function describeStandDown(
	lookup: CappedThinkingLookup,
	config: { budgetTokens?: number; budgetMessage?: string },
): string {
	const parts: string[] = [lookup.reason ?? "unknown"];
	if (lookup.thinkingChars !== undefined) {
		parts.push(`thinking=${lookup.thinkingChars} chars`);
	}
	if (lookup.measuredTokens !== undefined) {
		parts.push(
			`measured=${lookup.measuredTokens} of ${config.budgetTokens ?? "?"} tokens`,
		);
	}
	if (lookup.skippedFragments) {
		parts.push(`callOnlyTurnsSkipped=${lookup.skippedFragments}`);
	}
	if (lookup.reason === "budget-message-absent") {
		// The two strings that failed to match, both on one line, because the
		// difference between them is the whole answer.
		parts.push(`looked for=${JSON.stringify(config.budgetMessage ?? "")}`);
		parts.push(`tail=${JSON.stringify(lookup.thinkingTail ?? "")}`);
	}
	return parts.join(" ");
}

export function buildCappedThinkingRequest(options: {
	thinking: string;
	outcomes: readonly ToolOutcome[];
	promptTemplate?: string;
	/** The reply the turn had begun writing before it was cut off. */
	partialAnswer?: string;
	/** The note's length target, in tokens (`resolveCondensedThinkingNoteTokens`). */
	noteTokens?: number;
}): string {
	const parts = [
		options.promptTemplate?.trim() || DEFAULT_CAPPED_THINKING_PROMPT,
	];
	if (options.noteTokens !== undefined && options.noteTokens > 0) {
		parts.push(describeNoteLength(options.noteTokens, options.thinking.length));
	}
	// Labels in the tense the note is asked for: a heading in the past is read
	// as permission to write the body in it.
	parts.push(`Your reasoning, as it stands:\n${options.thinking}`);
	if (options.partialAnswer?.trim()) {
		// What it had actually started to say. More committal than the reasoning
		// around it, and discarded with everything else.
		parts.push(
			`The reply you are in the middle of writing:\n${options.partialAnswer.trim()}`,
		);
	}
	if (options.outcomes.length > 0) {
		parts.push(
			`What you are calling, and what it is returning:\n${options.outcomes
				.map(
					(outcome) =>
						`- ${outcome.name}(${outcome.input})\n  → ${outcome.result}`,
				)
				.join("\n")}`,
		);
	} else {
		parts.push("There is no tool call in this turn yet.");
	}
	return parts.join("\n\n");
}

/** Words per token of English prose, for saying a length a model can aim at. */
const NOTE_WORDS_PER_TOKEN = 0.75;

/**
 * The length, said in words, against the length of what it replaces.
 *
 * Without a number the note is as short as the model dares: a think of about
 * 45,000 tokens came back as a 450-token note on pandorum (reported
 * 2026-10-18), and 64,313 and 75,317 characters as 768 and 624 on 2026-09-19 --
 * each time with the room to say four times as much. "Short enough that none of it is padding" was read as
 * the target.
 */
function describeNoteLength(noteTokens: number, thinkingChars: number): string {
	const round = (n: number) => Math.max(50, Math.round(n / 50) * 50);
	const words = round(noteTokens * NOTE_WORDS_PER_TOKEN);
	const replaced = round(
		estimateThinkingTokens(thinkingChars) * NOTE_WORDS_PER_TOKEN,
	);
	return `Write about ${words} words. The reasoning this replaces runs to about ${replaced}, and your next pass has nothing else of it to work from, so use the room: every call with what it is returning, every finding, everything you are setting aside, each with its specifics.`;
}

export interface CappedThinkingCondenserConfig {
	enabled?: boolean;
	/** The per-turn thinking allowance this session sends. */
	budgetTokens?: number;
	/**
	 * What the server appends to the reasoning when that allowance runs out,
	 * when the session knows it — configured by Cline, or reported by Ollama as
	 * the model's own. Absent for a model that has none, which is the case the
	 * measurement exists for.
	 */
	budgetMessage?: string;
	promptTemplate?: string;
	/** Absent when no provider is resolved yet; the condenser then stands down. */
	providerConfig?: ProviderConfig;
	summarizer?: CoreCompactionSummarizerConfig;
	/**
	 * The conversation the notes are written for (`ProviderConfig.sideCallOf`).
	 * Set for the lead only: an agent's note must never close the lead.
	 */
	sideCallOf?: string;
	logger?: BasicLogger;
}

type PrepareTurnInput = {
	messages: MessageWithMetadata[];
	/** The transcript as the session holds it, before any stage rewrote it. */
	sourceMessages?: MessageWithMetadata[];
	/**
	 * The channel the compaction pipeline reports through, and the only way
	 * anything that happens inside `prepareTurn` reaches the transcript on
	 * screen. Optional because a caller is free not to supply one.
	 */
	emitStatusNotice?: (
		message: string,
		metadata?: Record<string, unknown>,
	) => void;
	/** Where the condensation's own call is counted, as the agent's spend. */
	reportUsage?: (usage: PrepareTurnUsage) => void;
};
type PrepareTurnResult =
	| { messages?: readonly MessageWithMetadata[] }
	| undefined;
type PrepareTurn = (
	context: never,
) => PrepareTurnResult | Promise<PrepareTurnResult>;

/** A request answered by the conversation itself, or `undefined` to decline. */
type ConversationAsk = ((
	systemPrompt: string,
	request: string,
	maxTokens: number,
	what: string,
) => Promise<string | undefined>) & {
	/** What the conversation's last request left of the window, when measured. */
	roomTokens?: number;
};

/** Characters per token, for sizing a request before it is sent. */
const CONTINUATION_CHARS_PER_TOKEN = 3;
/** Slack on that sizing: the chat template's own tokens around one message. */
const CONTINUATION_SLACK_TOKENS = 512;

/**
 * The discarded turn's notes, asked of the conversation as its next turn
 * where that can be done (`DiscardedTurnInput.continueConversation`).
 *
 * Declines -- and the note is asked for in a request of its own, as before --
 * when the runtime offered no way to continue, when a separate summarizer
 * model is configured (it is not the conversation's model), when the provider
 * keeps no prefix to share, and when the instruction and its answer do not fit
 * in what the last request left of the window. A continuation that fails or
 * says nothing declines too: a note is never lost to the attempt.
 */
export function createConversationAsk(
	input: DiscardedTurnInput,
	config: CappedThinkingCondenserConfig,
	providerConfig: ProviderConfig,
): ConversationAsk | undefined {
	const continueConversation = input.continueConversation;
	if (!continueConversation) {
		return undefined;
	}
	const excluded = continuationCompactionExcluded(
		providerConfig,
		config.summarizer !== undefined,
	);
	if (excluded) {
		config.logger?.debug?.(
			`[capped-thinking] not asked of the conversation: ${excluded}`,
		);
		return undefined;
	}
	const room = input.continuationRoomTokens;
	const ask: ConversationAsk = async (
		systemPrompt,
		request,
		maxTokens,
		what,
	) => {
		// One user message: the conversation's own system prompt stands, so
		// the note's instruction goes in front of what it is about.
		const instruction = `${systemPrompt}\n\n${request}`;
		const need =
			Math.ceil(instruction.length / CONTINUATION_CHARS_PER_TOKEN) +
			maxTokens +
			CONTINUATION_SLACK_TOKENS;
		if (room === undefined || need > room) {
			config.logger?.log(
				`[capped-thinking] the ${what} is asked for in a request of its own: it needs about ${need} tokens and the conversation's last request left ${room ?? "an unmeasured amount"}`,
				{ severity: "info" },
			);
			return undefined;
		}
		try {
			const { text } = await continueConversation({ instruction, maxTokens });
			if (!text) {
				config.logger?.log(
					`[capped-thinking] the conversation answered the ${what} with nothing; asking in a request of its own`,
					{ severity: "info" },
				);
				return undefined;
			}
			config.logger?.log(
				`[capped-thinking] the ${what} was written as the conversation's next turn (${text.length} chars; about ${need} of ${room} free tokens)`,
				{ severity: "info" },
			);
			return text;
		} catch (error) {
			config.logger?.log(
				`[capped-thinking] the conversation could not answer the ${what} (${
					error instanceof Error ? error.message : String(error)
				}); asking in a request of its own`,
				{ severity: "info" },
			);
			return undefined;
		}
	};
	if (room !== undefined) {
		ask.roomTokens = room;
	}
	return ask;
}

/**
 * Turn one capped think into the note that replaces it.
 *
 * Extracted from the prepare-turn pipeline because the pipeline is not the only
 * place a capped think appears -- and, as it turned out, not the place it
 * appears in the case this feature exists for. See
 * `createCappedThinkingNoteWriter`.
 */
async function writeCappedThinkingNote(options: {
	thinking: string;
	outcomes: readonly ToolOutcome[];
	config: CappedThinkingCondenserConfig;
	providerConfig: ProviderConfig;
	partialAnswer?: string;
	reportUsage?: (usage: PrepareTurnUsage) => void;
	/** Tried first: the conversation's own next turn. */
	ask?: ConversationAsk;
}): Promise<string> {
	// Sized twice, once for each place the note can be written: the
	// conversation's next turn has what its last request left, a request of
	// its own has the whole window. The length sentence is the same length
	// whatever number is in it, so the request is measured with any.
	const build = (noteTokens: number) =>
		buildCappedThinkingRequest({
			thinking: options.thinking,
			outcomes: options.outcomes,
			promptTemplate: options.config.promptTemplate,
			noteTokens,
			...(options.partialAnswer
				? { partialAnswer: options.partialAnswer }
				: {}),
		});
	const sized = (roomTokens: number | undefined, extraChars = 0) => {
		const size = resolveCondensedThinkingNoteTokens({
			thinkingChars: options.thinking.length,
			requestChars: build(CONDENSED_THINKING_NOTE_TOKENS).length + extraChars,
			...(roomTokens !== undefined ? { roomTokens } : {}),
			providerConfig: options.providerConfig,
		});
		return { ...size, request: build(size.noteTokens) };
	};
	if (options.ask) {
		const forAsk = sized(
			options.ask.roomTokens,
			CAPPED_THINKING_SYSTEM_PROMPT.length,
		);
		const continued = truncateText(
			(
				(await options.ask(
					CAPPED_THINKING_SYSTEM_PROMPT,
					forAsk.request,
					forAsk.maxTokens,
					"note",
				)) ?? ""
			).trim(),
			CONDENSED_THINKING_MAX_CHARS,
		);
		if (continued && !isDegenerateNote(continued)) {
			return continued;
		}
	}
	try {
		// No output cap of its own. A fixed one was the whole failure: at 700
		// tokens against a template that reasons whatever the request asks for,
		// the summariser spent the entire budget thinking and returned a single
		// usage chunk with no text -- measured three times running, on thinks of
		// 22,011, 19,007 and 39,544 characters. Left unset, the cap resolves from
		// the window like any other turn, which is both large enough to survive a
		// forced think and already scaled to what the session has room for.
		const resolved = resolveSummarizerConfig({
			activeProviderConfig: options.providerConfig,
			summarizer: options.config.summarizer,
		});
		const own = sized(resolved.modelInfo?.contextWindow);
		const request = own.request;
		const summarizerConfig = {
			...resolved,
			maxOutputTokens: own.maxTokens,
			...(options.config.sideCallOf
				? { sideCallOf: options.config.sideCallOf }
				: {}),
		};
		options.config.logger?.debug?.(
			`Capped-thinking note asked for about ${own.noteTokens} tokens (cap ${own.maxTokens}) from ${options.thinking.length} chars of reasoning`,
		);
		const handler = await createHandlerAsync(summarizerConfig);
		let text = "";
		let chunks = 0;
		const seen: string[] = [];
		let streamError: string | undefined;
		// The prompt goes in the user half, with only the instruction above it.
		//
		// It used to be the whole system prompt against an empty message list,
		// and an empty message list is not a request: nothing reached the server
		// at all. Six condensations in one session returned a single chunk and no
		// text -- 35,872, 39,719, 36,311, 35,623, 35,588 and 13,492 characters of
		// reasoning, every one of them thrown away -- while the compaction
		// summariser, which splits the same way this now does, worked throughout.
		for await (const chunk of handler.createMessage(
			CAPPED_THINKING_SYSTEM_PROMPT,
			[{ role: "user", content: request }],
		)) {
			chunks += 1;
			if (seen.length < 8 && !seen.includes(chunk.type)) {
				seen.push(chunk.type);
			}
			if (chunk.type === "text") {
				text += chunk.text;
				continue;
			}
			if (chunk.type === "usage") {
				options.reportUsage?.({
					inputTokens: chunk.inputTokens,
					outputTokens: chunk.outputTokens,
					...(chunk.cacheReadTokens !== undefined
						? { cacheReadTokens: chunk.cacheReadTokens }
						: {}),
					...(chunk.cacheWriteTokens !== undefined
						? { cacheWriteTokens: chunk.cacheWriteTokens }
						: {}),
					...(chunk.totalCost !== undefined
						? { totalCost: chunk.totalCost }
						: {}),
				});
				continue;
			}
			if (chunk.type === "done" && !chunk.success && chunk.error) {
				streamError = chunk.error;
			}
		}
		const note = truncateText(text.trim(), CONDENSED_THINKING_MAX_CHARS);
		if (note && isDegenerateNote(note)) {
			options.config.logger?.log(
				`Capped-thinking condensation degenerated into repetition; discarding the note (${note.length} chars from ${options.thinking.length} chars of reasoning)`,
				{ severity: "warn", noteChars: note.length },
			);
			return "";
		}
		if (!note) {
			// An empty note used to return in silence, which reads exactly like a
			// condenser that was never called -- and for a whole session that is
			// how it was read. A summariser queued behind the conversation on a
			// single-slot server comes back like this: stream opened, no chunks,
			// no error. The chunk types are named because "1 chunk" said the
			// stream had answered something and not what: it took a server-side
			// request log to find out the request was never made.
			options.config.logger?.log(
				`Capped-thinking condensation produced nothing from ${options.thinking.length} chars of reasoning (${chunks} chunks received: ${
					seen.join(", ") || "none"
				})${streamError ? `; stream reported: ${streamError}` : ""}`,
				{ severity: "warn", chunks, thinkingChars: options.thinking.length },
			);
		}
		return note;
	} catch (error) {
		// A note is worth having and worth nothing at the price of the turn it
		// was meant to help.
		options.config.logger?.log(
			"Capped-thinking condensation failed; keeping the reasoning as it stands",
			{
				severity: "warn",
				errorMessage: error instanceof Error ? error.message : String(error),
			},
		);
		return "";
	}
}

/**
 * Condense reasoning that is about to be thrown away rather than sent again.
 *
 * The transcript is the wrong place to catch the turn this feature was built
 * for. A think only ends *at* the budget message when the model had no room to
 * continue -- which means the same turn also ends at the output cap with no
 * tool call, and the agent loop discards those before they reach the history.
 * Measured across a full session: every capped turn was discarded, the detector
 * re-examined the previous uncapped one, and the condenser stood down on each
 * of them, correctly and uselessly. The reasoning went in the bin with the
 * turn, and the retry started the same analysis from nothing.
 *
 * So the loop hands the reasoning here on its way to being dropped. The
 * truncated message still never re-enters the transcript; only the note does.
 *
 * Returns `undefined` when there is nothing to condense with, so a caller can
 * tell "off" from "produced nothing".
 */
export function createCappedThinkingNoteWriter(
	config: CappedThinkingCondenserConfig,
):
	| ((input: DiscardedTurnInput) => Promise<DiscardedTurnCondensation>)
	| undefined {
	if (config.enabled === false || !config.providerConfig) {
		return undefined;
	}
	const providerConfig = config.providerConfig;
	// Keyed by the reasoning, like the pipeline's: a retry that reproduces the
	// same think pays for the note once.
	const condensed = new Map<string, DiscardedTurnCondensation>();
	return async (input: DiscardedTurnInput) => {
		const trimmed = input.reasoning.trim();
		const text = input.text?.trim();
		if (!trimmed && !text) {
			return {};
		}
		const key = `${trimmed}\u0000${text ?? ""}`;
		const cached = condensed.get(key);
		if (cached !== undefined) {
			return cached;
		}
		const ask = createConversationAsk(input, config, providerConfig);
		const note = await writeCappedThinkingNote({
			...(ask ? { ask } : {}),
			thinking: trimmed,
			// The reply the turn had begun writing, offered as what it had already
			// committed to. There is never a tool call here -- a turn that made one
			// is not discarded -- so `outcomes` stays empty by definition rather
			// than by omission.
			...(text ? { partialAnswer: text } : {}),
			outcomes: [],
			config,
			providerConfig,
		});
		// The second pass, and the reason the caller says whether the window was
		// what capped the turn.
		//
		// A turn cut off by `num_predict` has, typically, most of its window
		// free: measured live, 48,508 tokens of request against 110,000, ended by
		// the caller's own 32,000-token cap. Salvaging that is worth two passes,
		// the same two a compaction makes -- a summary of where the turn had got
		// to, and a retrospective of what its reasoning established. A turn cut
		// off *by the window* has no such room, and gets the note alone.
		const retrospective =
			input.windowBound === true || !trimmed
				? undefined
				: await writeDiscardedRetrospective({
						reasoning: trimmed,
						config,
						providerConfig,
						...(ask ? { ask } : {}),
					});
		const result: DiscardedTurnCondensation = {
			...(note ? { note } : {}),
			...(retrospective ? { retrospective } : {}),
		};
		condensed.set(key, result);
		return result;
	};
}

/**
 * The retrospective half, over reasoning that is being discarded whole.
 *
 * Deliberately the compaction's own instruction rather than a second one
 * written for this: the question is identical -- what did this reasoning
 * establish that its conclusions do not carry -- and two prompts that drift
 * apart would give the same session two different kinds of retrospective
 * depending on which cap it hit.
 *
 * Cannot fail the retry: every exit is `undefined` and the note stands alone.
 */
async function writeDiscardedRetrospective(options: {
	reasoning: string;
	config: CappedThinkingCondenserConfig;
	providerConfig: ProviderConfig;
	ask?: ConversationAsk;
}): Promise<string | undefined> {
	try {
		const request = buildThinkingSummaryRequest({
			reasoningText: options.reasoning,
		});
		if (options.ask) {
			const continued = truncateText(
				(
					(await options.ask(
						CAPPED_THINKING_RETROSPECTIVE_SYSTEM_PROMPT,
						request,
						resolveCondensedThinkingOutputCap(options.providerConfig),
						"retrospective",
					)) ?? ""
				).trim(),
				CONDENSED_THINKING_MAX_CHARS,
			);
			if (continued && !isDegenerateNote(continued)) {
				return continued;
			}
		}
		const summarizerConfig = {
			...resolveSummarizerConfig({
				activeProviderConfig: options.providerConfig,
				summarizer: options.config.summarizer,
			}),
			maxOutputTokens: resolveCondensedThinkingOutputCap(
				options.providerConfig,
			),
			...(options.config.sideCallOf
				? { sideCallOf: options.config.sideCallOf }
				: {}),
		};
		const handler = await createHandlerAsync(summarizerConfig);
		let text = "";
		for await (const chunk of handler.createMessage(
			CAPPED_THINKING_RETROSPECTIVE_SYSTEM_PROMPT,
			[{ role: "user", content: request }],
		)) {
			if (chunk.type === "text") {
				text += chunk.text;
			}
		}
		const retrospective = truncateText(
			text.trim(),
			CONDENSED_THINKING_MAX_CHARS,
		);
		if (!retrospective || isDegenerateNote(retrospective)) {
			return undefined;
		}
		options.config.logger?.debug?.(
			`Discarded-turn retrospective: ${options.reasoning.length} chars of reasoning to ${retrospective.length} chars`,
		);
		return retrospective;
	} catch (error) {
		options.config.logger?.debug?.(
			`Discarded-turn retrospective failed; keeping the note alone: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return undefined;
	}
}

/**
 * Rewrite the capped turn's reasoning, then hand off to the rest of the
 * pipeline.
 *
 * Ahead of compaction rather than behind it, because a condensed turn is a
 * smaller turn: whatever compaction then decides, it decides about a transcript
 * that is not carrying seventeen thousand tokens of abandoned reasoning.
 */
export function createCappedThinkingPrepareTurn<T extends PrepareTurn>(
	inner: T | undefined,
	config: CappedThinkingCondenserConfig,
): T | undefined {
	if (config.enabled === false || !config.providerConfig) {
		// Said out loud, because the first version of this was not: it stood down
		// for a missing provider config on every session, and a feature that
		// silently does nothing looks identical to one that is working and has
		// nothing to do. There is no other line to distinguish them by.
		config.logger?.debug?.(
			config.enabled === false
				? "Capped-thinking condensation is off"
				: "Capped-thinking condensation stood down: no provider config to summarise with",
		);
		return inner;
	}
	config.logger?.debug?.(
		`Capped-thinking condensation armed at ${config.budgetTokens ?? "no"} thinking tokens${
			config.budgetMessage ? ", confirmed by the server's budget message" : ""
		}`,
	);
	const providerConfig = config.providerConfig;
	// Keyed by the reasoning itself, so a turn is condensed once however many
	// times the pipeline sees it, and a re-run of the same turn after an abort
	// reuses the note rather than paying for it again.
	const condensed = new Map<string, string>();
	/** Stand-downs already reported, so the log carries each one once. */
	const reportedStandDowns = new Set<string>();
	/**
	 * Notes already said in the chat, so each one is a row once.
	 *
	 * This runs on every turn, and the capped think stays in the transcript
	 * until something compacts it away -- so the note is found again, reused
	 * from the cache, and was announced again each time. Three identical
	 * `thinking-condensed` rows for one condensation, then two for the next,
	 * which is what the reader saw and reasonably read as the condenser firing
	 * over and over. The log line already told the two apart; the chat did not.
	 */
	const announced = new Set<string>();

	const condense = async (
		messages: MessageWithMetadata[],
		emitStatusNotice?: PrepareTurnInput["emitStatusNotice"],
		reportUsage?: PrepareTurnInput["reportUsage"],
	): Promise<MessageWithMetadata[]> => {
		const lookup = locateCappedThinking(messages, config.budgetTokens, {
			budgetMessage: config.budgetMessage,
		});
		const index = lookup.index;
		if (index < 0) {
			// Once per distinct reasoning, not once per turn: a run asks this on
			// every request and the answer only changes when the turn does.
			// Without it a stand-down is invisible, and every one of these
			// reasons has already been read as "the condenser is broken" —
			// twice, at the cost of a morning each.
			const seen = `${lookup.reason}:${lookup.thinkingTail ?? ""}`;
			if (!reportedStandDowns.has(seen)) {
				reportedStandDowns.add(seen);
				// Written into the message rather than passed beside it: the
				// host logger appends structured arguments only when verbose
				// logging is on, and this line exists precisely for the case
				// where someone is reading an ordinary log asking why nothing
				// happened. The object still goes along for anyone running
				// verbose.
				config.logger?.debug?.(
					`Capped-thinking condensation stood down: ${describeStandDown(lookup, config)} transcriptTail=[${describeTranscriptTail(messages)}]`,
					{
						reason: lookup.reason,
						thinkingChars: lookup.thinkingChars,
						measuredTokens: lookup.measuredTokens,
						budgetTokens: config.budgetTokens,
						thinkingTail: lookup.thinkingTail,
						budgetMessage: config.budgetMessage,
					},
				);
			}
			return messages;
		}
		const thinking = thinkingText(messages[index]);
		let note = condensed.get(thinking);
		// Said apart from the write, because this runs on every turn while the
		// capped think stays in the transcript, and a cache hit costs nothing.
		// Logged identically, it read as repeated work: thirteen consecutive
		// `Condensed capped thinking: 38924 chars ... 936-char note` lines, same
		// numbers, seconds apart, while the summariser was called exactly once.
		// The line was the only evidence anyone had, and it was describing the
		// wrong thing.
		const reused = note !== undefined;
		if (note === undefined) {
			// For a delegated agent's status: a condensation is a model call
			// of its own, and the agent says nothing while it runs.
			emitStatusNotice?.("thinking-condensing", {
				kind: "capped_thinking",
				phase: "started",
				thinkingChars: thinking.length,
			});
			note = await writeCappedThinkingNote({
				thinking,
				outcomes: collectToolOutcomes(messages, index),
				config,
				providerConfig,
				...(reportUsage ? { reportUsage } : {}),
			});
			condensed.set(thinking, note);
		}
		if (!note) {
			return messages;
		}
		config.logger?.debug?.(
			reused
				? `Reused the condensed note for ${thinking.length} chars of capped thinking (${note.length} chars, no new request)`
				: `Condensed capped thinking: ${thinking.length} chars of reasoning to a ${note.length}-char note`,
			{
				thinkingChars: thinking.length,
				noteChars: note.length,
				budgetTokens: config.budgetTokens,
				reused,
			},
		);
		// On screen as well as in the log, once. This note is the only record of
		// what a capped turn concluded — the reasoning it replaces is not sent
		// again — and a summary nobody can read is a summary nobody can judge;
		// the same summary said five times is a different kind of unreadable.
		if (!announced.has(thinking)) {
			announced.add(thinking);
			emitStatusNotice?.("thinking-condensed", {
				kind: "capped_thinking",
				phase: "completed",
				thinkingChars: thinking.length,
				noteChars: note.length,
				// The row this feeds reported characters, against a budget the
				// user sets in tokens -- so "45k -> 0.9k chars" sat under a
				// 16,000-token budget and the two numbers could not be compared
				// at all. Converted here rather than in the webview because the
				// reasoning rate is calibrated in this process and nowhere else.
				thinkingTokens: estimateThinkingTokens(thinking.length),
				noteTokens: estimateThinkingTokens(note.length),
				budgetTokens: config.budgetTokens,
				note,
			});
		}
		const next = [...messages];
		const target = next[index];
		next[index] = {
			...target,
			content: [
				{
					type: "thinking",
					thinking: `${CONDENSED_THINKING_LEAD_IN}\n\n${note}`,
				},
				...(Array.isArray(target.content)
					? target.content.filter((block) => block.type !== "thinking")
					: []),
			],
		} as MessageWithMetadata;
		return next;
	};

	return (async (context: PrepareTurnInput) => {
		const messages = await condense(
			context.messages,
			context.emitStatusNotice,
			context.reportUsage,
		);
		const result = (await (
			inner as unknown as
				| ((input: PrepareTurnInput) => Promise<PrepareTurnResult>)
				| undefined
		)?.({
			...context,
			messages,
			// What the session holds, for the stage that saves a compaction
			// against it: this rewrite applies to the newest turn that reasoned
			// and so to a different turn on the next request.
			sourceMessages: context.sourceMessages ?? context.messages,
		})) as PrepareTurnResult;
		if (result?.messages) {
			return result;
		}
		// The inner stage had nothing to say, but the condenser did, so the
		// rewritten transcript still has to reach the request.
		return messages === context.messages ? result : { ...result, messages };
	}) as unknown as T;
}

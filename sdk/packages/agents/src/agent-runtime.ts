import {
	classifyProviderError,
	createGateway,
	type GatewayProviderSettings,
	isRetryableProviderError,
} from "@cline/llms";
import type {
	AgentAfterToolResult,
	AgentBeforeModelResult,
	AgentBeforeToolResult,
	AgentImageToDescribe,
	AgentMessage,
	AgentMessagePart,
	AgentModel,
	AgentModelEvent,
	AgentModelFinishReason,
	AgentModelRequest,
	AgentModelToolActivity,
	AgentRunResult,
	AgentRuntimeEvent,
	AgentRuntimeHooks,
	AgentRuntimeStateSnapshot,
	AgentStopControl,
	AgentTool,
	AgentToolCallPart,
	AgentToolDefinition,
	AgentToolResult,
	AgentUsage,
	AgentRuntimeConfig as BaseAgentRuntimeConfig,
	CaptureTaskLifecycleEventInput,
	OutputTokenSplit,
	ProviderErrorClass,
	RequestTimings,
	TelemetryProperties,
	ToolApprovalResult,
	ToolCallRejection,
	ToolPolicy,
} from "@cline/shared";
import {
	ASK_QUESTION_NUDGE_CLAUSE,
	announcedIntentWithoutActing,
	answersCompletionNudge,
	buildAnnouncedIntentNudge,
	buildNonConvergenceNudge,
	buildUnparsedToolCallNudge,
	captureAgentUnexpectedReasoningTokens,
	captureSdkError,
	captureTaskLifecycleEvent,
	claimsCompletion,
	classifyTurnFault,
	classifyTurnFaultError,
	describeAdmissionWait,
	describeUnreadableToolCallStub,
	estimateTokens,
	isKvEviction,
	isKvEvictionError,
	lastOutputCap,
	mergeModelOptions,
	NO_TOOL_CALL_NUDGE_MESSAGE,
	normalizeJsonLikeStringsForSchema,
	omitUndefinedValues,
	reportsOutcome,
	TASK_CANCELLED_EVENT,
	TASK_FIRST_CHUNK_RECEIVED_EVENT,
	TASK_PROVIDER_REQUEST_STARTED_EVENT,
	TASK_PROVIDER_STREAM_FAILED_EVENT,
	TASK_PROVIDER_STREAM_STARTED_EVENT,
	TOOL_INPUT_PROGRESS_KIND,
	TOOL_REJECTION_SUFFIX,
	trimNonEmpty,
	type UnparsedToolCall,
	unparsedToolCallInText,
} from "@cline/shared";
import { nanoid } from "nanoid";
import { emptyOutputChannelTally, splitOutputTokens } from "./output-split";
import {
	contentGivenToModel,
	DEFAULT_REASONING_LOOP_GUARD,
	describeReasoningLoop,
	ReasoningLoopGuard,
	type ReasoningLoopVerdict,
} from "./reasoning-loop-guard";
import {
	createRepetitionNudger,
	DEFAULT_REASONING_REPETITION,
	describeRepetitionForLog,
	isRepetitionLoop,
	measureReasoningRepetition,
	type RepetitionNudger,
} from "./reasoning-repetition";
import { type InvalidToolCall, ToolCallAssembler } from "./tool-call-assembly";
import {
	buildToolIntentOverrunNudge,
	describeToolIntentOverrunStub,
	isToolIntentGuardEnabled,
	ToolIntentGuard,
	type ToolIntentOverrun,
} from "./tool-intent-guard";

/**
 * Wall-clock trace of the agent loop, one line per boundary, gated on
 * `CLINE_TIMING=1` and written to stderr.
 *
 * It is stderr and not `config.logger` because the CLI never wires a `debug`
 * channel — an instrumented run through it produced zero lines — and because a
 * boundary trace has to be readable next to the engine's own log, which is
 * timestamped wall-clock too. The timestamp is the whole point: what is being
 * measured is the *gap* between our boundaries and ollama's, so both sides have
 * to be on the same clock.
 *
 * Off by default and free when off: one env read at module load.
 */
const TIMING_TRACE_ENABLED = Boolean(
	(globalThis as { process?: { env?: Record<string, string | undefined> } })
		.process?.env?.CLINE_TIMING,
);

function timingTrace(line: string): void {
	if (!TIMING_TRACE_ENABLED) {
		return;
	}
	(
		globalThis as {
			process?: { stderr?: { write?: (chunk: string) => unknown } };
		}
	).process?.stderr?.write?.(`[timing] ${new Date().toISOString()} ${line}\n`);
}

/** Most characters of one call's arguments written to the log. */
export const TOOL_ARGUMENTS_LOG_CHARS = 32_000;

/**
 * One log line with a tool call's arguments as the model sent them, before
 * they are parsed, repaired or validated. The session file keeps only what
 * came out of that, and the log kept only the tool's name: a lead that said
 * it had sent `count: 3` could not be checked against the wire (pandorum
 * xs8kv, 2026-10-04). Long arguments keep their head and tail, and the line
 * says how long they were.
 */
export function describeToolArguments(
	iteration: number,
	toolName: string,
	toolCallId: string,
	inputText: string,
	parsedInput: unknown,
): string {
	let raw = inputText;
	let source = "raw";
	if (!raw.trim()) {
		// A provider that hands the call over already parsed sends no text.
		source = "parsed";
		try {
			raw = JSON.stringify(parsedInput) ?? "";
		} catch {
			raw = String(parsedInput);
		}
	}
	const flat = raw.replace(/\r?\n/g, "\\n");
	const head = Math.floor(TOOL_ARGUMENTS_LOG_CHARS * 0.75);
	const shown =
		flat.length <= TOOL_ARGUMENTS_LOG_CHARS
			? flat
			: `${flat.slice(0, head)} …[${flat.length - TOOL_ARGUMENTS_LOG_CHARS} characters not logged]… ${flat.slice(-(TOOL_ARGUMENTS_LOG_CHARS - head))}`;
	return `[tool-args] iter=${iteration} ${toolName} id=${toolCallId} ${source} chars=${flat.length} ${shown}`;
}

/** A model request after turn preparation, ready to be issued (possibly more than once). */
interface PreparedModelRequest {
	request: AgentModelRequest;
	/** When preparation began; anchors the provider-request lifecycle timings. */
	startedAt: number;
}

const MAX_TOKENS_INCOMPLETE_TURN_MESSAGE =
	"Model reached the maximum output token limit before completing the turn";

/**
 * How many truncated turns in a row are retried before the run ends.
 *
 * Bounded because each attempt costs a whole generation — up to the output cap
 * itself, which on a local model is minutes of GPU time. Two is enough for the
 * case this exists for: a model that reasoned past the cap once and, told so,
 * produces a shorter reply. A model that truncates three times running is not
 * going to be talked out of it, and ending the run beats burning the window.
 *
 * The counter is consecutive, not per-run: any turn that finishes resets it, so
 * a long session gets the same protection at every point rather than spending a
 * single allowance early.
 */
export const DEFAULT_MAX_TOKENS_TURN_RETRIES = 2;

/**
 * What the model is told after its reply was cut off.
 *
 * Said plainly, because the failure is invisible from the model's side: it
 * emitted a well-formed reply and simply never saw it end. Without being told,
 * a regenerated turn reproduces the same overlong output — the prompt has not
 * changed, and at a low temperature neither will the answer.
 *
 * It names the discarded work, since that is the part that changes behaviour:
 * the model's reasoning was thrown away and is not in the conversation, so
 * continuing from it is not an option and the cheapest correct move is one
 * small step.
 */
/**
 * Stands in for an image the model would not accept.
 *
 * Says so rather than vanishing: a tool result that quietly loses its
 * screenshot reads as a tool that did nothing, and the model calls it again.
 */
/**
 * How much of the surrounding text goes to the vision model as context.
 *
 * Enough for a browser tool's URL and console output, which is what turns "a
 * web page" into "the login form, with an error under the password field";
 * short enough that a large tool result does not become the prompt.
 */
const IMAGE_DESCRIPTION_CONTEXT_LIMIT = 2_000;

const IMAGE_DESCRIPTION_UNAVAILABLE_NOTICE =
	"[an image was here; the vision model could not describe it, and this model cannot read images. " +
	"Work from what the surrounding text says about it, or ask for the detail you need.]";

const IMAGE_DROPPED_NOTICE =
	"[image omitted — this model does not accept image input; the text above is what the tool reported]";

/**
 * The base64 payload of an image part, whichever field is carrying it.
 *
 * `AgentImagePart.image` is typed `string | Uint8Array | ArrayBuffer | URL`,
 * and parts also reach the transcript in the llms shape, which carries the
 * payload under `data`. The describer used to require a *string* under `image`
 * — one of five possibilities — and silently skipped the rest.
 *
 * Measured on a tester's 4.100.24 session: a describer was installed
 * (`[Vision] Describer installed: provider=ollama model=…`), the transcript
 * still read `transcriptTail=[user:text+image]` at request time, and no
 * `[Vision] Described N of M` line was ever logged — the describer was never
 * called, because nothing matched. The image went to a primary model that
 * cannot read one, and the turn failed.
 *
 * A `URL` is left alone deliberately: there is no payload to hand a describer
 * that takes base64, and fetching it here is not this function's business.
 */
function imagePartPayload(part: {
	image?: unknown;
	data?: unknown;
}): string | undefined {
	const candidate = typeof part.image === "string" ? part.image : part.data;
	if (typeof candidate === "string") {
		return candidate.length > 0 ? candidate : undefined;
	}
	const binary =
		part.image instanceof Uint8Array
			? part.image
			: part.image instanceof ArrayBuffer
				? new Uint8Array(part.image)
				: undefined;
	if (!binary || binary.byteLength === 0) {
		return undefined;
	}
	return Buffer.from(binary).toString("base64");
}

/**
 * The least a retry after a truncated turn may be given.
 *
 * Above the largest turn measured recovering from one of these (5,568 output
 * tokens), so the ladder bounds the waste without truncating the turn that was
 * about to get the work done.
 */
const RETRY_OUTPUT_CAP_FLOOR_TOKENS = 8_000;

const MAX_TOKENS_INCOMPLETE_TURN_REMINDER =
	"[SYSTEM] Your last reply hit the per-turn output limit before you finished, so it was discarded — none of it, including your reasoning, is in this conversation. " +
	"Do not try to reproduce it. Take the smallest useful next step instead: make one tool call, or write one short paragraph. " +
	"If the work you were planning does not fit in one reply, do the part that fits, call the tools it needs, and continue in the next turn.";

/**
 * How the retrospective is introduced, when there was room to write one.
 *
 * Separate from the note because it answers a different question. The note is
 * where the turn had got to; this is what the reasoning learned on the way --
 * the part a summary drops first and the part that stops the next pass walking
 * into the same wall.
 */
const DISCARDED_RETROSPECTIVE_PREFIX =
	"And what that reasoning had established about the problem itself:";

/**
 * How the salvaged reasoning is introduced to the model.
 *
 * As the model's own note, not as a system finding: it wrote the reasoning this
 * summarises, and a turn told "here is what you concluded" resumes, where one
 * told "here is some context" re-derives it to check.
 *
 * The precedence sentence is not decoration. The first note this produced on a
 * live run carried a fragment of the file as the model had read it -- `…
 * c.fill();}}});}` -- and the file had been edited since, so the model opened
 * its next turn arguing with a tool result: "I see this in my thought process
 * but the tool output says…". A note is a recollection of reasoning, and the
 * only thing it can be wrong about is the world; saying which one wins costs a
 * sentence and settles it before it starts.
 */
const DISCARDED_REASONING_NOTE_PREFIX =
	"Before it was discarded, your reasoning was condensed into the note below. It is what you had worked out when you ran out of room. Continue from it rather than repeating it. " +
	"It is a record of your thinking, not an observation of the workspace: where it disagrees with a tool result in this conversation, the tool result is what is true and the note is out of date.";

/**
 * Sent when a turn spent its tokens and delivered nothing.
 *
 * Same wording as the output-limit reminder for the same reason: what the model
 * has to do next is identical, and the two are indistinguishable from where it
 * sits. It reasoned, the reply never arrived, and reproducing the thought that
 * did not fit is the one thing that cannot work.
 */
/**
 * Sent after the model answers a message that arrived mid-run.
 *
 * Deliberately says the answer was received: without that the model re-answers
 * instead of resuming, having no way to tell the reminder apart from the user
 * asking again.
 */
const STEER_RESUME_REMINDER =
	"[SYSTEM] Your answer has been passed on. That message came in while you were working, so it did not replace the task you were given — " +
	"the work you were doing when it arrived is still unfinished. Take that work up again from where you left off, unless the message told you to change course or to stop.";

const EMPTY_TURN_REMINDER =
	"[SYSTEM] Your last reply ran out of room before any of it was delivered, so it was discarded — none of it, including your reasoning, is in this conversation. " +
	"Do not try to reproduce it. Take the smallest useful next step instead: make one tool call, or write one short paragraph. " +
	"If the work you were planning does not fit in one reply, do the part that fits, call the tools it needs, and continue in the next turn.";

/**
 * Sent when a turn was thinking and nothing else.
 *
 * Not the empty-turn case: the message has a part, the reasoning, so nothing
 * treats it as wasted, and with no tool call and no nudge left to send the
 * run simply ended on it. Measured on pandorum session k3ba1 (2026-10-03): 13 of 15 agents ended
 * this way, each reported as "ended without an answer of its own".
 */
const THINKING_ONLY_REMINDER =
	"[SYSTEM] Your last reply was thinking only: no answer and no tool call arrived. " +
	"End your thinking, then either make one tool call or write your answer. Keep the thinking short.";

/**
 * The same, when the thinking held the end of a tool call: the call was
 * written before the thinking channel was closed, so it was never a call.
 * Telling the model that is the whole difference -- "thinking only" reads as
 * "think less", and what it has to do is write the same call somewhere else.
 */
const TOOL_CALL_IN_THINKING_REMINDER =
	"[SYSTEM] Your last reply ended inside your thinking: the tool call you wrote there was part of the thinking, so it never ran and nothing was changed by it. " +
	"Close your thinking first, then send that one call again as an actual tool call. Keep the thinking short.";

/** How many thinking-only turns in a row are taken again before the run ends on one. */
const THINKING_ONLY_RETRY_BUDGET = 3;
/** After this many cuts running, the next request is not guarded. */
const TOOL_INTENT_CUTS_BEFORE_STAND_DOWN = 2;

/** Kept back from the window when sizing what else fits beside a request. */
const CONTINUATION_WINDOW_RESERVE_TOKENS = 1_024;

/** Tool-call markup, as the templates this fork runs write it. */
const TOOL_CALL_MARKUP = /<\/?tool_call>|<\/function>|<function=|<\/parameter>/;

/** Thinking, and neither an answer nor a call. */
function thinkingOnlyTurn(
	message: AgentMessage,
): { toolCallInThinking: boolean } | undefined {
	let reasoning = "";
	for (const part of message.content) {
		if (part.type === "reasoning") {
			const text = (part as { text?: unknown }).text;
			reasoning += typeof text === "string" ? text : "";
			continue;
		}
		if (part.type === "text") {
			if (((part as { text?: unknown }).text as string | undefined)?.trim()) {
				return undefined;
			}
			continue;
		}
		// A tool call, an image, anything else: the turn delivered something.
		return undefined;
	}
	return reasoning.trim()
		? { toolCallInThinking: TOOL_CALL_MARKUP.test(reasoning) }
		: undefined;
}

const TOOL_CALL_UNPARSABLE_REMINDER =
	"[SYSTEM] Your last tool call did not parse, so it never ran and nothing was changed by it. " +
	"The text you wrote before it is still here and still correct — the call around it was malformed, most often because it was cut short. " +
	"Send that one call again, complete, and nothing else in this reply. " +
	"If it carries a large argument, make the argument smaller rather than sending the same one again: name a line range instead of a whole file, or split the work across two calls.";

/**
 * The reminder for a call the engine rejected and said why.
 *
 * `swallowed_key` is the one measured shape (opencoti bug-3601, 16 workers of
 * a 75-agent swarm): a long string argument full of code was ended with a
 * backtick from that code, so the parser read the next argument as part of
 * the value. The generic "it did not parse, make it smaller" sends the model
 * back to write the same call the same way. Naming the argument it ran into
 * and the cause gives it the one thing to do differently. Any other reason
 * gets the generic text, since there is nothing specific to say about a rule
 * we have not seen.
 */
export function toolCallUnparsableReminder(
	rejection?: ToolCallRejection,
): string {
	if (rejection?.reason !== "swallowed_key") {
		return TOOL_CALL_UNPARSABLE_REMINDER;
	}
	const call = rejection.tool ? `\`${rejection.tool}\` call` : "tool call";
	const into = rejection.key
		? `ran on into \`${rejection.key}\`, so the parser read \`${rejection.key}\` and what followed as part of that value`
		: "ran on into the next argument, so the parser read that argument as part of the value";
	return (
		`[SYSTEM] Your last ${call} was rejected before it ran, and nothing was changed by it. ` +
		`A string argument in it never closed: it ${into}. ` +
		"This happens when a string argument that contains code is ended with a character from that code, such as a backtick or a quote, instead of the tool-call format's own string delimiter. " +
		"Send that one call again, complete, and nothing else in this reply, with every string argument closed by the format's delimiter."
	);
}

/**
 * How many times one turn may be asked to resend a call before the run ends.
 *
 * Two, and it resets on any turn that parses. A model that cannot produce a
 * well-formed call twice running is not going to on the third attempt, and the
 * run has somewhere better to spend the clock; a model that hit a truncated
 * argument once has been told to make it smaller and usually can.
 */
const TOOL_CALL_PARSE_RETRY_BUDGET = 2;

/**
 * The nudge budget for hosts that want it without picking a number.
 *
 * Off by default, because "a turn with no tool calls ends the run" is the
 * runtime's contract and not an oversight. A bound is what keeps the nudge
 * from being a way to make a run immortal. The counter resets on any turn that
 * does call tools, so the limit applies to consecutive silent turns rather
 * than to the run as a whole.
 *
 * One, not two. The nudge asks a question with two branches — keep working, or
 * say you are finished in one short sentence — and both are answered in a
 * single turn. Sending it twice asks a model that has already answered to
 * answer again, and it costs a full provider round trip to learn nothing.
 * Measured on a 438-message session: the model was nudged, replied "The task
 * is fully complete — all syntax errors have been resolved and verified",
 * was nudged again with the identical text, and replied with the same
 * sentence. The second nudge has never once changed an outcome.
 */
export const DEFAULT_MAX_NO_TOOL_CALL_NUDGES = 1;

/**
 * Consecutive turns without a tool call before the run is told so.
 *
 * The counter above is spent by the *first* silent turn and reset by the first
 * working one, which makes it blind to the run that alternates: think at
 * length, call nothing, be answered by a transaction message or a reminder,
 * think at length again. `consecutiveNoToolCallNudges` reads that as one
 * silent turn repeatedly, because nothing between them was a nudge.
 *
 * Three, from the corpus this was measured on: 106 assistant turns across
 * eight runs of one model, where a threshold of three fired exactly once, on
 * the run that spent six turns and ~226,000 characters of reasoning producing
 * nothing. Two would have fired twice; four also fires once. Three is the
 * conservative end of the range that still catches the case.
 *
 * The sample is small and the bound is honest about it: zero false triggers in
 * 105 turns puts the 95% ceiling near 3%, not at zero. That is affordable only
 * because this nudges and never ends a run.
 */
export const DEFAULT_NO_TOOL_CALL_TURN_STREAK_LIMIT = 3;

/**
 * Reasoning a silent turn must carry to count toward the streak.
 *
 * Without this the guard fires on the opposite failure: a model that has
 * finished, answers a completion boundary in one terse sentence, is asked
 * again, and answers again. Three short replies are not a run that has stopped
 * converging -- they are a run being nagged, and telling it to "stop analysing
 * and make one tool call" is exactly wrong.
 *
 * Found by the test for it, not by inspection. On the measured corpus the
 * separation is not close: the silent turns of the run that failed carried
 * 26,000 to 41,000 characters of reasoning each, while every barren turn under
 * 4,000 characters was a final answer (270, 420, 755, 800). Two thousand sits
 * in the empty middle, and adding it removed five of the seven turn-pairs a
 * threshold of two would have fired on while leaving the real one untouched.
 *
 * A turn below the floor resets the streak rather than being skipped. Both
 * behave identically on the corpus, so the guard takes the one that fires
 * less.
 */
export const NON_CONVERGENCE_MIN_REASONING_CHARS = 2000;

/**
 * How many times to retry a model turn that failed with a transient,
 * provider-side error (rate limits, 5xx, network hiccups, OpenRouter's
 * generic "Provider returned error"). The initial attempt is not counted, so
 * a value of 3 means up to 4 total requests for one turn. Retrying only
 * transient errors — and never auth, context-overflow, or other client errors
 * (see {@link isRetryableProviderError}) — keeps well-behaved providers on
 * their existing single-request path, so this does not change behavior for
 * models whose endpoints do not throw transient errors.
 */
const PROVIDER_ERROR_MAX_RETRIES = 3;
/** Base backoff before the first retry; doubled each subsequent attempt. */
const PROVIDER_ERROR_RETRY_BASE_DELAY_MS = 1_000;
/** Upper bound on any single backoff wait. */
const PROVIDER_ERROR_RETRY_MAX_DELAY_MS = 15_000;

/**
 * Terminal message for a turn the provider blocked. Kept separate from the
 * generic empty-response text because the two call for opposite user action:
 * an empty response is worth retrying, a filtered one reproduces every time.
 */
const CONTENT_FILTER_EMPTY_TURN_MESSAGE =
	"Model returned no content because the response was blocked by a content filter. Retrying is unlikely to help — try rephrasing the request.";

/**
 * Terminal message when a context-window overflow cannot be recovered because
 * there is no conversation history to compact — the system prompt, tools, and
 * current input alone exceed the window.
 */
export const CONTEXT_WINDOW_OVERFLOW_NOTHING_TO_COMPACT_MESSAGE =
	"The request exceeds the model's context window and there is no conversation history to compact — the system prompt, tools, and current input alone are too large. Reduce attached content or switch to a model with a larger context window.";

/**
 * Terminal message when a context-window overflow persists after the runtime
 * already compacted the conversation and retried once.
 */
export const CONTEXT_WINDOW_OVERFLOW_RECOVERY_FAILED_MESSAGE =
	"The conversation still exceeds the model's context window after compacting it. Start a new session or switch to a model with a larger context window.";

/**
 * Terminal message when no compaction pipeline is available to recover from a
 * context-window overflow (e.g. compaction disabled).
 */
export const CONTEXT_WINDOW_OVERFLOW_NO_RECOVERY_MESSAGE =
	"The conversation exceeds the model's context window. Compact the conversation, start a new session, or switch to a model with a larger context window.";

/** Thrown when overflow recovery cannot proceed; carries the terminal text. */
class ContextWindowOverflowError extends Error {
	constructor(message: string, providerError: string | undefined) {
		super(
			providerError?.trim()
				? `${message} (provider reported: ${providerError.trim()})`
				: message,
		);
		this.name = "ContextWindowOverflowError";
	}
}

// Local `createUID` helper. The clinee source imports this from
// `@cline/shared` (see `packages/shared/dist/identifier.ts`), but
// sdk-re's shared package does not expose it yet. Inlining here keeps
// PLAN.md Step 1 scoped to `packages/agents/src/` and matches the
// exact clinee implementation (`${prefix}_${nanoid(length)}`).
function createUID(prefix: string, length = 8): string {
	return `${prefix}_${nanoid(length)}`;
}

export type AgentRunInput = string | AgentMessage | readonly AgentMessage[];
export type AgentEventListener = (event: AgentRuntimeEvent) => void;

/**
 * Advanced form: caller supplies a pre-built `AgentModel`. Used by
 * `@cline/core`, which constructs models itself to share gateway/telemetry
 * wiring with the rest of the session runtime.
 */
export interface AgentRuntimeConfigWithModel extends BaseAgentRuntimeConfig {
	model: AgentModel;
}

/**
 * Friendly form: caller supplies provider/model IDs and credentials, and the
 * runtime builds an `AgentModel` internally via `@cline/llms`. This is the
 * entry point most standalone users want.
 */
export interface AgentRuntimeConfigWithProvider
	extends Omit<BaseAgentRuntimeConfig, "model"> {
	/** Provider ID (e.g., "anthropic", "openai") */
	providerId: string;
	/** Model ID to use */
	modelId: string;
	/** API key for the provider */
	apiKey?: string;
	/** Custom base URL for the API */
	baseUrl?: string;
	/** Additional headers for API requests */
	headers?: Record<string, string>;
	/** Provider-specific gateway options */
	options?: GatewayProviderSettings["options"];
}

/**
 * Config accepted by `new AgentRuntime(...)` / `createAgentRuntime(...)` /
 * `new Agent(...)` / `createAgent(...)`. Either supply a pre-built `model`
 * (advanced) or `providerId` + `modelId` (+ credentials) and the runtime will
 * construct the model itself via `@cline/llms`.
 */
export type AgentRuntimeConfig =
	| AgentRuntimeConfigWithModel
	| AgentRuntimeConfigWithProvider;

function hasPrebuiltModel(
	config: AgentRuntimeConfig,
): config is AgentRuntimeConfigWithModel {
	return (config as AgentRuntimeConfigWithModel).model !== undefined;
}

function resolveRuntimeConfig(
	config: AgentRuntimeConfig,
): BaseAgentRuntimeConfig {
	if (hasPrebuiltModel(config)) {
		return config;
	}
	const { providerId, modelId, apiKey, baseUrl, headers, options, ...rest } =
		config;
	const gateway = createGateway({
		providerConfigs: [{ providerId, apiKey, baseUrl, headers, options }],
		telemetry: rest.telemetry,
	});
	const model = gateway.createAgentModel({ providerId, modelId });
	// The prebuilt-model path preserves a caller-provided messageModelInfo;
	// mirror that here so the provider/model constructor also tags assistant
	// messages with modelInfo. An explicit caller-provided value still wins.
	const messageModelInfo = rest.messageModelInfo ?? {
		id: modelId,
		provider: providerId,
	};
	return { ...rest, model, messageModelInfo };
}

function resolveToolPolicy(
	toolName: string,
	policies: BaseAgentRuntimeConfig["toolPolicies"],
): ToolPolicy {
	return {
		...(policies?.["*"] ?? {}),
		...(policies?.[toolName] ?? {}),
	};
}

function safeJsonSize(value: unknown): number {
	try {
		return JSON.stringify(value).length;
	} catch {
		return String(value).length;
	}
}

function getOutputSize(output: unknown): number {
	if (typeof output === "string") {
		return output.length;
	}
	return safeJsonSize(output);
}

function summarizeModelRequest(
	request: AgentModelRequest,
): Record<string, unknown> {
	let textChars = request.systemPrompt?.length ?? 0;
	let toolResultCount = 0;
	let toolResultChars = 0;
	let maxToolResultChars = 0;
	for (const message of request.messages) {
		for (const part of message.content) {
			switch (part.type) {
				case "text":
					textChars += part.text.length;
					break;
				case "reasoning":
					textChars += part.text.length;
					break;
				case "file":
					textChars += part.content.length;
					break;
				case "tool-call":
					textChars += safeJsonSize(part.input);
					break;
				case "tool-result": {
					const outputChars = getOutputSize(part.output);
					toolResultCount += 1;
					toolResultChars += outputChars;
					maxToolResultChars = Math.max(maxToolResultChars, outputChars);
					textChars += outputChars;
					break;
				}
			}
		}
	}

	return {
		messageCount: request.messages.length,
		toolSchemaCount: request.tools.length,
		systemPromptChars: request.systemPrompt?.length ?? 0,
		requestJsonChars: safeJsonSize({
			systemPrompt: request.systemPrompt,
			messages: request.messages,
			tools: request.tools,
			options: request.options,
		}),
		visibleTextChars: textChars,
		estimatedTextTokens: estimateTokens(textChars),
		toolResultCount,
		toolResultChars,
		maxToolResultChars,
	};
}

interface PreparedToolExecution {
	toolCall: AgentToolCallPart;
	tool?: AgentTool;
	input: unknown;
	skipReason?: string;
	/** Instrumentation: how long `prepareToolExecution` took, beforeTool hooks included. */
	prepareMs?: number;
}

interface HookBag {
	beforeRun: NonNullable<AgentRuntimeHooks["beforeRun"]>[];
	afterRun: NonNullable<AgentRuntimeHooks["afterRun"]>[];
	beforeModel: NonNullable<AgentRuntimeHooks["beforeModel"]>[];
	afterModel: NonNullable<AgentRuntimeHooks["afterModel"]>[];
	beforeTool: NonNullable<AgentRuntimeHooks["beforeTool"]>[];
	afterTool: NonNullable<AgentRuntimeHooks["afterTool"]>[];
	onEvent: NonNullable<AgentRuntimeHooks["onEvent"]>[];
}

/** The run used every turn `maxIterations` gave it. */
class MaxIterationsReachedError extends Error {
	constructor(maxIterations: number | undefined) {
		super(`Agent runtime exceeded maxIterations (${maxIterations})`);
		this.name = "MaxIterationsReachedError";
	}
}

class ControlledStopError extends Error {
	readonly reason?: string;

	constructor(reason?: string) {
		super(reason ?? "Run stopped by runtime control");
		this.name = "ControlledStopError";
		this.reason = reason;
	}
}

export class AgentRuntimeAbortError extends Error {
	readonly reason?: unknown;

	constructor(reason?: unknown) {
		const message =
			typeof reason === "string"
				? reason
				: reason instanceof Error
					? reason.message
					: reason === undefined
						? "Run aborted"
						: String(reason);
		super(message);
		this.name = "AgentRuntimeAbortError";
		this.reason = reason;
	}
}

const DEFAULT_USAGE: AgentUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
};

function createMessage(
	role: AgentMessage["role"],
	content: AgentMessagePart[],
	metadata?: Record<string, unknown>,
): AgentMessage {
	return {
		id: createUID("msg"),
		role,
		content,
		createdAt: Date.now(),
		metadata,
	};
}

function cloneUsage(usage: AgentUsage): AgentUsage {
	return { ...usage };
}

const HOOK_ATTRIBUTE_ESCAPES: Record<string, string> = {
	_: "__",
	'"': "_q_",
	"<": "_lt_",
	">": "_gt_",
};

function sanitizeHookAttribute(value: string): string {
	// The underscore escapes itself, which makes the encoding injective
	// (uniquely decodable escape code): no two distinct ids can collapse to
	// the same sanitized stamp.
	return value.replace(/[_"<>]/g, (char) => HOOK_ATTRIBUTE_ESCAPES[char]);
}

/**
 * Where a hook context block came from. Tool hooks carry the call they ran
 * for; run-start hooks (TaskStart/UserPromptSubmit/TaskResume in their
 * various layer spellings) have no tool identity, and the layers merge their
 * outputs before the runtime sees them, so a single generic source labels
 * those blocks.
 */
type HookContextOrigin =
	| { source: "RunStart" }
	| { source: "PreToolUse" | "PostToolUse"; toolCall: AgentToolCallPart };

function formatHookContextBlock(
	origin: HookContextOrigin,
	text: string,
): string {
	// Tool identity keeps each block attributable to its call: contexts are
	// batched into one message after the tool results, and parallel tool
	// execution collects them in completion order, so position alone cannot
	// identify the tool. Attribute values are sanitized and embedded
	// hook_context tags (opening and closing) neutralized so neither
	// provider-supplied ids nor hook output can corrupt or spoof the block
	// markup.
	const attributes = [`source="${origin.source}"`];
	if ("toolCall" in origin) {
		attributes.push(
			`tool_name="${sanitizeHookAttribute(origin.toolCall.toolName)}"`,
			`tool_call_id="${sanitizeHookAttribute(origin.toolCall.toolCallId)}"`,
		);
	}
	const body = text.trim().replace(/<(\/?)hook_context/gi, "<\\$1hook_context");
	return `<hook_context ${attributes.join(" ")}>\n${body}\n</hook_context>`;
}

function cloneMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.map((message) => ({
		...message,
		content: message.content.map((part: AgentMessagePart) => ({ ...part })),
		metadata: message.metadata ? { ...message.metadata } : undefined,
		modelInfo: message.modelInfo ? { ...message.modelInfo } : undefined,
		metrics: message.metrics ? { ...message.metrics } : undefined,
	}));
}

function usageDelta(
	start: AgentUsage,
	end: AgentUsage,
): NonNullable<AgentMessage["metrics"]> | undefined {
	const inputTokens = Math.max(
		0,
		(end.inputTokens ?? 0) - (start.inputTokens ?? 0),
	);
	const outputTokens = Math.max(
		0,
		(end.outputTokens ?? 0) - (start.outputTokens ?? 0),
	);
	const cacheReadTokens = Math.max(
		0,
		(end.cacheReadTokens ?? 0) - (start.cacheReadTokens ?? 0),
	);
	const cacheWriteTokens = Math.max(
		0,
		(end.cacheWriteTokens ?? 0) - (start.cacheWriteTokens ?? 0),
	);
	const reasoningTokenCount = Math.max(
		0,
		(end.reasoningTokenCount ?? 0) - (start.reasoningTokenCount ?? 0),
	);
	const startCost = start.totalCost ?? 0;
	const endCost = end.totalCost ?? 0;
	const cost = Math.max(0, endCost - startCost);
	if (
		inputTokens === 0 &&
		outputTokens === 0 &&
		cacheReadTokens === 0 &&
		cacheWriteTokens === 0 &&
		reasoningTokenCount === 0 &&
		cost === 0
	) {
		return undefined;
	}
	return {
		inputTokens: inputTokens > 0 ? inputTokens : 0,
		outputTokens: outputTokens > 0 ? outputTokens : 0,
		cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : 0,
		cacheWriteTokens: cacheWriteTokens > 0 ? cacheWriteTokens : 0,
		...(reasoningTokenCount > 0 ? { reasoningTokenCount } : {}),
		...(cost > 0 ? { cost } : {}),
	};
}

function reasoningWasRequestedOff(request: AgentModelRequest): boolean {
	return request.options?.thinking === false;
}

function textFromMessage(message: AgentMessage | undefined): string {
	if (!message) {
		return "";
	}
	return message.content
		.filter(
			(
				part: AgentMessagePart,
			): part is Extract<AgentMessagePart, { type: "text" }> =>
				part.type === "text",
		)
		.map((part: Extract<AgentMessagePart, { type: "text" }>) => part.text)
		.join("");
}

/**
 * The turn's reasoning as one block.
 *
 * Joined with a blank line because the repetition measure counts paragraphs,
 * and two reasoning parts are two paragraphs, never one run-on.
 */
function reasoningTextInMessage(message: AgentMessage | undefined): string {
	if (!message) {
		return "";
	}
	const blocks: string[] = [];
	for (const part of message.content) {
		if (part.type !== "reasoning") {
			continue;
		}
		const text = (part as { text?: unknown }).text;
		if (typeof text === "string" && text.length > 0) {
			blocks.push(text);
		}
	}
	return blocks.join("\n\n");
}

/** How much reasoning a turn produced, for the streak the run is measured on. */
function reasoningCharsInMessage(message: AgentMessage | undefined): number {
	if (!message) {
		return 0;
	}
	return message.content.reduce((total: number, part: AgentMessagePart) => {
		if (part.type !== "reasoning") {
			return total;
		}
		const text = (part as { text?: unknown }).text;
		return total + (typeof text === "string" ? text.length : 0);
	}, 0);
}

function textFromToolMessage(message: AgentMessage | undefined): string {
	const result = message?.content.find(
		(part): part is Extract<AgentMessagePart, { type: "tool-result" }> =>
			part.type === "tool-result",
	);
	if (!result || result.isError) {
		return "";
	}
	if (typeof result.output === "string") {
		return result.output;
	}
	try {
		return JSON.stringify(result.output);
	} catch {
		return String(result.output);
	}
}

function normalizeInput(input: AgentRunInput): AgentMessage[] {
	if (typeof input === "string") {
		return [createMessage("user", [{ type: "text", text: input }])];
	}
	if (Array.isArray(input)) {
		return cloneMessages(input);
	}
	return cloneMessages([input as AgentMessage]);
}

/**
 * How many tool calls from one assistant message run at once when nothing
 * says otherwise.
 *
 * Eight is not a new number: it is the documented default of
 * `AgentConfig.maxParallelToolCalls` and of `AgentConfigSchema`, and it had
 * never once been applied. `resolveToolExecution` read the field as a
 * yes/no, no host on the extension path set it, so the runtime fell through
 * to `"sequential"` -- while every prompt template in
 * `core/assets/prompt-templates` tells the model to emit its independent
 * reads, searches and commands together. The batch arrived and was run one
 * call at a time, and delegation was the visible half of it: several
 * `spawn_agent` calls in one message waited for each other, so a model that
 * said it would run agents in parallel never did.
 */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 8;

/**
 * The one number both tool-execution fields resolve to.
 *
 * `toolExecution: "sequential"` is an explicit request for one at a time and
 * wins over any count. Otherwise the count decides, floored at 1, and its
 * absence means the documented default. Keeping this in one function is the
 * point: a mode field and a count field that can disagree are two homes for
 * one setting, and the last three bugs here were a field with two readers.
 */
export function resolveParallelToolCallBound(config: {
	toolExecution?: "sequential" | "parallel";
	maxParallelToolCalls?: number;
}): number {
	if (config.toolExecution === "sequential") {
		return 1;
	}
	const configured = config.maxParallelToolCalls;
	if (typeof configured === "number" && Number.isFinite(configured)) {
		return Math.max(1, Math.floor(configured));
	}
	return DEFAULT_MAX_PARALLEL_TOOL_CALLS;
}

export class AgentRuntime {
	private config: Required<
		Pick<BaseAgentRuntimeConfig, "toolExecution" | "maxParallelToolCalls">
	> &
		BaseAgentRuntimeConfig;
	private readonly listeners = new Set<AgentEventListener>();
	// biome-ignore lint/suspicious/noExplicitAny: tool input/output types vary per tool
	private readonly tools = new Map<string, AgentTool<any, any>>();
	private hooks: HookBag = {
		beforeRun: [],
		afterRun: [],
		beforeModel: [],
		afterModel: [],
		beforeTool: [],
		afterTool: [],
		onEvent: [],
	};
	/**
	 * `appendContext` blocks waiting to be injected as one user message.
	 * beforeRun hooks fill it before the run's first model request; beforeTool
	 * and afterTool hooks fill it during an iteration's tool executions and it
	 * flushes after the tool results, so tool-result parts stay contiguous for
	 * providers that require them first in the following turn.
	 */
	private pendingHookContexts: string[] = [];
	private readonly state = {
		agentId: "",
		agentRole: undefined as string | undefined,
		parentAgentId: undefined as string | null | undefined,
		runId: undefined as string | undefined,
		status: "idle" as AgentRuntimeStateSnapshot["status"],
		iteration: 0,
		messages: [] as AgentMessage[],
		pendingToolCalls: [] as string[],
		usage: cloneUsage(DEFAULT_USAGE),
		/**
		 * Timings for the most recent model request, kept apart from `usage`
		 * because they replace rather than accumulate: a duration is a property
		 * of one request, and two of them do not sum to anything meaningful.
		 */
		lastRequestTimings: undefined as RequestTimings | undefined,
		lastError: undefined as string | undefined,
		lastErrorClass: undefined as ProviderErrorClass | undefined,
		/** Provider-reported input tokens for the most recent request this run. */
		lastRequestInputTokens: 0,
		/**
		 * Whether the last provider failure was transient and worth retrying,
		 * carried from the model boundary via `errorRetryable` on the `finish`
		 * event (the AI SDK's typed `isRetryable` flag). Undefined when no such
		 * signal was provided, in which case the agent loop classifies from the
		 * flattened `lastError` message instead.
		 */
		lastErrorRetryable: undefined as boolean | undefined,
		/**
		 * Whether the model layer already recorded `sdk.error` telemetry for
		 * `lastError` (from `errorReported` on the stream's `finish` event).
		 * Custom `AgentModel` implementations that do not record their own
		 * telemetry leave this false, so their failures still get reported.
		 */
		lastErrorReported: false,
		/**
		 * Finish reason carried into the run-failed `sdk.error` event. Set
		 * only at the throw sites where a finish reason IS the failure's
		 * cause (empty turn, max-tokens, provider error) — never recorded
		 * ambiently on finish events, so a failure elsewhere in the loop
		 * (hooks, listeners, transport, setup) can never inherit a reason
		 * from a request that did not cause it. Undefined means the
		 * attribute is omitted, which is always safe; a wrong reason is not.
		 */
		lastFinishReason: undefined as AgentModelFinishReason | undefined,
	};
	/**
	 * What the engine said was wrong with the last tool call it rejected.
	 * Replaced on every failed turn, so it only ever describes `lastError`.
	 */
	private lastToolCallRejection: ToolCallRejection | undefined;
	/** One automatic overflow-recovery attempt per run. */
	private overflowRecoveryAttempted = false;
	/**
	 * The last request that completed, prompt and reply: what the engine held
	 * for this session at the least. Named in an eviction's bug report.
	 */
	private lastRequestTokens: number | undefined;
	/**
	 * Compact before the next request, whatever the trigger concludes.
	 *
	 * Set when a turn was cut off at the output cap. Re-prompting on its own only
	 * asks the model to be briefer, which does nothing when the cap is small
	 * because the prompt has taken the window -- the retry then hits the same
	 * wall, and the run spends its whole retry budget on identical failures.
	 * Making room is the part that changes the outcome.
	 */
	private compactBeforeNextTurn = false;
	/**
	 * Whether this run has already dropped images after a model refused them.
	 * Once is enough: the second refusal means images were not the problem.
	 */
	private imageRecoveryAttempted = false;
	/** Consecutive turns nudged for producing no tool calls; reset by any turn that does. */
	private consecutiveNoToolCallNudges = 0;
	/**
	 * Whether this run has already been asked if it is finished.
	 *
	 * Not reset by a turn that calls tools, unlike the count above: a model
	 * that answers the question by checking its work and then says it is done
	 * has answered, and is not asked again.
	 */
	private noToolCallNudgeAsked = false;
	/** Whether this run has called a tool; see `reportsOutcome`. */
	private calledToolThisRun = false;
	/**
	 * The tool that said it stopped at something only the user can change,
	 * until the run does other work: a call of a different tool that is not
	 * read-only and did not fail. Looking at what was saved is not other
	 * work, and neither is a second try of the same tool -- session eyyof
	 * listed the folder twice, read the index and had a workaround refused
	 * before writing its report.
	 */
	private stoppedForUserBy: string | undefined;
	/**
	 * Whether this run has ever called a tool.
	 *
	 * Separates a task in progress from a conversation. Never reset: a run that
	 * has acted once is a run with work in it, and a later quiet turn is the
	 * silence the nudge was built for.
	 */
	private hasCalledAnyTool = false;
	/**
	 * Consecutive turns that produced no tool call, whatever answered them.
	 *
	 * Counted separately from the nudges above because the two ask different
	 * questions: that one is "how many times have we asked", this one is "how
	 * long has this run gone without doing anything". Reset at the same place,
	 * by the same event -- a turn that calls tools.
	 */
	private consecutiveNoToolCallTurns = 0;
	/** Reasoning characters accumulated over the current silent streak. */
	private noToolCallStreakReasoningChars = 0;
	/** Whether the run has spent its one non-convergence nudge. */
	private nonConvergenceNudgeSpent = false;
	/**
	 * The unreadable call the run was last nudged about, as a fingerprint of
	 * its text. The nudge is asked again for a call that differs from it and
	 * not for the same one: a model that writes the identical block after
	 * being told it could not be read will write it a third time, and a model
	 * that wrote a different call has moved on and broken something else.
	 *
	 * It was once per run. Measured (2026-10-11, harness run 0429): a call
	 * missing a comma, then a different call with a garbled tail one turn
	 * later, and the run ended 236 seconds in with the stub as its answer and
	 * the file untouched.
	 */
	private lastNudgedUnreadableCall: string | undefined;
	/**
	 * Whether the one intent-specific nudge has been used.
	 *
	 * Not a consecutive counter like the one above, and not reset by a turn
	 * that calls tools: this is the last word before a run that keeps
	 * announcing is allowed to end, and it is worth exactly once.
	 */
	private intentNudgeSpent = false;
	/**
	 * The self-repetition nudger, built on first use because `this.config` is
	 * not assigned yet when field initialisers run. It stays `undefined` when
	 * the host turned the guard off.
	 */
	private repetitionNudger: RepetitionNudger | undefined;
	private repetitionNudgerBuilt = false;
	/**
	 * What the nudger said about a turn, kept because the reasoning it read
	 * is replaced before the turn is recorded (see `replaceSpoiledContent`).
	 * Asking it twice would also spend its ration twice.
	 */
	private readonly repetitionNudges = new WeakMap<
		AgentMessage,
		{ nudge: string | undefined }
	>();
	/** The unreadable call a turn's text held before it was replaced. */
	private readonly unreadableCalls = new WeakMap<
		AgentMessage,
		UnparsedToolCall
	>();
	/** That call's fingerprint, taken from the text before it was replaced. */
	private readonly unreadableCallFingerprints = new WeakMap<
		AgentMessage,
		string
	>();
	/**
	 * A message arrived mid-run and the model has not been asked to resume yet.
	 *
	 * Cleared as soon as the resume nudge is sent, so an interjection costs one
	 * extra turn at most and a model that means to stop still can.
	 */
	private steerAwaitingResume = false;
	/** Consecutive turns cut off at the output cap; reset by any turn that completes. */
	private consecutiveMaxTokensRetries = 0;
	/**
	 * Consecutive turns whose tool call the provider could not parse; reset by
	 * any turn that reaches the tool-call stage, malformed or not.
	 */
	private toolCallParseRetries = 0;
	/** Thinking-only turns taken again, in a row; see `THINKING_ONLY_REMINDER`. */
	private thinkingOnlyRetries = 0;
	/**
	 * The cap that truncated the last turn, when the cap was the request's own.
	 *
	 * Kept so the retry can ask for less. Unset when the window was what
	 * truncated the turn: that cap is the room the prompt left, compaction is
	 * about to change it, and halving it would take away room the retry needs.
	 */
	private truncatedOutputCapTokens: number | undefined;
	private initialization?: Promise<void>;
	private abortController?: AbortController;
	/**
	 * Turns cut in a row because the reasoning channel collapsed. Cutting the
	 * request stops one degenerate draw; this bounds a model that redraws the
	 * same collapse every turn. Reset by any turn that streams cleanly.
	 */
	private reasoningLoopStreak = 0;
	/**
	 * What to tell the model about a call this runtime cut for an overlong
	 * `intent`, held until the one place a user message may follow the turn:
	 * at once when the turn called nothing else, after the tool results when
	 * it did.
	 */
	private pendingToolIntentNudge?: string;
	/** The request the turn in hand was made with (`continueConversation`). */
	private lastIssuedRequest?: AgentModelRequest;
	/** Requests in a row this runtime cut for an overlong `intent`. */
	private toolIntentCutStreak = 0;
	private modelSteerController?: AbortController;
	private readonly telemetryProviderId?: string;
	private readonly telemetryModelId?: string;

	constructor(config: AgentRuntimeConfig) {
		this.telemetryProviderId =
			trimNonEmpty(config.messageModelInfo?.provider) ??
			("providerId" in config ? trimNonEmpty(config.providerId) : undefined);
		this.telemetryModelId =
			trimNonEmpty(config.messageModelInfo?.id) ??
			("modelId" in config ? trimNonEmpty(config.modelId) : undefined);
		const resolved = resolveRuntimeConfig(config);
		const parallelToolCallBound = resolveParallelToolCallBound(resolved);
		this.config = {
			...resolved,
			// Derived from the bound rather than carried beside it, so the two
			// fields cannot end up saying different things.
			toolExecution: parallelToolCallBound > 1 ? "parallel" : "sequential",
			maxParallelToolCalls: parallelToolCallBound,
		};
		this.state.agentId = resolved.agentId ?? createUID("agent");
		this.state.agentRole = resolved.agentRole;
		this.state.parentAgentId = resolved.parentAgentId;
		this.state.messages = cloneMessages(resolved.initialMessages ?? []);
	}

	async run(input: AgentRunInput): Promise<AgentRunResult> {
		return this.execute(input);
	}

	async continue(input?: AgentRunInput): Promise<AgentRunResult> {
		return this.execute(input);
	}

	/** Interrupt only the current model request; running tools finish normally. */
	notifyPendingUserMessage(): void {
		this.modelSteerController?.abort();
	}

	abort(reason?: unknown): void {
		if (!this.abortController) {
			return;
		}
		if (this.abortController.signal.aborted) {
			return;
		}
		const abortError =
			reason instanceof AgentRuntimeAbortError
				? reason
				: new AgentRuntimeAbortError(reason);
		this.state.lastError = abortError.message;
		this.captureTaskLifecycle(TASK_CANCELLED_EVENT, {
			error: abortError,
		});
		this.abortController.abort(abortError);
	}

	subscribe(listener: AgentEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Replace the conversation with a fresh set of messages, discarding any
	 * in-flight run and usage state while preserving the underlying model,
	 * tools, hooks, plugins, and active event subscribers.
	 *
	 * Useful for standalone callers that persist conversations externally and
	 * want to re-seed the runtime from storage without recreating subscribers.
	 */
	restore(messages: readonly AgentMessage[]): void {
		this.abort("Agent state restored");
		// Reset state that is not carried across restores. Keep `listeners`,
		// tools, hooks, plugins, model, and agent identity so external event
		// subscribers continue to receive events after restore().
		this.state.runId = undefined;
		this.state.status = "idle";
		this.state.iteration = 0;
		this.state.pendingToolCalls = [];
		this.state.usage = cloneUsage(DEFAULT_USAGE);
		this.state.lastError = undefined;
		this.state.lastErrorClass = undefined;
		this.state.lastErrorRetryable = undefined;
		this.state.lastErrorReported = false;
		this.state.messages = cloneMessages(messages);
		this.config = {
			...this.config,
			initialMessages: cloneMessages(messages),
		};
	}

	/**
	 * The run's state as an event carries it.
	 *
	 * `messages` is deep-copied when somebody reads it, not when the snapshot is
	 * made. Every emitted event carries a snapshot and a delta event arrives per
	 * token, so cloning the transcript here meant copying the whole conversation
	 * -- every message, every content part -- thousands of times a turn, for a
	 * field the delta events' consumers never read. Only `message-added` and
	 * `assistant-message` read it, and those arrive once each.
	 *
	 * Measured in a user's extension log: 165,195 events in one window against a
	 * conversation of 554,681 characters. The work is quadratic in the same
	 * shape as the `accumulated` string that used to be logged per delta, and it
	 * lands on the extension host's only thread -- which is where a Cline panel
	 * that has gone blank while the task keeps running is looked for.
	 *
	 * The array is copied eagerly, so a message appended after the event was
	 * emitted cannot appear in a clone taken later; the messages already in it
	 * are never mutated in place, so their copy can wait for a reader.
	 */
	snapshot(): AgentRuntimeStateSnapshot {
		const messages = [...this.state.messages];
		let cloned: AgentMessage[] | undefined;
		return {
			agentId: this.state.agentId,
			agentRole: this.state.agentRole,
			parentAgentId: this.state.parentAgentId,
			conversationId: this.config.conversationId?.trim() || undefined,
			runId: this.state.runId,
			status: this.state.status,
			iteration: this.state.iteration,
			get messages(): AgentMessage[] {
				cloned ??= cloneMessages(messages);
				return cloned;
			},
			pendingToolCalls: [...this.state.pendingToolCalls],
			usage: cloneUsage(this.state.usage),
			lastError: this.state.lastError,
			lastErrorClass: this.state.lastErrorClass,
		};
	}

	private async ensureInitialized(): Promise<void> {
		this.initialization ??= this.initialize();
		await this.initialization;
	}

	private async initialize(): Promise<void> {
		this.registerHooks(this.config.hooks);
		for (const tool of this.config.tools ?? []) {
			this.tools.set(tool.name, tool);
		}
		for (const plugin of this.config.plugins ?? []) {
			const setup = await plugin.setup?.({
				agentId: this.state.agentId,
				agentRole: this.state.agentRole,
				systemPrompt: this.config.systemPrompt,
			});
			for (const tool of setup?.tools ?? []) {
				this.tools.set(tool.name, tool);
			}
			this.registerHooks(setup?.hooks);
		}
	}

	private registerHooks(hooks: Partial<AgentRuntimeHooks> | undefined): void {
		if (!hooks) {
			return;
		}
		if (hooks.beforeRun) this.hooks.beforeRun.push(hooks.beforeRun);
		if (hooks.afterRun) this.hooks.afterRun.push(hooks.afterRun);
		if (hooks.beforeModel) this.hooks.beforeModel.push(hooks.beforeModel);
		if (hooks.afterModel) this.hooks.afterModel.push(hooks.afterModel);
		if (hooks.beforeTool) this.hooks.beforeTool.push(hooks.beforeTool);
		if (hooks.afterTool) this.hooks.afterTool.push(hooks.afterTool);
		if (hooks.onEvent) this.hooks.onEvent.push(hooks.onEvent);
	}

	private getRequiredCompletionToolNames(): string[] {
		if (this.config.completionPolicy?.requireCompletionTool !== true) {
			return [];
		}
		return [...this.tools.values()]
			.filter((tool) => tool.lifecycle?.completesRun === true)
			.map((tool) => tool.name)
			.sort();
	}

	private getCompletionToolReminderMessage(): string | undefined {
		const terminalToolNames = this.getRequiredCompletionToolNames();
		if (terminalToolNames.length === 0) {
			return undefined;
		}
		return `[SYSTEM] This run is not complete until you call one of these terminal completion tools: ${terminalToolNames.join(
			", ",
		)}. Continue working if requirements are not met. If the task is complete, call the appropriate terminal completion tool now.`;
	}

	/**
	 * Ask the host's boundary hook whether this run may end.
	 *
	 * Kept apart from `getCompletionReminderMessages` because it is a different
	 * kind of question and is allowed to take time over it: the reminders are
	 * strings a host computed in advance, while this may run a command before it
	 * answers. Both ways a run can end come through here.
	 */
	private async runCompletionBoundary(
		text: string,
		forced = false,
	): Promise<string | undefined> {
		const hook = this.config.completionPolicy?.onCompletionAttempt;
		if (!hook) {
			return undefined;
		}
		const message = await hook({ text: text || undefined, forced });
		return message && message.length > 0 ? message : undefined;
	}

	/**
	 * The completion-tool reminder and the host's guard, and whether the guard
	 * spoke: it names open work itself, so the general nudge stands down for
	 * it (see `getNoToolCallNudgeMessage`).
	 */
	private getCompletionReminderMessages(): {
		messages: string[];
		guardAsked: boolean;
	} {
		const guard = this.config.completionPolicy?.completionGuard?.();
		return {
			messages: [this.getCompletionToolReminderMessage(), guard].filter(
				(message): message is string => Boolean(message),
			),
			guardAsked: Boolean(guard),
		};
	}

	/**
	 * The nudge for a turn that produced no tool calls, or undefined once the
	 * consecutive limit is reached and the run should be allowed to end.
	 */
	private async getNoToolCallNudgeMessage(
		text?: string,
		guardAsked = false,
		/** The unreadable call this turn held, when its text has been replaced. */
		unreadable?: UnparsedToolCall,
	): Promise<string | undefined> {
		const budget = this.config.completionPolicy?.maxNoToolCallNudges ?? 0;
		if (this.consecutiveNoToolCallNudges >= budget) {
			return undefined;
		}
		// A provider that could not read a tool call hands the block back as
		// content, so the turn arrives here looking exactly like a model that
		// called nothing. It is not, and the generic message is false in the one
		// way most likely to make it repeat itself: it tried to act.
		const unparsed = unreadable ?? unparsedToolCallInText(text);
		if (unparsed) {
			return buildUnparsedToolCallNudge(unparsed);
		}
		// What the host knows and this message did not say. "You called nothing"
		// is true of a model that has not started as well as of one that has
		// finished, and the two need different things said to them; the host is
		// the only thing here that can tell them apart.
		const unstarted =
			await this.config.completionPolicy?.describeUnstartedWork?.();
		// The host's guard is asking on this same turn, by name: "these items
		// are still unticked; tick them with a tool call, or do them now". The
		// general nudge asks the same question with a different answer ("if the
		// task really is finished, say so in one short sentence"), and a model
		// given both took the second: session xkuuh (pandorum, 2026-10-10)
		// replied "The task is finished." with the box still unticked and was
		// asked about the checklist again. One question, from whoever knows
		// what is open. Not counted against the budget: nothing was asked here.
		if (guardAsked && !unstarted) {
			return undefined;
		}
		// Asked once already, worked since, and this is the one short sentence
		// the question asked for. Only after tool calls: back-to-back silent
		// turns keep the budget they always had. The host naming unstarted
		// work still outranks it.
		if (
			this.noToolCallNudgeAsked &&
			this.consecutiveNoToolCallNudges === 0 &&
			!unstarted &&
			answersCompletionNudge(text)
		) {
			return undefined;
		}
		// Worked, then reported: that is how a run ends. Two cases only -- the
		// reply says the work is complete, or the last tool to run said it
		// stopped at something only the user can change and the reply reports
		// that (see `stoppedForUserBy` for how long that holds). A prose status with work still to do is neither, and is asked
		// as before. Not after a nudge already sent: the answer to that one is
		// judged above.
		if (
			this.calledToolThisRun &&
			this.consecutiveNoToolCallNudges === 0 &&
			!this.noToolCallNudgeAsked &&
			!unstarted &&
			(claimsCompletion(text) ||
				(this.stoppedForUserBy !== undefined && reportsOutcome(text)))
		) {
			return undefined;
		}
		// A turn that called nothing is not automatically a turn that failed to
		// act. Asked which capital belongs to which country, or talked through a
		// design, a model answers and stops -- and every branch of the message
		// below presupposes a *task*: it says the run "was about to end", and
		// tells the model not to describe what it is going to do without doing
		// it. Sent to a conversational reply that is the wrong description of
		// what happened, it costs a turn, and it pushes toward calling something
		// to avoid being asked again, which is the failure it exists to prevent
		// arriving from the other side.
		//
		// So the nudge needs evidence of unfinished work, and there are three
		// kinds. The host may know of some (`unstarted`). The run may already
		// have acted, which makes it a task in progress -- a model that called
		// tools and then went quiet is the original case this was built for.
		// Or the turn may end on a promise rather than an answer, which is the
		// first-turn "I'll use multiple editor calls... Step 1... Step 2." that
		// stops without starting; `announcedIntentWithoutActing` is the same
		// narrow test the second nudge uses, and it stands down for any message
		// claiming completion.
		//
		// With none of the three, the turn is an answer and the run may end --
		// unless strong nudges are on, which is the default and says to ask
		// anyway. A coding session wants the aggressive reading: there, a turn
		// that called nothing is nearly always one that should have acted, and
		// a needless nudge costs one turn while a missed one costs the task.
		// A session that is mostly conversation wants the opposite, and only
		// the person running it knows which they are in.
		if (
			this.config.completionPolicy?.strongNudges === false &&
			!unstarted &&
			!this.hasCalledAnyTool &&
			!announcedIntentWithoutActing(text)
		) {
			return undefined;
		}
		// Only where the model actually has the tool. Gated on the registry
		// rather than on config so it cannot drift from what was sent.
		const base = this.tools.has("ask_question")
			? NO_TOOL_CALL_NUDGE_MESSAGE + ASK_QUESTION_NUDGE_CLAUSE
			: NO_TOOL_CALL_NUDGE_MESSAGE;
		return unstarted ? base + unstarted : base;
	}

	/**
	 * The nudge for a turn whose reasoning re-derives what it already concluded,
	 * or nothing.
	 *
	 * On unless the host passes `reasoningRepetition: false`, matching the
	 * streaming guard rather than the silence budget: this one never ends a turn
	 * and never cuts a draw, it appends one paragraph, and across 3,229 recorded
	 * blocks from 21 model families it fires on 1.2% of them.
	 *
	 * Deliberately not gated on `nudgesEnabled` here. That gate answers "does a
	 * silent turn end the run", which is a different question -- the silent path
	 * applies it at the call site, and the tool-calling path, where the run
	 * continues either way, does not.
	 */
	private repetitionNudgeFor(
		message: AgentMessage | undefined,
	): string | undefined {
		if (!this.repetitionNudgerBuilt) {
			this.repetitionNudgerBuilt = true;
			const setting = this.config.reasoningRepetition;
			this.repetitionNudger =
				setting === false
					? undefined
					: createRepetitionNudger({
							...DEFAULT_REASONING_REPETITION,
							...setting,
						});
		}
		if (!message) {
			return undefined;
		}
		const known = this.repetitionNudges.get(message);
		if (known) {
			return known.nudge;
		}
		const reasoning = reasoningTextInMessage(message);
		const nudge = reasoning
			? this.repetitionNudger?.inspect(reasoning, this.state.iteration)
			: undefined;
		this.repetitionNudges.set(message, { nudge });
		return nudge;
	}

	/**
	 * Take out of a turn what must not be read back: reasoning that collapsed
	 * into repetition, and a tool call nothing could parse.
	 *
	 * Both were left in the transcript, and both are the largest thing in the
	 * next request. Measured on pandorum (2026-10-10, v9-agentic): four looped
	 * turns kept 44,000 to 90,000 characters of one passage repeated, and the
	 * request after each carried all of it; an unreadable call was copied by
	 * the next turn 9 times in 21, and one of them pushed the request past the
	 * window into two refusals and a compaction that kept it.
	 *
	 * Replaced here, before the turn is recorded, so that no request, no
	 * compaction and no stored session ever holds the original. The nudges
	 * that answer the turn are worked out first -- they quote what is about to
	 * go -- and the message is marked so compaction can leave a turn like this
	 * out of what it keeps (see `spoiledTurn` in core's compaction).
	 */
	private replaceSpoiledContent(message: AgentMessage): void {
		if (message.role !== "assistant") {
			return;
		}
		const spoiled: { kinds: string[]; removedChars: number } = {
			kinds: [],
			removedChars: 0,
		};
		const content = [...message.content];
		const reasoning = reasoningTextInMessage(message);
		if (reasoning) {
			// Asked now, while the reasoning is still there to be measured.
			this.repetitionNudgeFor(message);
			const verdict = (
				message.metadata as { reasoningLoop?: ReasoningLoopVerdict } | undefined
			)?.reasoningLoop;
			const setting = this.config.reasoningRepetition;
			const config = { ...DEFAULT_REASONING_REPETITION, ...(setting || {}) };
			const measurement =
				setting === false
					? undefined
					: measureReasoningRepetition(reasoning, config);
			const why = verdict
				? "it collapsed into repeating itself and was cut"
				: measurement && isRepetitionLoop(measurement, config)
					? `it repeated one passage ${measurement.maxRepeat} times`
					: undefined;
			if (why) {
				const note = `[SYSTEM] The reasoning of this turn was removed: ${why}. Only what the turn did is kept.`;
				const first = content.findIndex((part) => part.type === "reasoning");
				const kept: AgentMessagePart[] = content.filter(
					(part) => part.type !== "reasoning",
				);
				kept.splice(Math.max(0, first), 0, {
					type: "reasoning",
					text: note,
				} as AgentMessagePart);
				content.splice(0, content.length, ...kept);
				spoiled.kinds.push("reasoning_loop");
				spoiled.removedChars += reasoning.length;
				this.config.logger?.debug?.(
					`[reasoning-loop] iter=${this.state.iteration} removed: ${
						verdict
							? `${reasoning.length} chars; cut while streaming (${verdict.kind}${verdict.cycles !== undefined ? `, ${verdict.cycles} cycles` : ""}); unit: ${JSON.stringify(verdict.sample.slice(0, 400))}`
							: measurement
								? describeRepetitionForLog(reasoning, measurement)
								: `${reasoning.length} chars`
					}`,
				);
			}
		}
		const calledSomething = content.some((part) => part.type === "tool-call");
		const text = textFromMessage(message);
		const unreadable = calledSomething
			? undefined
			: unparsedToolCallInText(text);
		if (unreadable) {
			this.unreadableCalls.set(message, unreadable);
			this.unreadableCallFingerprints.set(
				message,
				fingerprintUnreadableCall(text),
			);
			const first = content.findIndex((part) => part.type === "text");
			const kept: AgentMessagePart[] = content.filter(
				(part) => part.type !== "text",
			);
			kept.splice(first < 0 ? kept.length : Math.min(first, kept.length), 0, {
				type: "text",
				text: describeUnreadableToolCallStub(unreadable),
			} as AgentMessagePart);
			content.splice(0, content.length, ...kept);
			spoiled.kinds.push("unreadable_tool_call");
			spoiled.removedChars += text.length;
			// How it began and how it ended. The text is not kept anywhere
			// else, and "14901 chars removed" cannot say whether the call ran
			// on inside one argument or was cut short of its closing mark
			// (pandorum, 2026-10-12: two in a row, 4m32s and 2m39s of
			// generation, and nothing to tell them apart by).
			const flat = (part: string) => part.replace(/\s+/g, " ");
			this.config.logger?.debug?.(
				`[unreadable-call] iter=${this.state.iteration} ${text.length} chars; begins: ${flat(text.slice(0, 400))}${
					text.length > 700 ? ` ...; ends: ${flat(text.slice(-300))}` : ""
				}`,
			);
		}
		if (spoiled.kinds.length === 0) {
			return;
		}
		this.config.logger?.debug?.(
			`Replaced spoiled content in an assistant turn (${spoiled.kinds.join(", ")}): ${spoiled.removedChars} chars removed`,
		);
		const mutable = message as {
			content: AgentMessagePart[];
			metadata?: Record<string, unknown>;
		};
		mutable.content = content;
		mutable.metadata = { ...(message.metadata ?? {}), spoiledTurn: spoiled };
	}

	/** Whether this host asks a silent turn to continue at all. */
	private nudgesEnabled(): boolean {
		return (this.config.completionPolicy?.maxNoToolCallNudges ?? 0) > 0;
	}

	/**
	 * Whether the run has gone long enough without acting to be told so.
	 *
	 * Gated on `nudgesEnabled` like every other extension of the nudge policy:
	 * a host that set the budget to zero has said a silent turn ends the run,
	 * and this must not be a second door into the same room. Once per run, and
	 * only while the run could still act on being told.
	 */
	private shouldNudgeNonConvergence(): boolean {
		if (this.nonConvergenceNudgeSpent || !this.nudgesEnabled()) {
			return false;
		}
		const limit =
			this.config.completionPolicy?.noToolCallTurnStreakLimit ??
			DEFAULT_NO_TOOL_CALL_TURN_STREAK_LIMIT;
		return limit > 0 && this.consecutiveNoToolCallTurns >= limit;
	}

	/**
	 * Retries allowed for turns truncated at the output cap.
	 *
	 * Defaulted on rather than opted into, unlike the no-tool-call nudge: a
	 * nudge asks a model that has finished to keep going, which is a policy
	 * question, while this recovers a turn the model never got to finish. A
	 * host that wants the old behaviour sets it to zero.
	 */
	/**
	 * Whether the turn generated anything at all, whatever became of it.
	 *
	 * The difference between a model that reasoned itself out of room and a
	 * provider handing back empty responses as fast as it can. The first is worth
	 * another turn; the second would spin, and is left to fail as it did before.
	 */
	private turnProducedOutputTokens(before: AgentUsage): boolean {
		return this.state.usage.outputTokens > before.outputTokens;
	}

	/**
	 * Condense a truncated turn's reasoning, if the host asked to be given the
	 * chance, and never at the cost of the retry it exists to help.
	 *
	 * A condenser that throws, or that has nothing to say, leaves the discard
	 * exactly as it was.
	 */
	/**
	 * What the last request left free in the window, as far as can be vouched
	 * for: the window its cap was resolved against, less what the provider
	 * counted for it and the reserve a cap is given. Where no window was
	 * reported, the cap itself is the floor -- it is never more than the
	 * window less the input it was computed against.
	 */
	private continuationRoomTokens(): number | undefined {
		const input = this.state.lastRequestInputTokens;
		const cap = lastOutputCap(this.config.sessionId);
		if (!(input > 0) || !cap) {
			return undefined;
		}
		if (cap.contextWindow !== undefined) {
			return Math.max(
				0,
				cap.contextWindow - input - CONTINUATION_WINDOW_RESERVE_TOKENS,
			);
		}
		if (!cap.maxTokens) {
			return undefined;
		}
		const floor =
			Math.max(input, cap.estimatedInputTokens ?? 0) + cap.maxTokens;
		return Math.max(0, floor - input);
	}

	/**
	 * One more turn of the conversation that is not kept: the last request as
	 * it was issued, one user message after it, prose only. See
	 * `DiscardedTurnInput.continueConversation`.
	 */
	private async continueConversation(
		request: AgentModelRequest,
		ask: { instruction: string; maxTokens: number },
	): Promise<{ text: string }> {
		const stream = await this.config.model.stream({
			...request,
			messages: [
				...request.messages,
				createMessage("user", [{ type: "text", text: ask.instruction }], {
					displayRole: "system",
				}),
			],
			...(this.abortController ? { signal: this.abortController.signal } : {}),
			options: {
				...request.options,
				maxTokens: ask.maxTokens,
				toolChoice: "none",
			},
		});
		let text = "";
		for await (const event of stream) {
			if (event.type === "text-delta") {
				text += event.text;
			} else if (event.type === "usage") {
				// The agent's spend, like any turn's. Not its last request's
				// size: that stays the conversation's own.
				this.state.usage.inputTokens += event.usage.inputTokens ?? 0;
				this.state.usage.outputTokens += event.usage.outputTokens ?? 0;
			} else if (event.type === "finish" && event.reason === "error") {
				throw new Error(event.error ?? "the model call failed");
			}
		}
		return { text: text.trim() };
	}

	/** Whether the host's `recoverTurnFault` is the one to wait this fault out. */
	private recoversTurnFault(kind: "refusal" | "transport"): boolean {
		if (!this.config.recoverTurnFault) {
			return false;
		}
		const kinds = this.config.recoverTurnFaultKinds;
		return kinds === undefined || kinds.includes(kind);
	}

	private async noteDiscardedReasoning(
		message: AgentMessage,
		windowBound: boolean,
	): Promise<{ note?: string; retrospective?: string } | undefined> {
		const condense = this.config.condenseDiscardedReasoning;
		if (!condense) {
			this.config.logger?.debug?.(
				"Discarded turn not condensed: no condenser is installed",
			);
			return undefined;
		}
		const reasoning = message.content
			.filter(
				(part: AgentMessagePart): part is AgentMessagePart & { text: string } =>
					part.type === "reasoning" &&
					typeof (part as { text?: unknown }).text === "string",
			)
			.map((part) => part.text)
			.join("")
			.trim();
		// The reply as far as it got. It was on its way to the bin with the
		// reasoning, and it states what the turn had decided more plainly than the
		// reasoning does. (There is never a tool call to collect here: this path
		// runs only for a truncated turn that produced none.)
		const text = message.content
			.filter(
				(part: AgentMessagePart): part is AgentMessagePart & { text: string } =>
					part.type === "text" &&
					typeof (part as { text?: unknown }).text === "string",
			)
			.map((part) => part.text)
			.join("")
			.trim();
		// Said on every discarded turn, not only the ones that decline. A turn
		// that hits the cap and produces no note is indistinguishable, from the
		// outside, from a condenser that was never wired -- and for four sessions
		// that is exactly how it read: `outputLimitRetries=1, notes=0`, no note in
		// the reminder, and nothing in the log at all. The gap that settled it was
		// nine milliseconds between the capped turn and the retry's request, which
		// is far too little for the summariser round trip the note requires. What
		// the discarded message was carrying is the one fact the transcript can
		// never supply, because that message is the one thing that never enters it.
		this.config.logger?.log?.(
			`Discarded a turn cut off at the output limit: parts=[${
				message.content.map((part) => part.type).join(", ") || "none"
			}] reasoning=${reasoning.length} chars partialReply=${text.length} chars windowBound=${windowBound}`,
			{ severity: "info" },
		);
		if (!reasoning && !text) {
			// Said, because the alternative is what this path has been doing:
			// declining in silence, which reads exactly like a condenser that was
			// never wired. Measured across four sessions -- six discarded turns,
			// not one note -- and the transcript cannot say why, since the
			// discarded message is the one thing that never enters it. The part
			// types are what settles it.
			this.config.logger?.log?.(
				`Discarded turn had nothing to condense: parts=[${
					message.content.map((part) => part.type).join(", ") || "none"
				}] contentLength=${message.content.length}`,
				{ severity: "warn" },
			);
			return undefined;
		}
		try {
			const continued = this.lastIssuedRequest;
			const room = this.continuationRoomTokens();
			const condensation = await condense({
				reasoning,
				...(text ? { text } : {}),
				windowBound,
				...(continued
					? {
							continueConversation: (ask) =>
								this.continueConversation(continued, ask),
						}
					: {}),
				...(room !== undefined ? { continuationRoomTokens: room } : {}),
			});
			const note = condensation?.note?.trim();
			const retrospective = condensation?.retrospective?.trim();
			if (!note && !retrospective) {
				this.config.logger?.log?.(
					`Discarded turn was not condensed: the condenser returned nothing for ${reasoning.length} chars of reasoning and ${text.length} chars of partial reply`,
					{ severity: "warn" },
				);
				return undefined;
			}
			this.config.logger?.log?.(
				`Condensed ${reasoning.length} chars of discarded reasoning into a ${
					note?.length ?? 0
				}-char note and a ${retrospective?.length ?? 0}-char retrospective for the retry`,
				{
					severity: "info",
					reasoningChars: reasoning.length,
					noteChars: note?.length ?? 0,
					retrospectiveChars: retrospective?.length ?? 0,
				},
			);
			return {
				...(note ? { note } : {}),
				...(retrospective ? { retrospective } : {}),
			};
		} catch (error) {
			this.config.logger?.log?.(
				"Could not condense the discarded reasoning; retrying without a note",
				{
					severity: "warn",
					errorMessage: error instanceof Error ? error.message : String(error),
				},
			);
			return undefined;
		}
	}

	/**
	 * What the retry after a truncated turn is allowed to spend.
	 *
	 * A turn that just spent its whole cap without producing a tool call gets
	 * less on the retry, halving with each consecutive failure. Handing back the
	 * same cap invites the same turn, and the same wait: measured on one run,
	 * four turns ended at exactly 32,000 output tokens -- 6m15s, 5m13s, 5m39s,
	 * 5m30s -- for 22m37s of a 31m43s session generated and thrown away, none of
	 * it window-bound (input ran 29,527 to 53,842 against a 110,000 window).
	 *
	 * It also asks for what the reminder asks for. "One tool call, or one short
	 * paragraph" does not need 32,000 tokens, and the turns that recovered on
	 * that same run did it in 5,568, 3,082 and 2,852 -- so the floor here is
	 * still comfortably above the largest turn that ever succeeded after one of
	 * these, and a relapse costs about a minute instead of six.
	 *
	 * Returns `undefined` when nothing should change: no truncation to answer
	 * for, or one the window caused, where the cap is the room the prompt left
	 * rather than a budget the model overran.
	 */
	private getRetryOutputCap(): number | undefined {
		if (
			this.consecutiveMaxTokensRetries < 1 ||
			this.truncatedOutputCapTokens === undefined
		) {
			return undefined;
		}
		const halved = Math.floor(
			this.truncatedOutputCapTokens / 2 ** this.consecutiveMaxTokensRetries,
		);
		return Math.max(RETRY_OUTPUT_CAP_FLOOR_TOKENS, halved);
	}

	private getMaxTokensRetryBudget(): number {
		const configured = this.config.completionPolicy?.maxTruncatedTurnRetries;
		return typeof configured === "number" && Number.isFinite(configured)
			? Math.max(0, Math.floor(configured))
			: DEFAULT_MAX_TOKENS_TURN_RETRIES;
	}

	private async addUserReminderMessage(
		text: string,
		/**
		 * Facts the display layer has to rebuild this reminder's row from.
		 *
		 * A status notice is an event, and events are not persisted: a reopened
		 * task is rebuilt from the messages alone. Anything a row needs after
		 * the run has to ride on the message, and this is the only message a
		 * discarded turn leaves behind.
		 */
		noticeMetadata?: Record<string, unknown>,
	): Promise<AgentMessage> {
		// Every reminder this runtime appends is model-facing: the no-tool-call
		// nudge, the announced-intent and unparsed-call nudges, the
		// non-convergence and repetition nudges, the completion boundary, the
		// check-what-you-edited reminder. None of them is anything the user
		// typed.
		//
		// `displayRole: "system"` is what says so, and it was missing here while
		// the hook-context injection below has always carried it. Live these
		// never rendered, because nothing emits them as visible content; on a
		// *resumed* conversation the transcript is rebuilt from stored messages
		// and each one came back as a blue user bubble. Reported as "I only see
		// system messages and nudges when I reopen the conversation" -- they
		// were never meant to be seen at either end.
		//
		// The display layer also matches these by text, but that list cannot
		// hold: reminders are joined into one message when a turn earns more
		// than one, and the joined text equals no constant and starts with no
		// prefix. The stamp does not care how many were joined.
		const reminderMessage = createMessage("user", [{ type: "text", text }], {
			userRunSpan: 0,
			displayRole: "system",
			...(noticeMetadata ?? {}),
		});
		this.state.messages.push(reminderMessage);
		await this.emit({
			type: "message-added",
			snapshot: this.snapshot(),
			message: reminderMessage,
		});
		return reminderMessage;
	}

	private async execute(input?: AgentRunInput): Promise<AgentRunResult> {
		await this.ensureInitialized();
		if (this.state.status === "running") {
			throw new Error("Agent runtime is already running");
		}

		this.abortController = new AbortController();
		this.state.runId = createUID("run");
		this.state.status = "running";
		this.state.iteration = 0;
		this.state.pendingToolCalls = [];
		this.state.lastError = undefined;
		this.state.lastErrorClass = undefined;
		this.state.lastErrorRetryable = undefined;
		this.state.lastErrorReported = false;
		this.state.lastFinishReason = undefined;
		this.state.usage = cloneUsage(DEFAULT_USAGE);
		this.overflowRecoveryAttempted = false;
		this.compactBeforeNextTurn = false;
		this.imageRecoveryAttempted = false;
		this.steerAwaitingResume = false;
		this.noToolCallNudgeAsked = false;
		this.calledToolThisRun = false;
		this.stoppedForUserBy = undefined;
		this.state.lastRequestInputTokens = 0;
		this.pendingHookContexts = [];

		try {
			await this.callBeforeRunHooks();
			await this.emit({ type: "run-started", snapshot: this.snapshot() });

			for (const message of input ? normalizeInput(input) : []) {
				this.state.messages.push(message);
				await this.emit({
					type: "message-added",
					snapshot: this.snapshot(),
					message,
				});
			}

			const completionToolReminder = this.getCompletionToolReminderMessage();
			if (completionToolReminder) {
				await this.addUserReminderMessage(completionToolReminder);
			}

			// Context collected by beforeRun hooks lands after the run's input
			// messages so the model sees it on the first request of the run.
			await this.flushPendingHookContexts();

			let finalAssistantMessage: AgentMessage | undefined;

			while (
				this.config.maxIterations === undefined ||
				this.state.iteration < this.config.maxIterations
			) {
				this.throwIfAborted();

				this.state.iteration += 1;
				this.trace(`turn-begin iter=${this.state.iteration}`);
				await this.emit({
					type: "turn-started",
					snapshot: this.snapshot(),
					iteration: this.state.iteration,
				});

				const usageBeforeTurn = cloneUsage(this.state.usage);
				// A fresh error slate per turn: nothing from a previous turn may leak
				// into this turn's error classification or retry decision.
				this.resetLastError();
				const { message, finishReason, interrupted } =
					await this.generateAssistantMessageWithProviderRetry();
				if (interrupted && message.content.length === 0) {
					await this.emit({
						type: "turn-finished",
						snapshot: this.snapshot(),
						iteration: this.state.iteration,
						toolCallCount: 0,
					});
					continue;
				}
				if (finishReason === "aborted") {
					throw this.normalizeAbortError();
				}
				if (message.content.length === 0) {
					// A turn that spent tokens and delivered nothing is a wasted
					// turn, not a failed run — the same situation as one cut off at
					// the output cap, and it gets the same retry.
					//
					// Measured on a 1h19m session: the prompt estimate ran 8.2% low
					// (95,115 against a real 103,591), so the output cap was sized
					// from room that was not there. The model reasoned for 6,489
					// tokens, hit the true end of the 110,000-token window inside an
					// unterminated thinking block, and the parser — with no closing
					// marker — emitted nothing at all. Not an error: the stream
					// finished normally, with an empty message. The run died there,
					// on a turn the model could simply have taken again.
					if (
						finishReason !== "error" &&
						// A filtered turn reproduces every time; it falls through
						// to its own message below.
						finishReason !== "content-filter" &&
						this.turnProducedOutputTokens(usageBeforeTurn) &&
						this.consecutiveMaxTokensRetries < this.getMaxTokensRetryBudget()
					) {
						this.consecutiveMaxTokensRetries += 1;
						await this.emit({
							type: "status-notice",
							snapshot: this.snapshot(),
							message: "the model produced nothing usable — retrying",
							metadata: {
								kind: "empty_turn_recovery",
								reason: "empty_turn_recovery",
								phase: "started",
								iteration: this.state.iteration,
								attempt: this.consecutiveMaxTokensRetries,
								finishReason,
							},
						});
						await this.addUserReminderMessage(EMPTY_TURN_REMINDER);
						continue;
					}
					// The other way a malformed call arrives: the parser refused it
					// and emitted nothing at all, so there is no text to sit above
					// the failure. Same recovery, and it has to be tried here too —
					// the branch above declines every `error` turn, which is the
					// whole class this one belongs to.
					if (await this.recoverUnparsableToolCall()) {
						continue;
					}
					// Attribution is set immediately before each throw: nothing can
					// interleave between a synchronous set-and-throw and the
					// run-level catch, so `sdk.error` can never pick up a reason
					// from a failure it did not cause. Failures with no
					// finish-reason cause (hooks, listeners, transport) leave the
					// field unset and the attribute is omitted.
					if (finishReason === "error") {
						this.state.lastFinishReason = finishReason;
						throw new Error(this.state.lastError ?? "Model stream failed");
					}
					// Provider-executed tool activity lives in message metadata, not
					// content (projecting it into content would replay tool_use blocks
					// the model never gets results for). A turn that is only such
					// activity is not empty: keep the message so the transcript and
					// display projection retain it. Replay stays safe — the codec
					// renders empty content as its placeholder text block.
					const hasModelToolActivity = this.hasModelToolActivity(message);
					// A turn that produced no content because it hit the output-token
					// limit or has an unknown finish is incomplete: preserve the message
					// so finish-reason handling below can surface the right failure or recover.
					if (
						!hasModelToolActivity &&
						finishReason !== "max-tokens" &&
						finishReason !== "unknown"
					) {
						this.state.lastFinishReason = finishReason;
						throw new Error(
							finishReason === "content-filter"
								? CONTENT_FILTER_EMPTY_TURN_MESSAGE
								: "Model returned empty response",
						);
					}
				}
				const toolCalls = message.content.filter(
					(part: AgentMessagePart): part is AgentToolCallPart =>
						part.type === "tool-call",
				);

				// A turn cut off at the output cap with nothing actionable in it is
				// a wasted turn, not a failed run. Restarting is only possible
				// *here*, before the push: the truncated message never enters the
				// history, so the retry starts from the same place the turn did
				// rather than from a half-written reply that would be resent in
				// full and eat the same budget again.
				//
				// The reminder is what makes the retry differ. Regenerating from an
				// unchanged prompt reproduces an overlong reply, so the model is
				// told what happened and asked for the smallest next step.
				// `prepareTurn` runs on the retry like any other turn, so when the
				// window is what is tight, compaction happens there.
				if (
					finishReason === "max-tokens" &&
					toolCalls.length === 0 &&
					this.consecutiveMaxTokensRetries < this.getMaxTokensRetryBudget()
				) {
					this.consecutiveMaxTokensRetries += 1;
					// Compaction only when the window is what truncated the turn.
					// Forcing it on every truncation was measured recovering a
					// 48,508-token request against a 110,000-token window: the cap that
					// ended that turn was the caller's own 32,000, which no amount of
					// compaction can raise, so the transcript was spent to leave the
					// retry facing the same ceiling with less of the work it was doing.
					// Absent a report -- a custom `AgentModel` that never went through
					// the gateway -- compaction is kept: a runtime that cannot say what
					// capped it is likelier to be near a window it never declared than
					// to be held by a limit nobody set.
					// This session's own last request. A cap another call ran into --
					// an image describer, a commit message -- says nothing about
					// whether the window is what truncated this turn, and reading it
					// as if it did suppresses the compaction the retry needs.
					const outputCap = lastOutputCap(this.config.sessionId);
					this.compactBeforeNextTurn = outputCap?.windowBound ?? true;
					this.truncatedOutputCapTokens = this.compactBeforeNextTurn
						? undefined
						: outputCap?.maxTokens;
					// The reasoning goes with the message, unless the host wants a note
					// out of it first. This is the only turn whose thinking reliably
					// ends at the model's budget -- a think ends *at* the budget message
					// only when there was no room to continue past it, which is the same
					// condition that lands here -- so a condenser watching the transcript
					// never sees one.
					const discardedNote = await this.noteDiscardedReasoning(
						message,
						this.compactBeforeNextTurn,
					);
					await this.emit({
						type: "status-notice",
						snapshot: this.snapshot(),
						message: "output limit reached before the turn finished — retrying",
						metadata: {
							kind: "max_tokens_turn_recovery",
							reason: "max_tokens_turn_recovery",
							phase: "started",
							iteration: this.state.iteration,
							attempt: this.consecutiveMaxTokensRetries,
							// The budget the attempt count is counting against, so a
							// row can say "1 of 2" rather than a bare ordinal that
							// tells the reader nothing about how much rope is left.
							maxAttempts: this.getMaxTokensRetryBudget(),
							outputCapSource: outputCap?.source ?? "unknown",
							// The cap that actually ended the turn. Without it the
							// row cannot distinguish the window being tight from a
							// caller-set ceiling no compaction can raise -- which is
							// the whole reason `compacting` is decided the way it is.
							...(typeof outputCap?.maxTokens === "number"
								? { capTokens: outputCap.maxTokens }
								: {}),
							compacting: this.compactBeforeNextTurn,
						},
					});
					await this.addUserReminderMessage(
						discardedNote
							? [
									MAX_TOKENS_INCOMPLETE_TURN_REMINDER,
									...(discardedNote.note
										? [DISCARDED_REASONING_NOTE_PREFIX, discardedNote.note]
										: []),
									...(discardedNote.retrospective
										? [
												DISCARDED_RETROSPECTIVE_PREFIX,
												discardedNote.retrospective,
											]
										: []),
								].join("\n\n")
							: MAX_TOKENS_INCOMPLETE_TURN_REMINDER,
						// The same fields the notice above carries, so the row a
						// reader sees live and the row they see when they reopen
						// the task are the same row rather than one and nothing.
						{
							noticeKind: "max_tokens_turn_recovery",
							attempt: this.consecutiveMaxTokensRetries,
							maxAttempts: this.getMaxTokensRetryBudget(),
							capSource: outputCap?.source ?? "unknown",
							...(typeof outputCap?.maxTokens === "number"
								? { capTokens: outputCap.maxTokens }
								: {}),
							compacting: this.compactBeforeNextTurn,
						},
					);
					continue;
				}

				finalAssistantMessage = message;
				await this.recordAssistantMessage(message, finishReason);

				if (interrupted) {
					await this.emit({
						type: "turn-finished",
						snapshot: this.snapshot(),
						iteration: this.state.iteration,
						toolCallCount: 0,
					});
					continue;
				}

				// Recovery already continued once, or external tool activity made
				// replay unsafe. Local calls are handled below with their results.
				if (finishReason === "unknown" && toolCalls.length === 0) {
					this.state.lastFinishReason = finishReason;
					throw new Error("Model ended without a recognized finish reason");
				}

				if (finishReason === "max-tokens" && toolCalls.length === 0) {
					// The retry budget above is spent. Upstream recovers truncated
					// turns here too (a nudge, and one compaction inside the model
					// call); this fork's recovery is the one above, which keeps the
					// reasoning and says which cap ended the turn.
					// Same set-and-throw attribution as the empty-content check.
					this.state.lastFinishReason = finishReason;
					throw new Error(MAX_TOKENS_INCOMPLETE_TURN_MESSAGE);
				}
				if (finishReason === "error" && toolCalls.length === 0) {
					if (await this.recoverUnparsableToolCall()) {
						continue;
					}
					this.state.lastFinishReason = finishReason;
					throw new Error(this.state.lastError ?? "Model stream failed");
				}
				this.toolCallParseRetries = 0;
				this.state.pendingToolCalls = toolCalls.map((part) => part.toolCallId);

				if (toolCalls.length === 0) {
					await this.emit({
						type: "turn-finished",
						snapshot: this.snapshot(),
						iteration: this.state.iteration,
						toolCallCount: 0,
					});
					// Counted here, before any handler claims the turn, because the
					// streak this guards against is built out of turns that every one
					// of them answers: a reminder, a steer, a nudge, a transaction
					// result. Counting inside a branch would miss exactly the run
					// that needs catching.
					//
					// Only turns that actually reasoned count. A silent turn that
					// thought little is a model answering, however many times it is
					// asked again, and the streak starts over on it.
					const turnReasoningChars = reasoningCharsInMessage(message);
					if (turnReasoningChars >= NON_CONVERGENCE_MIN_REASONING_CHARS) {
						this.consecutiveNoToolCallTurns += 1;
						this.noToolCallStreakReasoningChars += turnReasoningChars;
					} else {
						this.consecutiveNoToolCallTurns = 0;
						this.noToolCallStreakReasoningChars = 0;
					}
					// A message sent while the run was going answers to the user, and
					// answering it is a turn with nothing to call — which is how a run
					// ends. Measured: asked "how many lines is manic_miner.html?" in
					// the middle of a fix, the model answered, the run stopped, and
					// the file was left half-edited until "continue fixing" was typed
					// by hand. Nobody interjecting a question means "and stop".
					//
					// And it is the only thing said about that turn. The handlers
					// below all read a turn with no tool call as a model that
					// stopped working, and this one did not stop: it was
					// interrupted and it answered. Collected with the rest, the
					// reminder went out joined to "your last message contained no
					// tool calls" and, because an answer about the work describes
					// the work, to "you described the next step instead of taking
					// it" -- measured on pandorum (2026-10-11): asked for an ETA
					// mid-fix, the model answered and was told both, and its next
					// thought was "the user wants me to stop describing my
					// intentions". The user had asked a question and got an answer.
					// None of the other guards is evaluated, so none of them spends
					// its one use on a turn it was never about.
					if (this.steerAwaitingResume) {
						this.steerAwaitingResume = false;
						await this.addUserReminderMessage(STEER_RESUME_REMINDER);
						continue;
					}
					// A turn this runtime ended itself, by cutting the call the
					// model was writing. It did not stop working and it did not
					// stay silent; the one thing to say about it is why it was
					// cut, and none of the guards below is about that.
					if (this.pendingToolIntentNudge) {
						const nudge = this.pendingToolIntentNudge;
						this.pendingToolIntentNudge = undefined;
						await this.addUserReminderMessage(nudge);
						continue;
					}
					// Every handler below asks the model for something different, and
					// a turn can be wrong in more than one way at once. They are all
					// collected and all delivered, in the order they are evaluated,
					// because a nudge that is needed does not stop being needed just
					// because another one also fired. Picking a single winner meant
					// the losers were silently dropped and, since each spent flag is
					// set only when its message is sent, re-evaluated turn after turn
					// -- the run was told one thing at a time about a turn that was
					// wrong in three ways. Only the completion boundary stays a
					// single winner, below, and for a reason of its own.
					const reminders: string[] = [];
					// Which behavioural guards fired this turn, beside the text
					// they produced. The text goes to the model; this goes to the
					// event stream, because a guard that emits nothing cannot be
					// tuned -- a corpus of finished runs could report how often
					// compaction fired and had no idea how often the model was
					// nudged, so the thresholds here were the only ones in the
					// system with no evidence behind them.
					const firedNudges: Array<{
						nudge: string;
						detail?: Record<string, unknown>;
					}> = [];
					const completionReminders = this.getCompletionReminderMessages();
					reminders.push(...completionReminders.messages);
					const finalText = textFromMessage(finalAssistantMessage);
					// The text is a stub by now if it held a call nothing could
					// read; what it held is what the nudges answer.
					const unreadableCall = finalAssistantMessage
						? this.unreadableCalls.get(finalAssistantMessage)
						: undefined;
					const noToolCallNudge = await this.getNoToolCallNudgeMessage(
						finalText,
						completionReminders.guardAsked,
						unreadableCall,
					);
					if (noToolCallNudge) {
						this.noToolCallNudgeAsked = true;
						this.consecutiveNoToolCallNudges += 1;
						reminders.push(noToolCallNudge);
						firedNudges.push({
							nudge: "no_tool_call",
							detail: { consecutive: this.consecutiveNoToolCallNudges },
						});
					}
					// The silence budget is spent, but this turn was not silence: the
					// model emitted a call and the provider could not read it. Ending
					// here reports as the run's answer a block that never ran, which
					// is how a raw `<tool_call>` came to stand as a Completed
					// message. Asked for each call that differs from the one last
					// asked about and never for the same call twice running, and
					// gated like every other extension of the nudge policy -- a host
					// with the budget at zero has said a silent turn ends the run,
					// and this must not be a second door into the same room.
					const unparsedCall = this.nudgesEnabled()
						? (unreadableCall ?? unparsedToolCallInText(finalText))
						: undefined;
					const unparsedFingerprint = unparsedCall
						? ((finalAssistantMessage
								? this.unreadableCallFingerprints.get(finalAssistantMessage)
								: undefined) ?? fingerprintUnreadableCall(finalText ?? ""))
						: undefined;
					if (
						unparsedCall &&
						unparsedFingerprint !== this.lastNudgedUnreadableCall
					) {
						this.lastNudgedUnreadableCall = unparsedFingerprint;
						// The silence nudge says the same thing about this turn
						// when it still has budget; once is enough.
						const unparsedNudge = buildUnparsedToolCallNudge(unparsedCall);
						if (!reminders.includes(unparsedNudge)) {
							reminders.push(unparsedNudge);
						}
						firedNudges.push({ nudge: "unparsed_tool_call" });
					}
					// The nudge budget is spent, but a model that answered it by
					// announcing more work has not answered it -- it restated the
					// plan, which is the behaviour the nudge exists to catch. Once
					// per run, and never for a model that says it is done: that one
					// has answered, and repeating the question at it is the waste
					// the budget of one was measured to prevent.
					//
					// An extension of the nudge policy, never a way around it: a
					// host with the budget at zero has said a silent turn ends the
					// run, and this must not be a second door into the same room.
					const announcement =
						this.intentNudgeSpent || !this.nudgesEnabled()
							? undefined
							: announcedIntentWithoutActing(finalText);
					if (announcement) {
						this.intentNudgeSpent = true;
						reminders.push(buildAnnouncedIntentNudge(announcement));
						firedNudges.push({ nudge: "announced_intent" });
					}
					// The run has thought for several turns and done nothing, and
					// none of the handlers above saw it: each one looks at the last
					// turn, and this failure is only visible across turns. Nudged,
					// never ended -- a false positive here costs one message on a
					// run that was working, and the streak is not proof of anything
					// beyond "no work has come out of this for a while".
					if (this.shouldNudgeNonConvergence()) {
						this.nonConvergenceNudgeSpent = true;
						reminders.push(
							buildNonConvergenceNudge(
								this.consecutiveNoToolCallTurns,
								this.noToolCallStreakReasoningChars,
							),
						);
						firedNudges.push({
							nudge: "non_convergence",
							detail: {
								consecutiveNoToolCallTurns: this.consecutiveNoToolCallTurns,
								reasoningChars: this.noToolCallStreakReasoningChars,
							},
						});
					}
					// Gated on `nudgesEnabled` on this path only: a host with the
					// budget at zero has said a silent turn ends the run, and a
					// reminder appended here would keep it alive. The tool-calling
					// path carries no such risk and is not gated.
					const silentRepetition = this.nudgesEnabled()
						? this.repetitionNudgeFor(message)
						: undefined;
					if (silentRepetition) {
						reminders.push(silentRepetition);
						firedNudges.push({ nudge: "silent_repetition" });
					}
					if (reminders.length > 0) {
						// Deduped by text, order kept: `getNoToolCallNudgeMessage`
						// already answers an unreadable tool call with the unparsed
						// nudge, so those two handlers can produce the same paragraph
						// on one turn -- and saying the same thing twice in one breath
						// is the exact failure the last of these guards complains about.
						for (const reminder of new Set(reminders)) {
							await this.addUserReminderMessage(reminder);
						}
						// One notice per guard that fired, not one for the turn:
						// a turn can be wrong in several ways at once, and a
						// record that collapses them cannot say which threshold
						// was the one that moved.
						for (const fired of firedNudges) {
							await this.emit({
								type: "status-notice",
								snapshot: this.snapshot(),
								message: describeNudge(fired.nudge),
								metadata: {
									kind: "nudge",
									reason: "nudge",
									nudge: fired.nudge,
									iteration: this.state.iteration,
									...(fired.detail ?? {}),
								},
							});
						}
						continue;
					}
					// Last, and only once nothing else wants the turn: everything above
					// asks the model to keep working, while this asks whether the work
					// it has already done is good, and that question is only worth the
					// cost when the run is otherwise over.
					// Reaching here with nudges already spent is not the model
					// deciding it is done: it is a model that went quiet, was asked
					// to carry on, went quiet again, and has now run out of asking.
					// A boundary told nothing about that reads the silence as an
					// answer.
					const boundaryMessage = await this.runCompletionBoundary(
						textFromMessage(finalAssistantMessage),
						this.consecutiveNoToolCallNudges > 0,
					);
					if (boundaryMessage) {
						await this.addUserReminderMessage(boundaryMessage);
						continue;
					}
					// Nothing above claimed the turn, so the run ends here -- unless
					// the turn was thinking and nothing else, which is not an answer
					// to end on. Last, so every guard that already speaks to a
					// silent turn (the no-tool-call nudge, non-convergence, the
					// completion boundary) has had it first.
					// Not a turn the reasoning loop guard cut: that one is thinking
					// only because the guard ended it, and the guard has its own
					// streak and its own end.
					const thinkingOnly =
						message.metadata?.modelToolActivities ||
						this.reasoningLoopStreak > 0
							? undefined
							: thinkingOnlyTurn(message);
					if (
						thinkingOnly &&
						this.thinkingOnlyRetries < THINKING_ONLY_RETRY_BUDGET
					) {
						this.thinkingOnlyRetries += 1;
						await this.emit({
							type: "status-notice",
							snapshot: this.snapshot(),
							message: thinkingOnly.toolCallInThinking
								? "the model wrote its tool call inside its thinking — asking for it again"
								: "the model's turn was thinking only — asking for an answer",
							metadata: {
								kind: "thinking_only_recovery",
								reason: "thinking_only_recovery",
								phase: "started",
								iteration: this.state.iteration,
								attempt: this.thinkingOnlyRetries,
								maxAttempts: THINKING_ONLY_RETRY_BUDGET,
								toolCallInThinking: thinkingOnly.toolCallInThinking,
							},
						});
						await this.addUserReminderMessage(
							thinkingOnly.toolCallInThinking
								? TOOL_CALL_IN_THINKING_REMINDER
								: THINKING_ONLY_REMINDER,
						);
						continue;
					}
					const result = this.finishRun("completed", finalAssistantMessage);
					await this.callAfterRunHooks(result);
					await this.emit({
						type: "run-finished",
						snapshot: this.snapshot(),
						result,
					});
					return result;
				}

				// A turn that calls tools is a turn that is working, so the
				// consecutive-silence budget starts over.
				this.hasCalledAnyTool = true;
				this.calledToolThisRun = true;
				this.consecutiveNoToolCallNudges = 0;
				this.thinkingOnlyRetries = 0;
				this.consecutiveNoToolCallTurns = 0;
				this.noToolCallStreakReasoningChars = 0;
				// Same for truncation: a turn that reached its tool calls did not
				// run out of room, so a later one gets the full allowance again.
				this.consecutiveMaxTokensRetries = 0;
				this.truncatedOutputCapTokens = undefined;
				const toolsAt = Date.now();
				this.trace(
					`tools-begin iter=${this.state.iteration} n=${toolCalls.length} ${toolCalls
						.map((call) => call.toolName)
						.join(",")}`,
				);
				const toolMessages = await this.executeToolCalls(toolCalls);
				this.trace(
					`tools-end iter=${this.state.iteration} took=${Date.now() - toolsAt}ms`,
				);
				this.state.pendingToolCalls = [];
				for (const toolMessage of toolMessages) {
					this.state.messages.push(toolMessage);
					await this.emit({
						type: "message-added",
						snapshot: this.snapshot(),
						message: toolMessage,
					});
				}
				if (
					finishReason === "unknown" &&
					!toolMessages.some((toolMessage) =>
						toolMessage.content.some(
							(part) => part.type === "tool-result" && !part.isError,
						),
					)
				) {
					this.state.lastFinishReason = finishReason;
					throw new Error(
						"Model ended without a recognized finish reason or successful tool work",
					);
				}

				await this.flushPendingHookContexts();
				await this.emit({
					type: "turn-finished",
					snapshot: this.snapshot(),
					iteration: this.state.iteration,
					toolCallCount: toolCalls.length,
				});
				const terminalToolMessage = this.findCompletingToolMessage(
					toolCalls,
					toolMessages,
				);
				if (terminalToolMessage) {
					// Same boundary as the silent path: a model that ends a run by
					// calling a tool has still ended it, and a guard that watched only
					// the silent path would never see the most deliberate way to stop.
					const boundaryMessage = await this.runCompletionBoundary(
						textFromToolMessage(terminalToolMessage) ||
							textFromMessage(finalAssistantMessage),
					);
					if (boundaryMessage) {
						await this.addUserReminderMessage(boundaryMessage);
						continue;
					}
					const result = this.finishRun(
						"completed",
						finalAssistantMessage,
						textFromToolMessage(terminalToolMessage) || undefined,
					);
					await this.callAfterRunHooks(result);
					await this.emit({
						type: "run-finished",
						snapshot: this.snapshot(),
						result,
					});
					return result;
				}
				// A looping turn that still calls tools is the shape every
				// turn-level detector is blind to: measured on `kessj` message 30,
				// one paragraph written seven times in sixty-five, and the turn
				// emitted a tool call, so the run read as productive. Reached only
				// once the turn is otherwise going to continue, so it appends to a
				// turn that was carrying on anyway and can never keep a finished
				// run alive.
				const repetition = this.repetitionNudgeFor(finalAssistantMessage);
				if (repetition) {
					await this.addUserReminderMessage(repetition);
				}
				// Whatever the host noticed while the tools ran. After the tool
				// results, which is the only place a user message may follow
				// an assistant turn that made calls.
				const hostReminder =
					this.config.completionPolicy?.afterToolsReminder?.();
				if (hostReminder) {
					await this.addUserReminderMessage(hostReminder);
				}
				// The cut call rode in a turn whose other calls ran.
				if (this.pendingToolIntentNudge) {
					const nudge = this.pendingToolIntentNudge;
					this.pendingToolIntentNudge = undefined;
					await this.addUserReminderMessage(nudge);
				}
			}

			throw new MaxIterationsReachedError(this.config.maxIterations);
		} catch (error) {
			const normalized =
				error instanceof Error ? error : new Error(String(error));
			const isControlledStop = normalized instanceof ControlledStopError;
			const isAborted = this.abortController.signal.aborted || isControlledStop;
			const status = isAborted ? "aborted" : "failed";
			// Read before overwriting lastError below: the class only applies
			// when the run failed on the provider error it was recorded for.
			const errorClass =
				normalized instanceof ContextWindowOverflowError
					? ("context_window_exceeded" as const)
					: normalized.message === this.state.lastError
						? this.state.lastErrorClass
						: undefined;
			// Same guard: the model layer's telemetry only covers this failure
			// if the run failed on that exact recorded error.
			const errorAlreadyReported =
				normalized.message === this.state.lastError &&
				this.state.lastErrorReported;
			this.state.status = status;
			this.state.lastError = normalized.message;
			this.state.lastErrorClass = errorClass;
			this.state.lastErrorReported = errorAlreadyReported;
			const lastAssistantMessage = this.findLastAssistantMessage();
			const result: AgentRunResult = {
				agentId: this.state.agentId,
				agentRole: this.state.agentRole,
				runId: this.state.runId ?? createUID("run"),
				status,
				iterations: this.state.iteration,
				outputText: textFromMessage(lastAssistantMessage),
				messages: cloneMessages(this.state.messages),
				usage: cloneUsage(this.state.usage),
				error: status === "failed" ? normalized : undefined,
				// The abort carries its reason in the error it was aborted with, and
				// dropping it here left the CLI to infer one from two booleans: no
				// timeout and no local abort, therefore "aborted by another client".
				// There is no other client in a headless run. Measured: a run stopped
				// by the mistake limit — `consecutive mistakes reached (6/6) in yolo
				// mode` in the runtime log — reported `external_abort` on the JSON
				// stream, which is what anything machine-readable had to go on.
				abortReason: status === "aborted" ? normalized.message : undefined,
				...(status === "failed" &&
				normalized instanceof MaxIterationsReachedError
					? { limit: "max_iterations" as const }
					: {}),
			};
			// The name and message go in the text, not only in the metadata below.
			// Hosts routinely drop structured log arguments — the VS Code host
			// serialises them only when `IS_DEV=true`, so in a packaged build this
			// line read "Agent loop caught error" and nothing else. Measured: a run
			// aborted by the loop detector produced exactly that, and the user saw a
			// task end with no message at all while the reason sat one field away.
			this.config.logger?.log?.(
				`Agent loop caught error (${status}): ${normalized.name}: ${normalized.message}`,
				{
					severity: status === "failed" ? "error" : "warn",
					agentId: this.state.agentId,
					agentRole: this.state.agentRole,
					runId: result.runId,
					status,
					iteration: this.state.iteration,
					errorName: normalized.name,
					errorMessage: normalized.message,
					assistantContentPartCount: lastAssistantMessage?.content.length ?? 0,
				},
			);
			await this.callAfterRunHooks(result);
			if (status === "failed") {
				await this.emit({
					type: "run-failed",
					snapshot: this.snapshot(),
					error: normalized,
					errorClass,
				});
			} else {
				await this.emit({
					type: "run-finished",
					snapshot: this.snapshot(),
					result,
				});
			}
			return result;
		} finally {
			this.abortController = undefined;
		}
	}

	/**
	 * Injects the collected hook context blocks as one user message at the end
	 * of the conversation. Always delivers: the buffer is empty afterwards.
	 */
	private async flushPendingHookContexts(): Promise<void> {
		if (this.pendingHookContexts.length === 0) {
			return;
		}
		const hookContextText = this.pendingHookContexts.join("\n\n");
		this.pendingHookContexts = [];
		// displayRole "system" keeps the injected block out of user-facing
		// transcripts (live and replayed) while it still reaches the model,
		// mirroring how compaction summaries are handled.
		const hookContextMessage = createMessage(
			"user",
			[{ type: "text", text: hookContextText }],
			{ userRunSpan: 0, displayRole: "system" },
		);
		// Never insert between an assistant tool_use and its tool_result: a
		// resumed session can be seeded with a trailing unresolved tool call,
		// and a user message in that gap breaks providers' pairing rules. The
		// context goes in ahead of that call instead — deferring it would only
		// deliver if the model happened to call a tool next, and the buffer
		// reset at the following run start would otherwise drop it.
		const lastMessage = this.state.messages.at(-1);
		const trailingToolCall =
			lastMessage?.role === "assistant" &&
			lastMessage.content.some((part) => part.type === "tool-call");
		if (trailingToolCall) {
			this.state.messages.splice(-1, 0, hookContextMessage);
		} else {
			this.state.messages.push(hookContextMessage);
		}
		await this.emit({
			type: "message-added",
			snapshot: this.snapshot(),
			message: hookContextMessage,
		});
	}

	private async callBeforeRunHooks(): Promise<void> {
		for (const hook of this.hooks.beforeRun) {
			const result = await hook({
				snapshot: this.snapshot(),
			});
			this.applyStopControl(result);
			// Collected here, injected after the run's input messages are
			// pushed, so the block lands in the same turn as the user prompt.
			if (result?.appendContext?.trim()) {
				this.pendingHookContexts.push(
					formatHookContextBlock({ source: "RunStart" }, result.appendContext),
				);
			}
		}
	}

	private async callAfterRunHooks(result: AgentRunResult): Promise<void> {
		for (const hook of this.hooks.afterRun) {
			await hook({ snapshot: this.snapshot(), result });
		}
	}

	/**
	 * Run a model turn, and take it again for as long as it fails on a fault
	 * that is not the model's: the server restarted or dropped the connection
	 * (`transport`), or declined to run it now (`refusal`).
	 *
	 * Only with a `recoverTurnFault` configured, which does the waiting -- for
	 * the server to answer again, or a backoff -- and decides whether to go on.
	 * Without one, such a turn fails the run exactly as it always did.
	 *
	 * Replaying is safe because a turn that failed committed nothing: the
	 * message is discarded here, before it can enter the transcript, and no tool
	 * in it has run. Measured on 1tmrl: ten agents ended on `server is shutting
	 * down` mid-stream and eighteen on an admission refusal of a later turn,
	 * every one of them a turn that could simply have been sent again.
	 *
	 * Unbounded on purpose; the user's Stop is the bound. The abort signal wins
	 * over every wait, and is checked again before each re-send.
	 */
	private async generateAssistantMessageRecoveringFaults(): Promise<{
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
		interrupted?: boolean;
	}> {
		for (let attempt = 1; ; attempt += 1) {
			let turn:
				| {
						message: AgentMessage;
						finishReason: AgentModelFinishReason;
						interrupted?: boolean;
				  }
				| undefined;
			let thrown: unknown;
			let threw = false;
			try {
				// The bounded, timed retry for transient provider errors sits
				// inside: it declines the faults `recoverTurnFault` owns (see
				// `isRetryableProviderErrorTurn`), so the two never both re-send.
				turn = await this.withProviderErrorRetry(() =>
					this.generateAssistantMessageWithOverflowRecovery(),
				);
			} catch (error) {
				if (
					this.abortController?.signal.aborted ||
					error instanceof ControlledStopError ||
					error instanceof ContextWindowOverflowError ||
					error instanceof AgentRuntimeAbortError
				) {
					throw error;
				}
				thrown = error;
				threw = true;
			}
			const recover = this.config.recoverTurnFault;
			const giveUp = () => {
				if (threw) {
					throw thrown;
				}
				return turn as {
					message: AgentMessage;
					finishReason: AgentModelFinishReason;
					interrupted?: boolean;
				};
			};
			if (!recover) {
				return giveUp();
			}
			let kind: ReturnType<typeof classifyTurnFault>;
			let providerError: string;
			let evicted: boolean;
			if (threw) {
				kind = classifyTurnFaultError(thrown);
				providerError =
					thrown instanceof Error ? thrown.message : String(thrown);
				evicted = isKvEvictionError(thrown);
			} else if (turn?.finishReason === "error") {
				providerError = this.state.lastError ?? "";
				kind = classifyTurnFault(providerError, this.state.lastErrorClass);
				evicted = isKvEviction(providerError, this.state.lastErrorClass);
			} else {
				return giveUp();
			}
			if (!kind || !this.recoversTurnFault(kind)) {
				return giveUp();
			}
			const sessionId = trimNonEmpty(this.config.sessionId);
			const tokensHeld = this.lastRequestTokens;
			if (evicted) {
				// No session is ever meant to be evicted: this is the engine's
				// bug, reported as one, and the only fault that is a warning
				// while the turn is waited out like a refusal.
				this.config.logger?.log?.(
					`Engine bug: the server evicted session ${sessionId ?? "(unnamed)"} (agent ${this.state.agentId}) at ${new Date().toISOString()}, holding ${
						tokensHeld !== undefined
							? `${tokensHeld.toLocaleString("en-US")} tokens (its last completed request)`
							: "an unknown number of tokens (no request had completed)"
					}, turn ${this.state.iteration}, attempt ${attempt}: ${providerError}; waiting to send it again`,
					{
						severity: "warn",
						kind: "engine_eviction",
						...(sessionId ? { sessionId } : {}),
						agentId: this.state.agentId,
						...(tokensHeld !== undefined ? { tokensHeld } : {}),
						iteration: this.state.iteration,
						attempt,
					},
				);
			} else {
				// A refusal is pacing, not a fault: info. A transport fault is a
				// server gone, which is worth a warning.
				this.config.logger?.log?.(
					kind === "refusal"
						? `Turn ${this.state.iteration} queued by the server (retry ${attempt}): ${describeAdmissionWait(providerError)}; waiting to send it again`
						: `Turn ${this.state.iteration} failed on a ${kind} fault (attempt ${attempt}): ${providerError}; waiting to send it again`,
					{ severity: kind === "refusal" ? "info" : "warn" },
				);
			}
			await this.emit({
				type: "status-notice",
				snapshot: this.snapshot(),
				message: evicted
					? "the server evicted the turn to keep others alive (an engine bug) — waiting, then retrying"
					: kind === "transport"
						? "the server dropped the turn — waiting for it to come back, then retrying"
						: "the server queued the turn — waiting for room, then retrying",
				metadata: {
					kind: "turn_fault_recovery",
					reason: kind,
					...(evicted ? { evicted: true } : {}),
					phase: "started",
					iteration: this.state.iteration,
					attempt,
					providerError,
				},
			});
			let again = false;
			try {
				again = await recover({
					kind,
					message: providerError,
					attempt,
					iteration: this.state.iteration,
					...(evicted ? { evicted: true } : {}),
					...(evicted && tokensHeld !== undefined ? { tokensHeld } : {}),
					...(sessionId ? { sessionId } : {}),
					...(this.abortController?.signal
						? { signal: this.abortController.signal }
						: {}),
				});
			} catch {
				again = false;
			}
			this.throwIfAborted();
			if (!again) {
				return giveUp();
			}
		}
	}

	/**
	 * Run a model turn, retrying transient provider/API failures with backoff.
	 *
	 * A turn whose model stream fails with a retryable provider error (rate
	 * limit, 5xx, network hiccup, or OpenRouter's generic "Provider returned
	 * error") is re-issued up to {@link PROVIDER_ERROR_MAX_RETRIES} times, with
	 * exponential backoff between attempts, before the error is allowed to
	 * propagate and end the run. Non-retryable errors (auth, context-window
	 * overflow, other client errors) and any attempt that already produced
	 * visible output or provider tool activity are returned unchanged for the
	 * caller to handle, so this only adds
	 * resilience and never changes behavior for a turn that would otherwise
	 * succeed. Context-window overflow recovery and max-tokens recovery still
	 * run inside each attempt (the latter at most once per run). An unknown
	 * finish without tool activity is continued once from the partial history;
	 * it is never inferred from whether the response contains visible text.
	 */
	private async generateAssistantMessageWithProviderRetry(): Promise<{
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
		interrupted?: boolean;
	}> {
		const issue = () => this.generateAssistantMessageRecoveringFaults();
		const first = await issue();
		if (first.finishReason !== "unknown" || first.interrupted) return first;

		// Tool activity cannot be replayed, and local tool calls must receive
		// their results before another request. Leave those turns to the loop.
		if (
			first.message.content.some((part) => part.type === "tool-call") ||
			this.hasModelToolActivity(first.message)
		)
			return first;

		// An unknown terminal reason, independent of text/reasoning content,
		// permits exactly one continuation from the preserved partial history.
		await this.recordAssistantMessage(first.message, first.finishReason);
		// A user-role continuation avoids treating partial history as assistant
		// prefill. Match hook context visibility in live and replayed transcripts.
		await this.addUserReminderMessage(
			"Previous turn ended unexpectedly. Continue from where you left off.",
			{ displayRole: "system" },
		);
		this.resetLastError();
		return await issue();
	}

	/**
	 * Run `issue`, re-running it with backoff while it returns a turn that
	 * failed with a transient, retryable provider error (see
	 * {@link isRetryableProviderErrorTurn}), up to PROVIDER_ERROR_MAX_RETRIES
	 * times. `issue` decides what is re-run: the whole prepared turn for an
	 * ordinary request, or just the issuing of an already-prepared request.
	 */
	private async withProviderErrorRetry<
		T extends { message: AgentMessage; finishReason: AgentModelFinishReason },
	>(issue: () => Promise<T>): Promise<T> {
		let attempt = 0;
		for (;;) {
			const turn = await issue();
			if (
				attempt >= PROVIDER_ERROR_MAX_RETRIES ||
				!this.isRetryableProviderErrorTurn(turn)
			) {
				return turn;
			}
			attempt += 1;
			const providerError = this.state.lastError;
			// The failed attempt's error is captured for the notice above; clear it
			// so the next attempt's finish event is judged on its own.
			this.resetLastError();
			const delayMs = Math.min(
				PROVIDER_ERROR_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
				PROVIDER_ERROR_RETRY_MAX_DELAY_MS,
			);
			await this.emit({
				type: "status-notice",
				snapshot: this.snapshot(),
				message: `provider error — retrying (attempt ${attempt}/${PROVIDER_ERROR_MAX_RETRIES})`,
				metadata: {
					kind: "provider_error_retry",
					reason: "provider_error_retry",
					phase: "started",
					iteration: this.state.iteration,
					attempt,
					maxRetries: PROVIDER_ERROR_MAX_RETRIES,
					delayMs,
					providerError,
				},
			});
			await this.abortableDelay(delayMs);
		}
	}

	/**
	 * True when a turn failed with a transient provider error that a retry
	 * could plausibly recover, and the failed attempt left nothing behind that
	 * a second stream would duplicate or repeat:
	 * - no content at all (text, reasoning, media, or local tool calls): those
	 *   deltas were already emitted to the UI and there is no event to retract
	 *   them, so re-streaming would show the output twice;
	 * - no provider-executed tool activity (recorded in message metadata, not
	 *   content): re-issuing the request could run those side effects again;
	 * - not an auth or context-window failure, which the same request cannot fix.
	 */
	private isRetryableProviderErrorTurn(turn: {
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
	}): boolean {
		if (turn.finishReason !== "error") {
			return false;
		}
		if (turn.message.content.length > 0) {
			return false;
		}
		const modelToolActivities = turn.message.metadata?.modelToolActivities;
		if (Array.isArray(modelToolActivities) && modelToolActivities.length > 0) {
			return false;
		}
		const errorClass = this.state.lastErrorClass;
		if (errorClass === "auth" || errorClass === "context_window_exceeded") {
			return false;
		}
		// A server that dropped or queued the turn is the host's to wait out:
		// `recoverTurnFault` waits for the server itself rather than re-dialling
		// on a timer, and three quick requests at a server that just refused
		// one are what it exists to avoid.
		const fault = classifyTurnFault(this.state.lastError ?? "", errorClass);
		if (fault && this.recoversTurnFault(fault)) {
			return false;
		}
		// Set from the model boundary's typed `isRetryable` flag when available,
		// otherwise classified from the flattened message in the finish handler.
		return this.state.lastErrorRetryable === true;
	}

	/**
	 * Clear the last-error fields. Called at the start of every turn and before
	 * every provider-error retry, so a `finish` event that omits `error` (allowed
	 * by the public AgentModel contract) cannot inherit the class or retryability
	 * of an earlier attempt. Deliberately not called inside overflow recovery,
	 * whose "nothing to compact" error reports the first attempt's provider
	 * message.
	 */
	private resetLastError(): void {
		this.state.lastError = undefined;
		this.state.lastErrorClass = undefined;
		this.state.lastErrorRetryable = undefined;
		this.state.lastErrorReported = false;
	}

	/**
	 * Sleep for `ms`, rejecting early with the abort error if the run is
	 * aborted while waiting, so a retry backoff never blocks cancellation.
	 */
	private async abortableDelay(ms: number): Promise<void> {
		this.throwIfAborted();
		const signal = this.abortController?.signal;
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				clearTimeout(timer);
				reject(this.normalizeAbortError());
			};
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		});
	}

	/**
	 * Run a model turn, recovering once per run from a provider-rejected
	 * context-window overflow: force a compaction through `prepareTurn` and
	 * retry the request. Terminal (unrecoverable) overflow states throw with
	 * an actionable message instead of the raw provider error.
	 */
	private async generateAssistantMessageWithOverflowRecovery(): Promise<{
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
		interrupted?: boolean;
	}> {
		// With a vision model configured, the primary model is not meant to see
		// the image at all — the point of configuring one is that a description
		// goes in its place, whether or not the primary model could have coped.
		if (this.config.alwaysDescribeImages === true) {
			await this.describeImagesInTranscript();
		}
		const forceCompaction = this.compactBeforeNextTurn;
		this.compactBeforeNextTurn = false;
		const first = await this.generateAssistantMessage(
			forceCompaction ? { overflowRecovery: true } : undefined,
		);
		if (this.isRecoverableImageTurn(first)) {
			return await this.retryWithoutImages();
		}
		if (!this.isRecoverableOverflowTurn(first)) {
			return first;
		}
		this.overflowRecoveryAttempted = true;
		const providerError = this.state.lastError;
		if (!this.config.prepareTurn) {
			throw new ContextWindowOverflowError(
				CONTEXT_WINDOW_OVERFLOW_NO_RECOVERY_MESSAGE,
				providerError,
			);
		}
		await this.emit({
			type: "status-notice",
			snapshot: this.snapshot(),
			message: "context window exceeded — compacting and retrying",
			metadata: {
				kind: "context_overflow_recovery",
				reason: "context_overflow_recovery",
				phase: "started",
				iteration: this.state.iteration,
				providerError,
			},
		});
		const retry = await this.generateAssistantMessage({
			overflowRecovery: true,
			requireSmallerRequest: true,
		});
		if (
			retry.finishReason === "error" &&
			this.state.lastErrorClass === "context_window_exceeded"
		) {
			throw new ContextWindowOverflowError(
				CONTEXT_WINDOW_OVERFLOW_RECOVERY_FAILED_MESSAGE,
				this.state.lastError,
			);
		}
		return retry;
	}

	/**
	 * Ask the model to send a tool call the provider could not parse again.
	 *
	 * Returns whether the turn was recovered, so both call sites can `continue`
	 * on true and fall through to their own error on false.
	 *
	 * A call that would not parse is a wasted turn, not a failed run: nothing
	 * executed, nothing changed, and whatever the model wrote before it is
	 * still in the transcript — usually the expensive part. Measured: a
	 * transaction that had already carried a broken file past its syntax error
	 * ended on `XML syntax error on line 12: element <parameter> closed by
	 * </function>` at 3,449s of a 7,200s budget. An hour of clock went unused
	 * because one malformed call was treated as the end of the run.
	 *
	 * What this deliberately does not do is repair the payload. A call
	 * truncated mid-argument, patched up and executed, writes the fragment over
	 * the file it names and reports success.
	 */
	private async recoverUnparsableToolCall(): Promise<boolean> {
		if (
			this.state.lastErrorClass !== "tool_call_unparsable" ||
			this.toolCallParseRetries >= TOOL_CALL_PARSE_RETRY_BUDGET
		) {
			return false;
		}
		this.toolCallParseRetries += 1;
		await this.emit({
			type: "status-notice",
			snapshot: this.snapshot(),
			message: "the model's tool call did not parse — asking for it again",
			metadata: {
				kind: "tool_call_parse_recovery",
				reason: "tool_call_parse_recovery",
				phase: "started",
				iteration: this.state.iteration,
				attempt: this.toolCallParseRetries,
				providerError: this.state.lastError,
				...(this.lastToolCallRejection
					? { rejection: this.lastToolCallRejection }
					: {}),
			},
		});
		await this.addUserReminderMessage(
			toolCallUnparsableReminder(this.lastToolCallRejection),
		);
		return true;
	}

	/**
	 * Whether the model refused the turn because it carried an image.
	 *
	 * Measured: a tester ran DeepSeek on Ollama Cloud, the `browser` tool
	 * attached a screenshot, and the session ended on "this model does not
	 * support image input". Tools guard on `modelSupportsImages`, but that flag
	 * defaults to true for any model with no declared capabilities — every model
	 * outside the shipped catalog, including the local ones this fork runs.
	 * Tightening the default would trade one broken setup for another, so the
	 * refusal itself is what we act on.
	 *
	 * It used to act on it only where nobody had declared the capability, on the
	 * grounds that a declared answer means the tools were told before they
	 * attached anything. That reasoning does not survive contact with the other
	 * ways an image arrives: the user pastes one, or a vision model is switched
	 * on and the attach guards defer to it. A tester hit exactly that — Ollama
	 * declared the model reads no images, `imageSupportDeclared` was therefore
	 * true, the vision toggle let the paste through with no describer behind it,
	 * and the run ended on the provider's refusal with no retry. Dropping the
	 * images and taking the turn again is strictly better than failing it, so
	 * the declaration no longer vetoes the recovery. What still bounds it is
	 * that the error says image input specifically, that images are actually
	 * present, and that this is tried once.
	 */
	private isRecoverableImageTurn(turn: {
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
	}): boolean {
		return (
			turn.finishReason === "error" &&
			this.state.lastErrorClass === "image_input_unsupported" &&
			!this.imageRecoveryAttempted &&
			this.hasImageContent()
		);
	}

	private hasImageContent(): boolean {
		return this.state.messages.some((message) =>
			message.content.some((part) => part.type === "image"),
		);
	}

	/**
	 * Drop every image from the transcript and take the turn again.
	 *
	 * The images are replaced with a line saying so rather than deleted: a tool
	 * result that silently loses its screenshot reads as a tool that did
	 * nothing, and the model would call it again. What remains is the text the
	 * same tool returned — for `browser`, the console output and page state,
	 * which is the part a non-vision model could act on anyway.
	 *
	 * Retried once. A second refusal means images were not the cause, and that
	 * error belongs to the caller unchanged.
	 */
	private async retryWithoutImages(): Promise<{
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
	}> {
		this.imageRecoveryAttempted = true;
		const providerError = this.state.lastError;
		// A configured vision model turns the screenshot into something the
		// primary model can still act on. Anything it could not describe falls
		// through to the notice below.
		const described = await this.describeImagesInTranscript();
		let dropped = 0;
		for (const message of this.state.messages) {
			for (let i = 0; i < message.content.length; i++) {
				if (message.content[i]?.type !== "image") {
					continue;
				}
				dropped += 1;
				message.content[i] = {
					type: "text",
					text: IMAGE_DROPPED_NOTICE,
				} as AgentMessagePart;
			}
		}
		this.config.onImageInputUnsupported?.();
		await this.emit({
			type: "status-notice",
			snapshot: this.snapshot(),
			message: "model does not accept images — resending without them",
			metadata: {
				kind: "image_input_recovery",
				reason: "image_input_recovery",
				phase: "started",
				iteration: this.state.iteration,
				droppedImages: dropped,
				describedImages: described,
				providerError,
			},
		});
		return await this.generateAssistantMessage();
	}

	/**
	 * Replace images in the transcript with a second model's description of them.
	 *
	 * Returns how many were replaced. Images the describer could not handle are
	 * left exactly as they were: this runs on every turn when a vision model is
	 * configured, including for primary models that read images perfectly well,
	 * and a describer that is briefly unreachable must not cost the primary
	 * model its screenshot.
	 *
	 * Text that shared the message with an image is passed along as context —
	 * for a browser screenshot that is the URL and console output, which is what
	 * makes the difference between "a web page" and "the login form, with an
	 * error under the password field".
	 */
	private async describeImagesInTranscript(): Promise<number> {
		const describeImages = this.config.describeImages;
		if (!describeImages) {
			return 0;
		}
		const targets: Array<{ message: AgentMessage; index: number }> = [];
		const images: AgentImageToDescribe[] = [];
		for (const message of this.state.messages) {
			const context = message.content
				.filter((part) => part.type === "text")
				.map((part) => (part as { text: string }).text)
				.join("\n")
				.slice(0, IMAGE_DESCRIPTION_CONTEXT_LIMIT);
			for (let i = 0; i < message.content.length; i++) {
				const part = message.content[i];
				if (part?.type !== "image") {
					continue;
				}
				const payload = imagePartPayload(part);
				if (payload === undefined) {
					continue;
				}
				targets.push({ message, index: i });
				images.push({
					image: payload,
					mediaType: part.mediaType,
					context: context.length > 0 ? context : undefined,
				});
			}
		}
		if (images.length === 0) {
			// The silence that made this take three rounds. A describer is
			// installed and there is nothing for it to do, which from the outside
			// looks exactly like a describer that was never installed: both end
			// with the image gone and the task carrying on, and neither wrote a
			// line. Said here so the two can be told apart from a log alone.
			// Counts only — an image and its surrounding text are the user's.
			this.config.logger?.log?.(
				`Vision describer found no images in ${this.state.messages.length} transcript message(s)`,
			);
			return 0;
		}

		let descriptions: readonly (string | undefined)[] = [];
		try {
			descriptions = await describeImages(images);
		} catch (error) {
			this.config.logger?.log?.(
				`Vision model could not describe ${images.length} image(s): ${
					error instanceof Error ? error.message : String(error)
				}`,
				{ severity: "warn" },
			);
		}

		// Whether an image the vision model could not describe may be left for
		// the primary model to look at.
		//
		// It may, unless that model is known not to read images. A real image
		// beats a note saying there was one, and where the capability is unknown
		// the refusal path already recovers a turn that goes wrong. But where it
		// is known — Ollama answers from `/api/show` — leaving the image turns a
		// failed description into a failed turn, and the vision model being
		// unreachable is exactly when that happens.
		//
		// Optimistic by default, matching the flag the tools guard on: the two
		// disagreeing about the same model is how a screenshot reached a model
		// that could not read one.
		const primaryCanSeeImages = this.config.modelSupportsImages !== false;

		let replaced = 0;
		for (let i = 0; i < targets.length; i++) {
			const description = descriptions[i]?.trim();
			if (!description && primaryCanSeeImages) {
				continue;
			}
			const target = targets[i];
			target.message.content[target.index] = {
				type: "text",
				text: description
					? `[image description, from the vision model]\n${description}`
					: IMAGE_DESCRIPTION_UNAVAILABLE_NOTICE,
			} as AgentMessagePart;
			replaced += 1;
		}
		return replaced;
	}

	private isRecoverableOverflowTurn(turn: {
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
	}): boolean {
		if (
			turn.finishReason !== "error" ||
			this.state.lastErrorClass !== "context_window_exceeded" ||
			this.overflowRecoveryAttempted
		) {
			return false;
		}
		// An errored stream that still produced tool calls proceeds through the
		// normal loop (matching existing behavior); a retry would discard that
		// partial work.
		return !turn.message.content.some((part) => part.type === "tool-call");
	}

	/** Tool activity executed outside AgentRuntime is recorded in metadata. */
	private hasModelToolActivity(message: AgentMessage): boolean {
		const activities = message.metadata?.modelToolActivities;
		return Array.isArray(activities) && activities.length > 0;
	}

	/** Append an assistant turn to the transcript and announce it. */
	private async recordAssistantMessage(
		message: AgentMessage,
		finishReason: AgentModelFinishReason,
	): Promise<void> {
		this.replaceSpoiledContent(message);
		this.state.messages.push(message);
		await this.emit({
			type: "message-added",
			snapshot: this.snapshot(),
			message,
		});
		await this.emit({
			type: "assistant-message",
			snapshot: this.snapshot(),
			iteration: this.state.iteration,
			message,
			finishReason,
		});
	}

	private async generateAssistantMessage(options?: {
		overflowRecovery?: boolean;
		requireSmallerRequest?: boolean;
	}): Promise<{
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
		interrupted?: boolean;
	}> {
		const controller = new AbortController();
		this.modelSteerController = controller;
		try {
			return await this.generateAssistantMessageForRequest(controller, options);
		} finally {
			this.modelSteerController = undefined;
		}
	}

	/** A model request with turn preparation and before-model hooks applied. */
	private async prepareModelRequest(options?: {
		overflowRecovery?: boolean;
		requireSmallerRequest?: boolean;
	}): Promise<PreparedModelRequest> {
		const modelRequestMetadata = omitUndefinedValues({
			distinctId: trimNonEmpty(this.config.distinctId),
			clientName: trimNonEmpty(this.config.clientName),
			clientVersion: trimNonEmpty(this.config.clientVersion),
			clineCoreVersion: trimNonEmpty(this.config.clineCoreVersion),
			sessionId: trimNonEmpty(this.config.sessionId),
			agentId: this.state.agentId,
			conversationId: trimNonEmpty(this.config.conversationId),
			runId: this.state.runId,
			iteration: this.state.iteration,
		});
		const retryOutputCap = this.getRetryOutputCap();
		if (retryOutputCap !== undefined) {
			this.config.logger?.log?.(
				`Retrying a truncated turn on a reduced output cap of ${retryOutputCap} tokens (attempt ${this.consecutiveMaxTokensRetries}, was ${this.truncatedOutputCapTokens})`,
				{ severity: "info" },
			);
		}
		let request: AgentModelRequest = {
			systemPrompt: this.config.systemPrompt,
			messages: cloneMessages(this.state.messages),
			tools: [...this.tools.values()].map<AgentToolDefinition>((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
				// xOllama's council offers its readers only these (#372 D2).
				...(tool.readOnly ? { readOnly: true } : {}),
			})),
			modelTools: this.config.modelTools,
			signal: this.abortController?.signal,
			options: mergeModelOptions(this.config.modelOptions, {
				metadata: modelRequestMetadata,
				...(retryOutputCap !== undefined ? { maxTokens: retryOutputCap } : {}),
			}),
		};

		const startedAt = Date.now();

		// Read queued input at every request boundary, including retries and
		// continuations within the first iteration.
		const pendingUserMessage = await this.consumePendingUserMessage();
		if (pendingUserMessage) {
			request = {
				...request,
				messages: [...request.messages, ...cloneMessages([pendingUserMessage])],
			};
		}

		request = await this.prepareTurnForModelRequest(request, options);
		this.throwIfAborted();

		for (const hook of this.hooks.beforeModel) {
			const result = (await hook({
				snapshot: this.snapshot(),
				request,
			})) as AgentBeforeModelResult | undefined;
			this.throwIfAborted();
			this.applyStopControl(result);
			if (result?.messages) {
				request = { ...request, messages: cloneMessages(result.messages) };
			}
			if (result?.tools) {
				request = { ...request, tools: [...result.tools] };
			}
			if (result?.options) {
				request = {
					...request,
					options: mergeModelOptions(request.options, result.options),
				};
			}
		}

		this.config.logger?.debug("Agent model request diagnostics", {
			iteration: this.state.iteration,
			providerId:
				"providerId" in this.config &&
				typeof this.config.providerId === "string"
					? this.config.providerId
					: undefined,
			modelId:
				"modelId" in this.config && typeof this.config.modelId === "string"
					? this.config.modelId
					: undefined,
			...summarizeModelRequest(request),
		});

		return { request, startedAt };
	}

	private async generateAssistantMessageForRequest(
		steerController: AbortController,
		options?: {
			overflowRecovery?: boolean;
			requireSmallerRequest?: boolean;
		},
	): Promise<{
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
		interrupted?: boolean;
	}> {
		const prepared = await this.prepareModelRequest(options);
		return await this.streamPreparedRequest(prepared, steerController);
	}

	/**
	 * Issue a prepared request and assemble the assistant turn from its stream.
	 * Separate from preparation so a prepared request can be re-issued (e.g.
	 * after a transient provider error) without re-running turn preparation.
	 */
	private async streamPreparedRequest(
		prepared: PreparedModelRequest,
		steerController: AbortController,
	): Promise<{
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
		interrupted?: boolean;
	}> {
		const usageBeforeModel = cloneUsage(this.state.usage);
		// Cleared, not carried: a request that reports no timings must show
		// none, rather than the previous request's stamped onto it.
		this.state.lastRequestTimings = undefined;
		const getTaskLifecycleDurationMs = () => Date.now() - prepared.startedAt;
		let request = prepared.request;

		this.throwIfAborted();
		this.captureTaskLifecycle(TASK_PROVIDER_REQUEST_STARTED_EVENT, {
			durationMs: getTaskLifecycleDurationMs(),
			phase: "provider_request_started",
		});
		// Steering cancels provider generation, while request preparation keeps
		// the run-level signal so compaction and hooks can finish consistently.
		request = {
			...request,
			signal: AbortSignal.any([
				steerController.signal,
				...(this.abortController ? [this.abortController.signal] : []),
			]),
		};
		this.lastIssuedRequest = request;
		const stream = this.openTaskLifecycleStream(
			request,
			getTaskLifecycleDurationMs,
		);

		const content: AgentMessagePart[] = [];
		const toolAssembler = new ToolCallAssembler();
		const modelToolActivities = new Map<string, AgentModelToolActivity>();
		const invalidToolCalls: InvalidToolCall[] = [];
		const sequence: Array<
			{ type: "tool"; key: string } | { type: "part"; part: AgentMessagePart }
		> = [];
		let finishReason: AgentModelFinishReason = "unknown";
		let requestId: string | undefined;
		let accumulatedText = "";
		let accumulatedReasoning = "";
		// What this request's output went to, for the usage event's split. Reset
		// once a usage event has claimed it, in case a stream reports twice.
		let channelTally = emptyOutputChannelTally();
		let toolInputCharsClaimed = 0;
		const reasoningLoopConfig = this.config.reasoningLoopDetection;
		// Undefined means on, unlike `execution.loopDetection` next to it: this
		// one guards spend, and a guard nobody enabled protects nobody.
		const reasoningLoopGuard =
			reasoningLoopConfig === false
				? undefined
				: new ReasoningLoopGuard(reasoningLoopConfig, {
						// Asked only if the guard is about to trip.
						given: () => contentGivenToModel(request.messages),
					});
		let reasoningLoop: ReasoningLoopVerdict | undefined;
		const toolIntentLimit = this.config.toolIntentLimit;
		// On unless turned off, for the reason the guard above is: it guards
		// spend. See `tool-intent-guard` for the run it comes from.
		// Stood down for one request after two cuts running. The rule reads no
		// notation, so a payload that itself holds an `intent` key (a JSON file
		// about tool calls, this file's own tests) can look like a runaway; a
		// model that needs to write one must not be cut out of it forever.
		const toolIntentStoodDown =
			this.toolIntentCutStreak >= TOOL_INTENT_CUTS_BEFORE_STAND_DOWN;
		if (toolIntentStoodDown) {
			this.toolIntentCutStreak = 0;
		}
		const toolIntentGuard =
			toolIntentLimit === false ||
			toolIntentStoodDown ||
			!isToolIntentGuardEnabled()
				? undefined
				: new ToolIntentGuard({
						...toolIntentLimit,
						argumentNames: this.toolArgumentNames(),
						toolNames: [...this.tools.values()].map((tool) => tool.name),
					});
		let toolIntentOverrun: ToolIntentOverrun | undefined;

		for await (const event of stream) {
			if (steerController.signal.aborted) break;
			this.throwIfAborted();
			switch (event.type) {
				case "text-delta": {
					accumulatedText += event.text;
					channelTally.textDeltas += 1;
					channelTally.textChars += event.text.length;
					const last = sequence.at(-1);
					if (last?.type === "part" && last.part.type === "text") {
						last.part.text += event.text;
					} else {
						sequence.push({
							type: "part",
							part: { type: "text", text: event.text },
						});
					}
					await this.emit({
						type: "assistant-text-delta",
						snapshot: this.snapshot(),
						iteration: this.state.iteration,
						text: event.text,
						accumulatedText,
					});
					break;
				}
				case "media": {
					sequence.push({
						type: "part",
						part: {
							type: "media",
							media: event.media,
						},
					});
					await this.emit({
						type: "assistant-media",
						snapshot: this.snapshot(),
						iteration: this.state.iteration,
						media: event.media,
					});
					break;
				}
				case "reasoning-delta": {
					accumulatedReasoning += event.text;
					channelTally.reasoningDeltas += 1;
					channelTally.reasoningChars += event.text.length;
					const last = sequence.at(-1);
					if (last?.type === "part" && last.part.type === "reasoning") {
						last.part.text += event.text;
						last.part.redacted = event.redacted ?? last.part.redacted;
						last.part.metadata = event.metadata ?? last.part.metadata;
					} else {
						sequence.push({
							type: "part",
							part: {
								type: "reasoning",
								text: event.text,
								redacted: event.redacted,
								metadata: event.metadata,
							},
						});
					}
					await this.emit({
						type: "assistant-reasoning-delta",
						snapshot: this.snapshot(),
						iteration: this.state.iteration,
						text: event.text,
						accumulatedText: accumulatedReasoning,
						redacted: event.redacted,
						metadata: event.metadata,
					});
					reasoningLoop = reasoningLoopGuard?.push(event.text) ?? undefined;
					break;
				}
				case "tool-input-progress": {
					// Observational: the call is assembled from `tool-call-delta`
					// alone. This only says that its arguments are streaming.
					await this.emit({
						type: "tool-updated",
						snapshot: this.snapshot(),
						iteration: this.state.iteration,
						toolCall: {
							type: "tool-call",
							toolCallId: event.toolCallId,
							toolName: event.toolName ?? "tool",
							input: undefined,
						},
						update: {
							kind: TOOL_INPUT_PROGRESS_KIND,
							inputChars: event.inputChars,
							deltas: event.deltas,
							...(event.inputText ? { inputText: event.inputText } : {}),
						},
					});
					if (event.inputText) {
						toolIntentOverrun = toolIntentGuard?.push(
							event.toolCallId,
							event.inputText,
							event.toolName,
						);
					}
					break;
				}
				case "tool-call-delta": {
					if (event.execution) {
						const toolCall: AgentToolCallPart = {
							type: "tool-call",
							toolCallId: event.toolCallId ?? createUID("model_tool"),
							toolName: event.toolName ?? "tool",
							input: event.input,
							metadata: event.metadata,
							execution: event.execution,
						};
						modelToolActivities.set(toolCall.toolCallId, {
							toolCallId: toolCall.toolCallId,
							toolName: toolCall.toolName,
							execution: event.execution,
							input: toolCall.input,
						});
						await this.emit({
							type: "tool-started",
							snapshot: this.snapshot(),
							iteration: this.state.iteration,
							toolCall,
						});
						break;
					}
					const { key, created } = toolAssembler.add(event);
					if (created) {
						sequence.push({ type: "tool", key });
					}
					break;
				}
				case "tool-result": {
					const existing = modelToolActivities.get(event.toolCallId);
					const activity = {
						...existing,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						execution: event.execution,
						input: event.input === undefined ? existing?.input : event.input,
						output: event.output,
						isError: event.isError,
					};
					modelToolActivities.set(event.toolCallId, activity);
					const toolCall: AgentToolCallPart = {
						type: "tool-call",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						input: activity.input,
						execution: event.execution,
					};
					await this.emit({
						type: "tool-finished",
						snapshot: this.snapshot(),
						iteration: this.state.iteration,
						toolCall,
						message: createMessage("tool", [
							{
								type: "tool-result",
								toolCallId: event.toolCallId,
								toolName: event.toolName,
								output: event.output,
								isError: event.isError,
								execution: event.execution,
							},
						]),
					});
					break;
				}
				case "usage": {
					// Record the provider's own input-token count for this request so
					// the prepare-turn pipeline can trigger compaction on real usage
					// rather than a character-based estimate.
					if (
						typeof event.usage.inputTokens === "number" &&
						event.usage.inputTokens > 0
					) {
						this.state.lastRequestInputTokens = event.usage.inputTokens;
					}
					// Tool arguments are measured whole, from what has been assembled:
					// Ollama sends them in one piece, other providers in fragments.
					const toolInputChars = toolAssembler.inputChars();
					channelTally.toolInputChars = Math.max(
						0,
						toolInputChars - toolInputCharsClaimed,
					);
					const outputSplit = splitOutputTokens({
						outputTokens: event.usage.outputTokens,
						providerReasoningTokens: event.usage.reasoningTokenCount,
						tally: channelTally,
					});
					toolInputCharsClaimed = toolInputChars;
					channelTally = emptyOutputChannelTally();
					await this.updateUsage(event.usage, event.timings, { outputSplit });
					break;
				}
				case "finish": {
					finishReason = event.reason;
					requestId = event.requestId;
					if (event.error) {
						this.state.lastError = event.error;
						// Models that classify at their own error boundary (where the
						// raw provider error is still structured) win. Anything else —
						// custom `AgentModel` implementations, adapters that carry only
						// a flattened message — is classified from the message so it
						// stays eligible for overflow recovery.
						this.state.lastErrorClass =
							event.errorClass ?? classifyProviderError(event.error);
						this.lastToolCallRejection = event.toolCallRejection;
						// Prefer the boundary's typed `isRetryable` signal; fall back to
						// classifying the flattened message for models that do not carry
						// it.
						this.state.lastErrorRetryable =
							event.errorRetryable ?? isRetryableProviderError(event.error);
						this.state.lastErrorReported = event.errorReported === true;
					}
					break;
				}
			}
			if (reasoningLoop || toolIntentOverrun) {
				// Leaving the loop closes the iterator, which cancels the provider
				// request. That is the whole point: the tokens stop being billed
				// now, not when the model finally reaches the context window.
				break;
			}
		}
		if (reasoningLoop) {
			await this.onReasoningLoopCut(reasoningLoop);
		} else if (reasoningLoopGuard) {
			this.reasoningLoopStreak = 0;
		}
		if (toolIntentOverrun) {
			await this.onToolIntentCut(toolIntentOverrun);
		} else if (toolIntentGuard) {
			this.toolIntentCutStreak = 0;
		}
		this.throwIfAborted();
		const interrupted = steerController.signal.aborted;
		if (interrupted) finishReason = "stop";
		// A stream this runtime cut itself never reaches its finish event. That
		// is not a model that ended without saying why -- the reason is known,
		// it is on the message, and the loop answers it with its own reminder.
		if ((reasoningLoop || toolIntentOverrun) && finishReason === "unknown") {
			finishReason = "stop";
		}

		for (const item of sequence) {
			// A cancelled stream may contain incomplete tool JSON or unsigned
			// reasoning. Keep only replayable visible content from that response.
			if (
				interrupted &&
				(item.type === "tool" || item.part.type === "reasoning")
			)
				continue;
			if (item.type === "part") {
				content.push(item.part);
				continue;
			}
			const assembly = toolAssembler.get(item.key);
			// The call that was cut: half a document, and not a call that failed
			// to parse. The stub below says what happened to it.
			if (
				toolIntentOverrun &&
				assembly?.toolCallId === toolIntentOverrun.toolCallId
			) {
				continue;
			}
			const finished = toolAssembler.finish(item.key, finishReason);
			if (finished.invalid) {
				invalidToolCalls.push(finished.invalid);
			}
			if (!finished.call || !assembly) {
				continue;
			}
			this.config.logger?.debug?.(
				describeToolArguments(
					this.state.iteration,
					finished.call.toolName,
					finished.call.toolCallId,
					assembly.inputText,
					finished.call.input,
				),
			);
			content.push(finished.call);
		}

		const messageMetadata: Record<string, unknown> = {};
		if (reasoningLoop) {
			messageMetadata.reasoningLoop = reasoningLoop;
		}
		if (toolIntentOverrun) {
			// In the turn itself, so the history reads as what happened and an
			// assistant turn with nothing else in it is not sent empty.
			content.push({
				type: "text",
				text: describeToolIntentOverrunStub(toolIntentOverrun),
			});
			messageMetadata.toolIntentOverrun = toolIntentOverrun;
		}
		if (invalidToolCalls.length > 0) {
			messageMetadata.invalidToolCalls = invalidToolCalls;
		}
		if (modelToolActivities.size > 0) {
			messageMetadata.modelToolActivities = [...modelToolActivities.values()];
		}
		const message = createMessage(
			"assistant",
			content,
			Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
		);
		const metrics = usageDelta(usageBeforeModel, this.state.usage);
		if (metrics) {
			// The timings belong to the request that produced this message, so
			// they travel with it. Without that, reopening a task from history
			// shows the token half of the numbers and an empty space where the
			// timing half was.
			if (this.state.lastRequestTimings) {
				metrics.timings = this.state.lastRequestTimings;
			}
			message.metrics = metrics;
			this.captureUnexpectedReasoningTokens(request, metrics);
		}
		if (this.config.messageModelInfo) {
			message.modelInfo = { ...this.config.messageModelInfo };
		}
		for (const hook of this.hooks.afterModel) {
			const control = (await hook({
				snapshot: this.snapshot(),
				assistantMessage: message,
				finishReason,
				...(requestId ? { requestId } : {}),
			})) as AgentStopControl | undefined;
			this.applyStopControl(control);
		}

		return { message, finishReason, interrupted };
	}

	private async *openTaskLifecycleStream(
		request: AgentModelRequest,
		getTaskLifecycleDurationMs: () => number | undefined,
	): AsyncIterable<AgentModelEvent> {
		let stream: AsyncIterable<AgentModelEvent>;
		let phase = "provider_request_started";
		const requestAt = Date.now();
		this.trace(`request-start iter=${this.state.iteration}`);
		try {
			stream = await this.config.model.stream(request);
			this.trace(
				`stream-open iter=${this.state.iteration} after=${Date.now() - requestAt}ms`,
			);
			this.throwIfAborted();
			phase = "provider_stream_started";
			this.captureTaskLifecycle(TASK_PROVIDER_STREAM_STARTED_EVENT, {
				durationMs: getTaskLifecycleDurationMs(),
				phase,
			});
		} catch (error) {
			if (request.signal?.aborted && !this.abortController?.signal.aborted)
				return;
			if (!request.signal?.aborted && !this.isAbortError(error)) {
				this.captureTaskLifecycleFailure(
					error,
					phase,
					getTaskLifecycleDurationMs(),
				);
			}
			throw error;
		}

		let receivedFirstChunk = false;
		try {
			for await (const event of stream) {
				if (!receivedFirstChunk) {
					receivedFirstChunk = true;
					this.trace(
						`first-chunk iter=${this.state.iteration} after=${Date.now() - requestAt}ms type=${event.type}`,
					);
					phase = "first_chunk_received";
					this.captureTaskLifecycle(TASK_FIRST_CHUNK_RECEIVED_EVENT, {
						durationMs: getTaskLifecycleDurationMs(),
						phase,
						eventType: event.type,
					});
				}
				yield event;
			}
		} catch (error) {
			if (request.signal?.aborted && !this.abortController?.signal.aborted)
				return;
			if (!request.signal?.aborted && !this.isAbortError(error)) {
				this.captureTaskLifecycleFailure(
					error,
					phase,
					getTaskLifecycleDurationMs(),
				);
			}
			throw error;
		}
	}

	private captureTaskLifecycleFailure(
		error: unknown,
		phase: string,
		durationMs: number | undefined,
	): void {
		this.captureTaskLifecycle(TASK_PROVIDER_STREAM_FAILED_EVENT, {
			durationMs,
			error,
			errorClass: classifyProviderError(error),
			phase,
		});
	}

	private captureTaskLifecycle(
		event: string,
		input: Partial<Omit<CaptureTaskLifecycleEventInput, "event">> = {},
	): void {
		const sessionId = trimNonEmpty(this.config.sessionId);
		captureTaskLifecycleEvent(this.config.telemetry, {
			event,
			sessionId,
			ulid: sessionId,
			agentId: this.state.agentId,
			conversationId: trimNonEmpty(this.config.conversationId),
			runId: this.state.runId,
			iteration: this.state.iteration > 0 ? this.state.iteration : undefined,
			providerId: this.getTelemetryProviderId(),
			modelId: this.getTelemetryModelId(),
			...input,
		});
	}

	private getTelemetryProviderId(): string | undefined {
		return (
			trimNonEmpty(this.config.messageModelInfo?.provider) ??
			this.telemetryProviderId
		);
	}

	private getTelemetryModelId(): string | undefined {
		return (
			trimNonEmpty(this.config.messageModelInfo?.id) ?? this.telemetryModelId
		);
	}

	private isAbortError(error: unknown): boolean {
		return (
			error instanceof AgentRuntimeAbortError ||
			this.abortController?.signal.aborted === true
		);
	}

	private captureUnexpectedReasoningTokens(
		request: AgentModelRequest,
		metrics: NonNullable<AgentMessage["metrics"]>,
	): void {
		if (
			!reasoningWasRequestedOff(request) ||
			(metrics.reasoningTokenCount ?? 0) <= 0
		) {
			return;
		}
		const reasoningTokenCount = metrics.reasoningTokenCount;
		if (reasoningTokenCount === undefined) {
			return;
		}

		captureAgentUnexpectedReasoningTokens(this.config.telemetry, {
			sessionId: this.config.sessionId,
			agentId: this.state.agentId,
			runId: this.state.runId,
			iteration: this.state.iteration,
			providerId: this.config.messageModelInfo?.provider,
			modelId: this.config.messageModelInfo?.id,
			requestedThinking: false,
			reasoningTokenCount,
		});
	}

	private async prepareTurnForModelRequest(
		request: AgentModelRequest,
		options?: { overflowRecovery?: boolean; requireSmallerRequest?: boolean },
	): Promise<AgentModelRequest> {
		if (!this.config.prepareTurn) {
			return request;
		}

		const overflowRecovery = options?.overflowRecovery === true;
		// Whether compaction finding nothing to remove is fatal.
		//
		// It is when the provider has already rejected the request: resending an
		// identical one fails identically. It is not when the last turn merely ran
		// past its output cap -- the transcript may be nowhere near full, and a
		// long reply to a short prompt is exactly that case. Treating the two the
		// same turns a retryable turn into a dead run.
		const requireSmallerRequest = options?.requireSmallerRequest === true;
		const result = await this.config.prepareTurn({
			agentId: this.state.agentId,
			conversationId: this.config.conversationId,
			parentAgentId: this.state.parentAgentId ?? null,
			iteration: this.state.iteration,
			messages: request.messages,
			systemPrompt: request.systemPrompt,
			tools: request.tools,
			model: {
				id: this.config.messageModelInfo?.id,
				provider: this.config.messageModelInfo?.provider,
			},
			signal: request.signal,
			overflowRecovery: overflowRecovery || undefined,
			previousRequestInputTokens:
				this.state.lastRequestInputTokens > 0
					? this.state.lastRequestInputTokens
					: undefined,
			emitStatusNotice: (message, metadata) => {
				void this.emit({
					type: "status-notice",
					snapshot: this.snapshot(),
					message,
					metadata,
				});
			},
			// A compaction's calls, as each finishes: the agent's to pay for.
			reportUsage: (usage) => {
				void this.updateUsage(usage, undefined, { auxiliary: true });
			},
		});
		if (requireSmallerRequest) {
			// Only retry a provider-rejected overflow with a request that is
			// actually smaller — anything else is guaranteed to fail again.
			//
			// Serialized length is a coarse proxy for tokens, which is all this
			// backstop needs: it answers "did anything get removed at all" for
			// arbitrary `prepareTurn` implementations, and the shared estimator
			// is itself linear in character count, so switching units would not
			// change the verdict. Authoritative token budgeting (against the
			// model's limit) happens inside the compaction pipeline.
			// TODO: have `prepareTurn` report the token estimates it already
			// computed (before/after) so this decision can use real numbers
			// instead of re-deriving a proxy here.
			const shrunk =
				result?.messages !== undefined &&
				JSON.stringify(result.messages).length <
					JSON.stringify(request.messages).length;
			if (!shrunk) {
				throw new ContextWindowOverflowError(
					CONTEXT_WINDOW_OVERFLOW_NOTHING_TO_COMPACT_MESSAGE,
					this.state.lastError,
				);
			}
		}
		if (!result) {
			return request;
		}

		let next = request;
		if (result.messages) {
			const preparedMessages = cloneMessages(result.messages);
			next = { ...next, messages: cloneMessages(preparedMessages) };
		}
		if (result.systemPrompt !== undefined) {
			next = { ...next, systemPrompt: result.systemPrompt };
		}
		return next;
	}

	private async consumePendingUserMessage(): Promise<AgentMessage | undefined> {
		const consumePendingUserMessage = this.config.consumePendingUserMessage;
		if (!consumePendingUserMessage) {
			return undefined;
		}
		const pending = (await consumePendingUserMessage())?.trim();
		if (!pending) {
			return undefined;
		}
		const message = createMessage("user", [{ type: "text", text: pending }], {
			userRunSpan: 0,
		});
		// A message sent mid-run is an interjection, not a new instruction: the
		// work it interrupted is still outstanding. See the resume nudge below.
		this.steerAwaitingResume = true;
		this.state.messages.push(message);
		await this.emit({
			type: "message-added",
			snapshot: this.snapshot(),
			message,
		});
		return message;
	}

	private async updateUsage(
		usage: Partial<AgentUsage>,
		timings?: RequestTimings,
		options?: { auxiliary?: boolean; outputSplit?: OutputTokenSplit },
	): Promise<void> {
		const auxiliary = options?.auxiliary === true;
		this.state.usage = {
			inputTokens: this.state.usage.inputTokens + (usage.inputTokens ?? 0),
			outputTokens: this.state.usage.outputTokens + (usage.outputTokens ?? 0),
			cacheReadTokens:
				this.state.usage.cacheReadTokens + (usage.cacheReadTokens ?? 0),
			cacheWriteTokens:
				this.state.usage.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
			reasoningTokenCount:
				(this.state.usage.reasoningTokenCount ?? 0) +
				(usage.reasoningTokenCount ?? 0),
			totalCost: (this.state.usage.totalCost ?? 0) + (usage.totalCost ?? 0),
		};
		// Not accumulated with the totals above, and deliberately: durations and
		// rates do not add up across requests, so this describes the single
		// request this update came from and is replaced by the next one.
		if (timings) {
			this.state.lastRequestTimings = timings;
		}
		// Not the agent's request: a compaction's call says nothing about the
		// window the agent's next request will be sized against.
		if (usage.inputTokens !== undefined && !auxiliary) {
			this.lastRequestTokens =
				(usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
		}
		await this.emit({
			type: "usage-updated",
			snapshot: this.snapshot(),
			usage: cloneUsage(this.state.usage),
			...(timings ? { timings } : {}),
			...(options?.outputSplit ? { outputSplit: options.outputSplit } : {}),
			...(auxiliary ? { auxiliary: true } : {}),
		});
	}

	private async executeToolCalls(
		toolCalls: AgentToolCallPart[],
	): Promise<AgentMessage[]> {
		this.pendingHookContexts = [];
		const prepared: PreparedToolExecution[] = [];
		for (const toolCall of toolCalls) {
			const preparedAt = Date.now();
			const execution = await this.prepareToolExecution(toolCall);
			execution.prepareMs = Date.now() - preparedAt;
			prepared.push(execution);
		}

		// Results are written back at their own index, so the returned array is
		// in the order the model asked for whatever order the work finishes in.
		// `findCompletingToolMessage` pairs by index and the transcript is read
		// as a sequence, so anything else would reorder the record of a turn.
		const results = new Array<AgentMessage>(prepared.length);

		// A tool that bounds its own concurrency is not bounded again here.
		// Delegation is the case: how many agents run at once is the node
		// placement queue's answer and then the engine's, and putting them
		// behind this pool as well ran forty requested agents eight wide on two
		// uncapped PolyKV nodes. They start together and wait where their own
		// gate says to. Only when parallel execution is on at all -- an
		// explicit `sequential` still means one at a time, for everything.
		const pooled: number[] = [];
		const selfGated: number[] = [];
		const parallel = this.config.maxParallelToolCalls > 1;
		prepared.forEach((execution, index) => {
			const tool = this.tools.get(execution.toolCall.toolName);
			(parallel && tool?.lifecycle?.boundsOwnConcurrency === true
				? selfGated
				: pooled
			).push(index);
		});
		const running = selfGated.map(async (index) => {
			results[index] = await this.executePreparedTool(prepared[index]);
		});

		const bound = Math.min(
			Math.max(1, this.config.maxParallelToolCalls),
			pooled.length,
		);
		if (bound <= 1) {
			for (const index of pooled) {
				results[index] = await this.executePreparedTool(prepared[index]);
			}
			await Promise.all(running);
			return results;
		}

		// A bounded pool rather than one `Promise.all` over everything: the
		// number is a cap on what the endpoint, the disk and the host are asked
		// to do at once, and a model that sends twenty calls in one message
		// should not open twenty at once because it can.
		let next = 0;
		const worker = async (): Promise<void> => {
			while (true) {
				const slot = next;
				next += 1;
				if (slot >= pooled.length) {
					return;
				}
				const index = pooled[slot];
				results[index] = await this.executePreparedTool(prepared[index]);
			}
		};
		await Promise.all([
			...Array.from({ length: bound }, () => worker()),
			...running,
		]);
		return results;
	}

	private findCompletingToolMessage(
		toolCalls: AgentToolCallPart[],
		toolMessages: AgentMessage[],
	): AgentMessage | undefined {
		for (let index = 0; index < toolCalls.length; index += 1) {
			const toolCall = toolCalls[index];
			if (this.tools.get(toolCall.toolName)?.lifecycle?.completesRun !== true) {
				continue;
			}
			const toolMessage = toolMessages[index];
			const result = toolMessage?.content.find(
				(part): part is Extract<AgentMessagePart, { type: "tool-result" }> =>
					part.type === "tool-result" &&
					part.toolCallId === toolCall.toolCallId,
			);
			if (result && !result.isError) {
				return toolMessage;
			}
		}
		return undefined;
	}

	private async prepareToolExecution(
		toolCall: AgentToolCallPart,
	): Promise<PreparedToolExecution> {
		const tool = this.tools.get(toolCall.toolName);
		let input = toolCall.input;
		let skipReason: string | undefined;
		const metadata =
			toolCall.metadata &&
			typeof toolCall.metadata === "object" &&
			!Array.isArray(toolCall.metadata)
				? (toolCall.metadata as Record<string, unknown>)
				: undefined;

		if (typeof metadata?.inputParseError === "string") {
			skipReason = metadata.inputParseError;
		}
		// A tool the session withholds on purpose has a reason, and the reason
		// is the only part of the rejection a model can act on. Reported
		// 2026-10-09: `spawn_agent` withheld on a one-request endpoint, the
		// rejection listed forty tool names and no cause, and the model sent the
		// same call again.
		const unavailableReason = tool
			? undefined
			: this.config.unavailableToolReasons?.[toolCall.toolName];
		if (unavailableReason) {
			skipReason = `Tool "${toolCall.toolName}" is not offered in this session: ${unavailableReason}`;
		}

		const toolSource =
			metadata?.toolSource &&
			typeof metadata.toolSource === "object" &&
			!Array.isArray(metadata.toolSource)
				? (metadata.toolSource as Record<string, unknown>)
				: undefined;
		if (toolSource?.executionMode === "provider") {
			const providerId =
				typeof toolSource.providerId === "string"
					? toolSource.providerId
					: "provider";
			skipReason = `Tool execution is disabled for provider ${providerId}`;
		}

		if (tool && !skipReason) {
			input = normalizeJsonLikeStringsForSchema(input, tool.inputSchema);
		}

		let policyOverride: ToolPolicy | undefined;
		if (tool && !skipReason) {
			for (const hook of this.hooks.beforeTool) {
				const result = (await hook({
					snapshot: this.snapshot(),
					tool,
					toolCall: { ...toolCall, input },
					input,
				})) as AgentBeforeToolResult | undefined;
				if (result?.input !== undefined) {
					input = result.input;
				}
				if (result?.policy) {
					policyOverride = {
						...policyOverride,
						...result.policy,
					};
				}
				if (result?.appendContext?.trim()) {
					this.pendingHookContexts.push(
						formatHookContextBlock(
							{ source: "PreToolUse", toolCall },
							result.appendContext,
						),
					);
				}
				this.applyStopControl(result);
				if (result?.skip) {
					skipReason =
						result.reason ?? `Tool ${tool.name} was blocked by a runtime hook`;
					break;
				}
			}
		}

		if (tool && !skipReason) {
			const policy = {
				...resolveToolPolicy(toolCall.toolName, this.config.toolPolicies),
				...policyOverride,
			};
			if (policy.enabled === false) {
				skipReason = `Tool "${toolCall.toolName}" is disabled by policy`;
			} else if (policy.autoApprove === false) {
				const approval = await this.requestToolApproval(
					toolCall,
					input,
					policy,
				);
				if (!approval.approved) {
					const reason = approval.reason ?? "Tool was not executed";
					skipReason = `${reason} -- ${TOOL_REJECTION_SUFFIX}`;
				}
			}
		}

		return {
			toolCall: { ...toolCall, input },
			tool,
			input,
			skipReason,
		};
	}

	private async requestToolApproval(
		toolCall: AgentToolCallPart,
		input: unknown,
		policy: ToolPolicy,
	): Promise<ToolApprovalResult> {
		const requestApproval = this.config.requestToolApproval;
		if (!requestApproval) {
			return {
				approved: false,
				reason: `Tool "${toolCall.toolName}" requires approval but no approval callback is configured`,
			};
		}
		try {
			return await requestApproval({
				sessionId:
					this.config.sessionId?.trim() ||
					this.config.conversationId?.trim() ||
					this.state.runId ||
					this.state.agentId,
				agentId: this.state.agentId,
				conversationId:
					this.config.conversationId?.trim() ||
					this.state.runId ||
					this.state.agentId,
				iteration: this.state.iteration,
				toolCallId: toolCall.toolCallId,
				toolName: toolCall.toolName,
				input,
				policy,
			});
		} catch (error) {
			return {
				approved: false,
				reason: `Tool "${toolCall.toolName}" approval request failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
	}

	private async executePreparedTool(
		prepared: PreparedToolExecution,
	): Promise<AgentMessage> {
		const startedAt = new Date();
		const phaseT0 = Date.now();
		await this.emit({
			type: "tool-started",
			snapshot: this.snapshot(),
			iteration: this.state.iteration,
			toolCall: prepared.toolCall,
		});
		const phaseT1 = Date.now();

		let result: AgentToolResult;
		if (prepared.skipReason) {
			result = {
				output: { error: prepared.skipReason },
				isError: true,
			};
		} else if (!prepared.tool) {
			result = {
				output: { error: `Unknown tool: ${prepared.toolCall.toolName}` },
				isError: true,
			};
		} else {
			try {
				const output = await prepared.tool.execute(prepared.input, {
					sessionId: this.config.sessionId,
					agentId: this.state.agentId,
					conversationId: this.config.conversationId,
					runId: this.state.runId ?? createUID("run"),
					iteration: this.state.iteration,
					toolCallId: prepared.toolCall.toolCallId,
					signal: this.abortController?.signal,
					metadata: this.config.toolContextMetadata,
					snapshot: this.snapshot(),
					reportStoppedForUser: () => {
						this.stoppedForUserBy = prepared.toolCall.toolName;
					},
					emitUpdate: (update: unknown) => {
						void this.emit({
							type: "tool-updated",
							snapshot: this.snapshot(),
							iteration: this.state.iteration,
							toolCall: prepared.toolCall,
							update,
						});
					},
				});
				result = { output };
				if (
					this.stoppedForUserBy !== undefined &&
					this.stoppedForUserBy !== prepared.toolCall.toolName &&
					prepared.tool.readOnly !== true
				) {
					this.stoppedForUserBy = undefined;
				}
			} catch (error) {
				result = {
					output: {
						error: error instanceof Error ? error.message : String(error),
					},
					isError: true,
				};
			}
		}

		const endedAt = new Date();
		const phaseT2 = Date.now();
		const durationMs = Math.max(0, endedAt.getTime() - startedAt.getTime());

		if (prepared.tool) {
			for (const hook of this.hooks.afterTool) {
				const after = (await hook({
					snapshot: this.snapshot(),
					tool: prepared.tool,
					toolCall: prepared.toolCall,
					input: prepared.input,
					result,
					startedAt,
					endedAt,
					durationMs,
				})) as AgentAfterToolResult | undefined;
				if (after?.appendContext?.trim()) {
					this.pendingHookContexts.push(
						formatHookContextBlock(
							{ source: "PostToolUse", toolCall: prepared.toolCall },
							after.appendContext,
						),
					);
				}
				this.applyStopControl(after);
				if (after?.result) {
					result = after.result;
				}
			}
		}

		// One line per tool call, never per token: the debug default that logged
		// every delta put 260,774 of 261,885 lines in one session and took the
		// extension host down with it. Numbers go in the message because the
		// output channel does not render the metadata object.
		this.trace(
			`tool ${prepared.toolCall.toolName} ` +
				`prepare=${prepared.prepareMs ?? -1}ms ` +
				`preEmit=${phaseT1 - phaseT0}ms ` +
				`exec=${phaseT2 - phaseT1}ms ` +
				`afterHooks=${Date.now() - phaseT2}ms ` +
				`total=${Date.now() - phaseT0}ms ` +
				`| hooks ${this.topEventHooks()}`,
		);
		this.config.logger?.debug?.(
			`[tool-timing] ${prepared.toolCall.toolName} ` +
				`prepare=${prepared.prepareMs ?? -1}ms ` +
				`preEmit=${phaseT1 - phaseT0}ms ` +
				`exec=${phaseT2 - phaseT1}ms ` +
				`afterHooks=${Date.now() - phaseT2}ms ` +
				`total=${Date.now() - phaseT0}ms ` +
				`| hooks ${this.topEventHooks()}`,
		);

		const message = createMessage("tool", [
			{
				type: "tool-result",
				toolCallId: prepared.toolCall.toolCallId,
				toolName: prepared.toolCall.toolName,
				output: result.output,
				isError: result.isError,
			},
		]);

		await this.emit({
			type: "tool-finished",
			snapshot: this.snapshot(),
			iteration: this.state.iteration,
			toolCall: prepared.toolCall,
			message,
		});

		return message;
	}

	private finishRun(
		status: AgentRunResult["status"],
		assistantMessage?: AgentMessage,
		outputText?: string,
	): AgentRunResult {
		this.state.status = status;
		return {
			agentId: this.state.agentId,
			agentRole: this.state.agentRole,
			runId: this.state.runId ?? createUID("run"),
			status,
			iterations: this.state.iteration,
			outputText:
				outputText ??
				textFromMessage(assistantMessage ?? this.findLastAssistantMessage()),
			messages: cloneMessages(this.state.messages),
			usage: cloneUsage(this.state.usage),
		};
	}

	private findLastAssistantMessage(): AgentMessage | undefined {
		return [...this.state.messages]
			.reverse()
			.find((message) => message.role === "assistant");
	}

	/**
	 * A reasoning block collapsed into repetition and the request was cut.
	 *
	 * The turn keeps whatever it produced before the cut and continues, so the
	 * model gets a chance to recover -- but a model that collapses the same way
	 * every turn is not recovering, and the streak ends the run.
	 */
	private async onReasoningLoopCut(
		verdict: ReasoningLoopVerdict,
	): Promise<void> {
		this.reasoningLoopStreak += 1;
		const limit =
			(this.config.reasoningLoopDetection === false
				? undefined
				: this.config.reasoningLoopDetection?.maxConsecutiveTrips) ??
			DEFAULT_REASONING_LOOP_GUARD.maxConsecutiveTrips;
		const diagnosis = describeReasoningLoop(verdict);
		const atLimit = this.reasoningLoopStreak >= limit;
		// Asked before the run ends rather than after, so the notice below says
		// what actually happened. The streak is deliberately not reset by a
		// `continue`: the guard is deferred, never removed, and the next turn cut
		// the same way arrives back here with the decision already spent.
		const decision = atLimit
			? await this.config.onReasoningLoopLimitReached?.({
					iteration: this.state.iteration,
					consecutiveTrips: this.reasoningLoopStreak,
					maxConsecutiveTrips: limit,
					diagnosis,
				})
			: undefined;
		const guidance =
			decision?.action === "continue" ? decision.guidance?.trim() : undefined;
		const giveUp = atLimit && decision?.action !== "continue";
		await this.emit({
			type: "status-notice",
			snapshot: this.snapshot(),
			message: giveUp
				? `${diagnosis} Ending the run after ${this.reasoningLoopStreak} turns cut for this.`
				: atLimit
					? `${diagnosis} That is ${this.reasoningLoopStreak} turns cut for this, and the run was to end here.`
					: `${diagnosis} Cutting the request and continuing.`,
			metadata: {
				kind: "reasoning_loop",
				reason: "reasoning_loop",
				phase: giveUp ? "aborted" : "cut",
				iteration: this.state.iteration,
				consecutiveTrips: this.reasoningLoopStreak,
				verdict,
			},
		});
		if (giveUp) {
			this.abort(new AgentRuntimeAbortError(diagnosis));
			this.throwIfAborted();
			return;
		}
		if (guidance) {
			// A user message, the way the mistake limit delivers its own
			// guidance: the model is about to draw again, and this is the only
			// channel the next request is certain to carry.
			await this.addUserReminderMessage(guidance);
		}
	}

	/** Every argument name of every tool this run may call. */
	private toolArgumentNames(): string[] {
		const names = new Set<string>();
		for (const tool of this.tools.values()) {
			const properties = (
				tool.inputSchema as { properties?: Record<string, unknown> } | undefined
			)?.properties;
			for (const name of Object.keys(properties ?? {})) {
				names.add(name);
			}
		}
		return [...names];
	}

	/**
	 * A tool call's `intent` ran past its limit and the request was cut.
	 *
	 * Nothing is counted and nothing ends the run: the cut is what bounds the
	 * cost, and each one is a few hundred tokens where the uncut call was tens
	 * of thousands.
	 */
	private async onToolIntentCut(overrun: ToolIntentOverrun): Promise<void> {
		this.toolIntentCutStreak += 1;
		this.pendingToolIntentNudge = buildToolIntentOverrunNudge(overrun);
		const called = overrun.toolName ? `\`${overrun.toolName}\`` : "a tool";
		this.config.logger?.log?.(
			`[tool-intent] cut a call to ${called} at iteration ${this.state.iteration}: intent passed ${overrun.maxChars} characters`,
		);
		await this.emit({
			type: "status-notice",
			snapshot: this.snapshot(),
			message: `The model was writing its reasoning into the \`intent\` of a call to ${called} (past ${overrun.maxChars.toLocaleString("en-US")} characters). Cutting the request and asking it to make the call again.`,
			metadata: {
				kind: "tool_intent_overrun",
				reason: "tool_intent_overrun",
				phase: "cut",
				iteration: this.state.iteration,
				overrun,
			},
		});
	}

	private throwIfAborted(): void {
		if (this.abortController?.signal.aborted) {
			throw this.normalizeAbortError();
		}
	}

	private normalizeAbortError(): Error {
		const reason = this.abortController?.signal.reason;
		if (reason instanceof Error) {
			return reason;
		}
		if (typeof reason === "string") {
			return new Error(reason);
		}
		return new Error(this.state.lastError ?? "Run aborted");
	}

	/**
	 * Per-hook time spent inside `emit`, keyed `"<event type>#<hook index>"`.
	 *
	 * Instrumentation for the ~660ms floor every tool call pays even when the
	 * tool does nothing: `task_progress` and `plan` write a string and still
	 * took 661ms and 662ms at the median across 19,803 archived calls, and the
	 * post-tool client gap is only 29ms, so the cost is inside the call. `emit`
	 * awaits every `onEvent` hook in series and is awaited twice per tool, which
	 * is the right shape for it. Totals are kept per hook because naming the
	 * slow one is the whole point.
	 */
	private readonly eventHookMs = new Map<string, { ms: number; n: number }>();

	private noteEventHookMs(
		eventType: string,
		index: number | string,
		ms: number,
	): void {
		const key = `${eventType}#${index}`;
		const slot = this.eventHookMs.get(key);
		if (slot) {
			slot.ms += ms;
			slot.n += 1;
		} else {
			this.eventHookMs.set(key, { ms, n: 1 });
		}
	}

	/** The hooks that cost the most, worst first, as `key=total/count`. */
	private topEventHooks(limit = 4): string {
		return [...this.eventHookMs.entries()]
			.sort((a, b) => b[1].ms - a[1].ms)
			.slice(0, limit)
			.map(([key, v]) => `${key}=${Math.round(v.ms)}ms/${v.n}`)
			.join(" ");
	}

	/**
	 * One boundary of the agent loop, to stderr under `CLINE_TIMING` and to the
	 * logger's debug channel always.
	 *
	 * Both, because the two runners surface different halves: the CLI wires no
	 * debug channel at all (an instrumented run through it produced zero lines),
	 * and the extension host has no stderr a tester can read. The volume is one
	 * line per turn and per tool call — not per token, which is the mistake that
	 * put 260,774 lines in one session.
	 */
	private trace(line: string): void {
		timingTrace(line);
		this.config.logger?.debug?.(`[timing] ${line}`);
	}

	private async emit(event: AgentRuntimeEvent): Promise<void> {
		const metadata = buildEventMetadata(event);
		switch (event.type) {
			case "run-started":
				// Verbatim clinee calls `logger?.info?.(...)`. sdk-re's
				// `BasicLogger` does not declare `info` (it uses `log`), so
				// we narrow to an optional-info shape at the call site to
				// preserve the clinee runtime contract without mutating
				// shared's `BasicLogger` interface.
				(
					this.config.logger as
						| {
								info?: (msg: string, md?: unknown) => void;
						  }
						| undefined
				)?.info?.("Agent run started", metadata);
				break;
			case "tool-finished":
				(
					this.config.logger as
						| {
								info?: (msg: string, md?: unknown) => void;
						  }
						| undefined
				)?.info?.("Agent tool finished", metadata);
				break;
			case "run-failed":
				this.config.logger?.error?.("Agent run failed", {
					...metadata,
					error: event.error,
				});
				// Failures the model layer already recorded at its own error
				// boundary (`provider.stream`, carried across the stream's
				// string-flattening boundary as `finish.errorReported`) must not
				// be re-reported here — that exactly doubled `sdk.error` volume.
				// Everything else still reports: loop-originated failures, and
				// failures from model implementations that do not record their
				// own telemetry.
				if (!this.state.lastErrorReported) {
					captureSdkError(this.config.telemetry, {
						component: "agents",
						operation: "agent.run",
						error: event.error,
						severity: "error",
						handled: false,
						context: {
							...(metadata as TelemetryProperties),
							providerId: this.getTelemetryProviderId(),
							modelId: this.getTelemetryModelId(),
							...(this.state.lastFinishReason
								? { finishReason: this.state.lastFinishReason }
								: {}),
						},
					});
				}
				break;
			default:
				// Same exclusion as telemetry's, one switch down, and for a
				// sharper reason: this is the *log*. A pandorum session wrote
				// 260,774 of its 261,885 lines here, 64,809 of them in the last
				// turn before the extension host stopped responding and was
				// terminated. Listeners and hooks still receive every delta; the
				// line said nothing but "Agent event" anyway, because the type is
				// in the metadata the output channel never renders -- so it now
				// names the event and skips the per-token ones.
				if (!HIGH_VOLUME_STREAM_EVENTS.has(event.type)) {
					this.config.logger?.debug?.(`Agent event: ${event.type}`, metadata);
				}
				break;
		}
		switch (event.type) {
			// Per-token/per-chunk stream events are ~97% of agent.* telemetry
			// volume and are never queried, so they are not mirrored to
			// telemetry. Listeners and hooks below still receive them.
			case "assistant-text-delta":
			case "assistant-reasoning-delta":
			case "assistant-media":
			case "tool-updated":
				break;
			default:
				this.config.telemetry?.capture({
					event: `agent.${event.type}`,
					properties: metadata as TelemetryProperties,
				});
				break;
		}
		// Listeners are timed alongside the hooks because the extension's whole
		// UI bridge hangs off one: the plugin's log shows a flat ~300ms of
		// silence between `assistant-message` being emitted and the next line
		// anything writes, twice per tool call. A listener is called, not
		// awaited, so nothing here waits for it -- but synchronous work inside
		// one blocks the loop just the same, and only a number distinguishes
		// the two.
		let listenerIndex = 0;
		for (const listener of this.listeners) {
			const listenerStartedAt = Date.now();
			listener(event);
			this.noteEventHookMs(
				event.type,
				`listener${listenerIndex}`,
				Date.now() - listenerStartedAt,
			);
			listenerIndex += 1;
		}
		// Instrumented: every tool call awaits this loop twice (tool-started and
		// the tool-updated/finished path), so a slow hook is paid per tool, not
		// per turn. Measured per hook rather than in total because the point is
		// to name which one -- a total says only that the loop is the cost.
		for (let index = 0; index < this.hooks.onEvent.length; index += 1) {
			const hookStartedAt = Date.now();
			await this.hooks.onEvent[index](event);
			this.noteEventHookMs(event.type, index, Date.now() - hookStartedAt);
		}
	}

	private applyStopControl(
		control: AgentStopControl | undefined | undefined,
	): void {
		if (!control?.stop) {
			return;
		}
		if (control.reason) {
			this.state.lastError = control.reason;
		}
		throw new ControlledStopError(control.reason);
	}
}

/**
 * The per-token/per-chunk events, named once for the two places that skip them.
 *
 * They are ~97% of the event volume, they carry nothing a reader of either the
 * log or the telemetry can act on, and one of them per token is what turns a
 * debug channel into a denial of service against the process writing it.
 */
/**
 * What each nudge says to a reader, as against what it is keyed on.
 *
 * Every other status notice on this path is a sentence -- "context window
 * exceeded — compacting and retrying", "the model's tool call did not parse —
 * asking for it again" -- and the nudges alone rendered the raw slug, which
 * reached the UI as `nudged: no_tool_call` and told nobody anything. The slug
 * stays in the metadata, which is what it exists for: the event stream is there
 * so these thresholds can be tuned against a corpus, and a description is no
 * use for that.
 *
 * A slug with no entry falls back to the old wording rather than rendering
 * blank: a nudge added later must still show up, just less prettily.
 */
const NUDGE_DESCRIPTIONS: Readonly<Record<string, string>> = {
	no_tool_call:
		"the turn ended without calling anything — asking the model to carry on",
	unparsed_tool_call:
		"a tool call was written as text and never ran — asking for it again",
	announced_intent:
		"the model described the next step instead of taking it — asking it to make the call",
	non_convergence:
		"several turns of thinking with no work done — asking for a different approach",
	silent_repetition:
		"the turn repeated what the last one said — asking for a different approach",
};

function describeNudge(nudge: string): string {
	return NUDGE_DESCRIPTIONS[nudge] ?? `nudged: ${nudge}`;
}

const HIGH_VOLUME_STREAM_EVENTS: ReadonlySet<string> = new Set([
	"assistant-text-delta",
	"assistant-reasoning-delta",
	"assistant-media",
	"tool-updated",
]);

function buildEventMetadata(event: AgentRuntimeEvent): Record<string, unknown> {
	return {
		agentId: event.snapshot.agentId,
		agentRole: event.snapshot.agentRole,
		runId: event.snapshot.runId,
		status: event.snapshot.status,
		iteration: event.snapshot.iteration,
		eventType: event.type,
	};
}

export function createAgentRuntime(config: AgentRuntimeConfig): AgentRuntime {
	return new AgentRuntime(config);
}

/**
 * `Agent` is the user-friendly name for `AgentRuntime`. They are the same
 * class; this alias exists so standalone callers can write:
 *
 *     const agent = new Agent({ providerId, modelId, apiKey });
 *     await agent.run("hello");
 *
 * while `@cline/core` (which owns model construction) continues to use
 * the `AgentRuntime` name with `{ model, ... }` configs.
 */
export const Agent = AgentRuntime;
export type Agent = AgentRuntime;

export function createAgent(config: AgentRuntimeConfig): AgentRuntime {
	return new AgentRuntime(config);
}

/**
 * What identifies an unreadable call, for telling a repeat from a new one.
 *
 * The call block alone, from its first opening marker: the sentence a model
 * writes before the block changes from turn to turn while the block it then
 * writes is the same one. Whitespace is not part of the identity either.
 */
function fingerprintUnreadableCall(text: string): string {
	const open = text.search(/<\|?tool_call\|?>/);
	const block = (open < 0 ? text : text.slice(open))
		.replace(/\s+/g, " ")
		.trim();
	let hash = 5381;
	for (let i = 0; i < block.length; i++) {
		hash = ((hash << 5) + hash + block.charCodeAt(i)) | 0;
	}
	return `${block.length}:${hash}`;
}

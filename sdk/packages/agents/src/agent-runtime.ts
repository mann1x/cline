import {
	classifyProviderError,
	createGateway,
	type GatewayProviderSettings,
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
	ProviderErrorClass,
	TelemetryProperties,
	ToolApprovalResult,
	ToolPolicy,
} from "@cline/shared";
import {
	captureAgentUnexpectedReasoningTokens,
	captureSdkError,
	captureTaskLifecycleEvent,
	estimateTokens,
	lastOutputCap,
	mergeModelOptions,
	NO_TOOL_CALL_NUDGE_MESSAGE,
	normalizeJsonLikeStringsForSchema,
	omitUndefinedValues,
	TASK_CANCELLED_EVENT,
	TASK_FIRST_CHUNK_RECEIVED_EVENT,
	TASK_PROVIDER_REQUEST_STARTED_EVENT,
	TASK_PROVIDER_STREAM_FAILED_EVENT,
	TASK_PROVIDER_STREAM_STARTED_EVENT,
	trimNonEmpty,
} from "@cline/shared";
import { nanoid } from "nanoid";

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

const TOOL_CALL_UNPARSABLE_REMINDER =
	"[SYSTEM] Your last tool call did not parse, so it never ran and nothing was changed by it. " +
	"The text you wrote before it is still here and still correct — the call around it was malformed, most often because it was cut short. " +
	"Send that one call again, complete, and nothing else in this reply. " +
	"If it carries a large argument, make the argument smaller rather than sending the same one again: name a line range instead of a whole file, or split the work across two calls.";

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

interface PendingToolAssembly {
	toolCallId: string;
	toolName?: string;
	inputText: string;
	inputValue?: unknown;
	metadata?: unknown;
	parseError?: string;
}

interface InvalidToolCall {
	toolCallId: string;
	toolName?: string;
	input: Record<string, unknown>;
	reason: "missing_name" | "missing_arguments" | "invalid_arguments";
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

export class AgentRuntime {
	private config: Required<Pick<BaseAgentRuntimeConfig, "toolExecution">> &
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
		lastError: undefined as string | undefined,
		lastErrorClass: undefined as ProviderErrorClass | undefined,
	};
	/** One automatic overflow-recovery attempt per run. */
	private overflowRecoveryAttempted = false;
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
		this.config = {
			...resolved,
			toolExecution: resolved.toolExecution ?? "sequential",
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
		this.state.messages = cloneMessages(messages);
		this.config = {
			...this.config,
			initialMessages: cloneMessages(messages),
		};
	}

	snapshot(): AgentRuntimeStateSnapshot {
		return {
			agentId: this.state.agentId,
			agentRole: this.state.agentRole,
			parentAgentId: this.state.parentAgentId,
			conversationId: this.config.conversationId?.trim() || undefined,
			runId: this.state.runId,
			status: this.state.status,
			iteration: this.state.iteration,
			messages: cloneMessages(this.state.messages),
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

	private getCompletionReminderMessages(): string[] {
		return [
			this.getCompletionToolReminderMessage(),
			this.config.completionPolicy?.completionGuard?.(),
		].filter((message): message is string => Boolean(message));
	}

	/**
	 * The nudge for a turn that produced no tool calls, or undefined once the
	 * consecutive limit is reached and the run should be allowed to end.
	 */
	private getNoToolCallNudgeMessage(): string | undefined {
		const budget = this.config.completionPolicy?.maxNoToolCallNudges ?? 0;
		return this.consecutiveNoToolCallNudges < budget
			? NO_TOOL_CALL_NUDGE_MESSAGE
			: undefined;
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
			const condensation = await condense({
				reasoning,
				...(text ? { text } : {}),
				windowBound,
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

	private async addUserReminderMessage(text: string): Promise<AgentMessage> {
		const reminderMessage = createMessage("user", [{ type: "text", text }], {
			userRunSpan: 0,
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
		this.state.usage = cloneUsage(DEFAULT_USAGE);
		this.overflowRecoveryAttempted = false;
		this.compactBeforeNextTurn = false;
		this.imageRecoveryAttempted = false;
		this.steerAwaitingResume = false;

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

			let finalAssistantMessage: AgentMessage | undefined;

			while (
				this.config.maxIterations === undefined ||
				this.state.iteration < this.config.maxIterations
			) {
				this.throwIfAborted();

				this.state.iteration += 1;
				await this.emit({
					type: "turn-started",
					snapshot: this.snapshot(),
					iteration: this.state.iteration,
				});

				const usageBeforeTurn = cloneUsage(this.state.usage);
				const { message, finishReason } =
					await this.generateAssistantMessageWithOverflowRecovery();
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
					throw new Error(
						finishReason === "error"
							? (this.state.lastError ?? "Model stream failed")
							: "Model returned empty response",
					);
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
					const outputCap = lastOutputCap();
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
							outputCapSource: outputCap?.source ?? "unknown",
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
					);
					continue;
				}

				finalAssistantMessage = message;
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

				if (finishReason === "max-tokens" && toolCalls.length === 0) {
					throw new Error(MAX_TOKENS_INCOMPLETE_TURN_MESSAGE);
				}
				if (finishReason === "error" && toolCalls.length === 0) {
					if (await this.recoverUnparsableToolCall()) {
						continue;
					}
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
					const completionReminderMessages =
						this.getCompletionReminderMessages();
					if (completionReminderMessages.length > 0) {
						for (const reminderMessage of completionReminderMessages) {
							await this.addUserReminderMessage(reminderMessage);
						}
						continue;
					}
					// A message sent while the run was going answers to the user, and
					// answering it is a turn with nothing to call — which is how a run
					// ends. Measured: asked "how many lines is manic_miner.html?" in
					// the middle of a fix, the model answered, the run stopped, and
					// the file was left half-edited until "continue fixing" was typed
					// by hand. Nobody interjecting a question means "and stop".
					if (this.steerAwaitingResume) {
						this.steerAwaitingResume = false;
						await this.addUserReminderMessage(STEER_RESUME_REMINDER);
						continue;
					}
					const noToolCallNudge = this.getNoToolCallNudgeMessage();
					if (noToolCallNudge) {
						this.consecutiveNoToolCallNudges += 1;
						await this.addUserReminderMessage(noToolCallNudge);
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
				this.consecutiveNoToolCallNudges = 0;
				// Same for truncation: a turn that reached its tool calls did not
				// run out of room, so a later one gets the full allowance again.
				this.consecutiveMaxTokensRetries = 0;
				this.truncatedOutputCapTokens = undefined;
				const toolMessages = await this.executeToolCalls(toolCalls);
				this.state.pendingToolCalls = [];
				for (const toolMessage of toolMessages) {
					this.state.messages.push(toolMessage);
					await this.emit({
						type: "message-added",
						snapshot: this.snapshot(),
						message: toolMessage,
					});
				}
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
			}

			throw new Error(
				`Agent runtime exceeded maxIterations (${this.config.maxIterations})`,
			);
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
			this.state.status = status;
			this.state.lastError = normalized.message;
			this.state.lastErrorClass = errorClass;
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

	private async callBeforeRunHooks(): Promise<void> {
		for (const hook of this.hooks.beforeRun) {
			const control = (await hook({
				snapshot: this.snapshot(),
			})) as AgentStopControl | undefined;
			this.applyStopControl(control);
		}
	}

	private async callAfterRunHooks(result: AgentRunResult): Promise<void> {
		for (const hook of this.hooks.afterRun) {
			await hook({ snapshot: this.snapshot(), result });
		}
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
			},
		});
		await this.addUserReminderMessage(TOOL_CALL_UNPARSABLE_REMINDER);
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

	private async generateAssistantMessage(options?: {
		overflowRecovery?: boolean;
		requireSmallerRequest?: boolean;
	}): Promise<{
		message: AgentMessage;
		finishReason: AgentModelFinishReason;
	}> {
		const usageBeforeModel = cloneUsage(this.state.usage);
		const modelRequestMetadata = omitUndefinedValues({
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
			})),
			signal: this.abortController?.signal,
			options: mergeModelOptions(this.config.modelOptions, {
				metadata: modelRequestMetadata,
				...(retryOutputCap !== undefined ? { maxTokens: retryOutputCap } : {}),
			}),
		};

		const taskLifecycleStartedAt = Date.now();
		const getTaskLifecycleDurationMs = () =>
			Date.now() - taskLifecycleStartedAt;

		if (this.state.iteration > 1) {
			const pendingUserMessage = await this.consumePendingUserMessage();
			if (pendingUserMessage) {
				request = {
					...request,
					messages: [
						...request.messages,
						...cloneMessages([pendingUserMessage]),
					],
				};
			}
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

		this.throwIfAborted();
		this.captureTaskLifecycle(TASK_PROVIDER_REQUEST_STARTED_EVENT, {
			durationMs: getTaskLifecycleDurationMs(),
			phase: "provider_request_started",
		});
		const stream = this.openTaskLifecycleStream(
			request,
			getTaskLifecycleDurationMs,
		);

		const content: AgentMessagePart[] = [];
		const toolAssemblies = new Map<string, PendingToolAssembly>();
		const invalidToolCalls: InvalidToolCall[] = [];
		const sequence: Array<
			{ type: "tool"; key: string } | { type: "part"; part: AgentMessagePart }
		> = [];
		let nextToolIndex = 0;
		let finishReason: AgentModelFinishReason = "stop";
		let accumulatedText = "";
		let accumulatedReasoning = "";

		for await (const event of stream) {
			this.throwIfAborted();
			switch (event.type) {
				case "text-delta": {
					accumulatedText += event.text;
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
				case "reasoning-delta": {
					accumulatedReasoning += event.text;
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
					break;
				}
				case "tool-call-delta": {
					const key =
						event.toolCallId ?? `tool_${event.index ?? nextToolIndex}`;
					if (event.index == null && event.toolCallId == null) {
						nextToolIndex += 1;
					}
					let assembly = toolAssemblies.get(key);
					if (!assembly) {
						assembly = {
							toolCallId: event.toolCallId ?? createUID("tool"),
							inputText: "",
						};
						toolAssemblies.set(key, assembly);
						sequence.push({ type: "tool", key });
					}
					if (event.toolCallId) {
						assembly.toolCallId = event.toolCallId;
					}
					if (event.toolName) {
						assembly.toolName = event.toolName;
					}
					if (event.input !== undefined) {
						assembly.inputValue = event.input;
					}
					if (event.metadata !== undefined) {
						assembly.metadata = mergeToolMetadata(
							assembly.metadata,
							event.metadata,
						);
					}
					if (event.inputText) {
						assembly.inputText = mergeToolInputText(
							assembly.inputText,
							event.inputText,
						);
					}
					break;
				}
				case "usage": {
					await this.updateUsage(event.usage);
					break;
				}
				case "finish": {
					finishReason = event.reason;
					if (event.error) {
						this.state.lastError = event.error;
						// Models that classify at their own error boundary (where the
						// raw provider error is still structured) win. Anything else —
						// custom `AgentModel` implementations, adapters that carry only
						// a flattened message — is classified from the message so it
						// stays eligible for overflow recovery.
						this.state.lastErrorClass =
							event.errorClass ?? classifyProviderError(event.error);
					}
					break;
				}
			}
		}

		for (const item of sequence) {
			if (item.type === "part") {
				content.push(item.part);
				continue;
			}
			const assembly = toolAssemblies.get(item.key);
			if (!assembly?.toolName) {
				invalidToolCalls.push({
					toolCallId: assembly?.toolCallId ?? item.key,
					input: buildInvalidToolInput(assembly?.inputText ?? ""),
					reason: "missing_name",
				});
				continue;
			}
			const parsed = parseToolInput(assembly);
			if (parsed.reason) {
				invalidToolCalls.push({
					toolCallId: assembly.toolCallId,
					toolName: assembly.toolName,
					input: parsed.invalidInput,
					reason: parsed.reason,
				});
			}
			content.push({
				type: "tool-call",
				toolCallId: assembly.toolCallId,
				toolName: assembly.toolName,
				input: parsed.input,
				metadata: parsed.parseError
					? mergeToolMetadata(assembly.metadata, {
							inputParseError: parsed.parseError,
							rawInputText: assembly.inputText,
						})
					: assembly.metadata,
			});
		}

		const message = createMessage(
			"assistant",
			content,
			invalidToolCalls.length > 0 ? { invalidToolCalls } : undefined,
		);
		const metrics = usageDelta(usageBeforeModel, this.state.usage);
		if (metrics) {
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
			})) as AgentStopControl | undefined;
			this.applyStopControl(control);
		}

		return { message, finishReason };
	}

	private async *openTaskLifecycleStream(
		request: AgentModelRequest,
		getTaskLifecycleDurationMs: () => number | undefined,
	): AsyncIterable<AgentModelEvent> {
		let stream: AsyncIterable<AgentModelEvent>;
		let phase = "provider_request_started";
		try {
			stream = await this.config.model.stream(request);
			this.throwIfAborted();
			phase = "provider_stream_started";
			this.captureTaskLifecycle(TASK_PROVIDER_STREAM_STARTED_EVENT, {
				durationMs: getTaskLifecycleDurationMs(),
				phase,
			});
		} catch (error) {
			if (!this.isAbortError(error)) {
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
			if (!this.isAbortError(error)) {
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
			emitStatusNotice: (message, metadata) => {
				void this.emit({
					type: "status-notice",
					snapshot: this.snapshot(),
					message,
					metadata,
				});
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

	private async updateUsage(usage: Partial<AgentUsage>): Promise<void> {
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
		await this.emit({
			type: "usage-updated",
			snapshot: this.snapshot(),
			usage: cloneUsage(this.state.usage),
		});
	}

	private async executeToolCalls(
		toolCalls: AgentToolCallPart[],
	): Promise<AgentMessage[]> {
		const prepared: PreparedToolExecution[] = [];
		for (const toolCall of toolCalls) {
			prepared.push(await this.prepareToolExecution(toolCall));
		}

		if (this.config.toolExecution === "parallel") {
			return Promise.all(
				prepared.map((execution) => this.executePreparedTool(execution)),
			);
		}

		const results: AgentMessage[] = [];
		for (const execution of prepared) {
			results.push(await this.executePreparedTool(execution));
		}
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
					skipReason =
						approval.reason ?? `Tool "${toolCall.toolName}" was not approved`;
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
		await this.emit({
			type: "tool-started",
			snapshot: this.snapshot(),
			iteration: this.state.iteration,
			toolCall: prepared.toolCall,
		});

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
				this.applyStopControl(after);
				if (after?.result) {
					result = after.result;
				}
			}
		}

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
				captureSdkError(this.config.telemetry, {
					component: "agents",
					operation: "agent.run",
					error: event.error,
					severity: "error",
					handled: false,
					context: metadata as TelemetryProperties,
				});
				break;
			default:
				this.config.logger?.debug?.("Agent event", metadata);
				break;
		}
		this.config.telemetry?.capture({
			event: `agent.${event.type}`,
			properties: metadata as TelemetryProperties,
		});
		for (const listener of this.listeners) {
			listener(event);
		}
		for (const hook of this.hooks.onEvent) {
			await hook(event);
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

function mergeToolMetadata(current: unknown, patch: unknown): unknown {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
		return patch;
	}
	if (!current || typeof current !== "object" || Array.isArray(current)) {
		return patch;
	}
	return {
		...(current as Record<string, unknown>),
		...patch,
	};
}

function parseToolInput(assembly: PendingToolAssembly): {
	input: unknown;
	parseError?: string;
	invalidInput: Record<string, unknown>;
	reason?: InvalidToolCall["reason"];
} {
	if (assembly.inputValue !== undefined) {
		return {
			input: assembly.inputValue,
			invalidInput: buildInvalidToolInput(JSON.stringify(assembly.inputValue)),
		};
	}
	if (!assembly.inputText.trim()) {
		return {
			input: {},
			invalidInput: {},
		};
	}
	const parsed = parseToolArguments(assembly.inputText);
	if (parsed.ok) {
		return {
			input: parsed.value,
			invalidInput: buildInvalidToolInput(assembly.inputText),
		};
	}
	return {
		input: {},
		invalidInput: buildInvalidToolInput(assembly.inputText, parsed.error),
		parseError: `Tool call ${assembly.toolName ?? assembly.toolCallId} emitted invalid JSON arguments: ${parsed.error}`,
		reason: "invalid_arguments",
	};
}

function buildInvalidToolInput(
	value: string,
	parseError?: string,
): Record<string, unknown> {
	const trimmed = value.trim();
	if (!trimmed) {
		return {};
	}
	return parseError
		? { rawInputText: value, parseError }
		: { rawInputText: value };
}

function parseToolArguments(
	value: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
	const trimmed = value.trim();
	if (!trimmed) {
		return {
			ok: false,
			error: "Tool call arguments were empty.",
		};
	}

	try {
		return { ok: true, value: JSON.parse(trimmed) };
	} catch {
		// Fall through to a normalized error below.
	}

	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
		return {
			ok: false,
			error: "Tool call arguments must be encoded as a JSON object or array.",
		};
	}

	return {
		ok: false,
		error:
			"Tool call arguments could not be parsed as JSON. Ensure the outer tool payload is valid JSON and escape embedded quotes/newlines inside string fields.",
	};
}

function mergeToolInputText(current: string, incoming: string): string {
	if (!current) {
		return incoming;
	}
	const trimmed = incoming.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return incoming;
	}
	return current + incoming;
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

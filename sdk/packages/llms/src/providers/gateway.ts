import type {
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
	BasicLogger,
	GatewayConfig,
	GatewayModelDefinition,
	GatewayModelHandleOptions,
	GatewayModelSelection,
	GatewayProviderContext,
	GatewayProviderRegistration,
	GatewayStreamRequest,
	ITelemetryService,
	OutputCapReport,
	OutputCapSource,
	ReasoningEffort,
} from "@cline/shared";
import {
	estimateThinkingTokens,
	estimateTokens,
	measureRequestInputChars,
	measureRequestReasoningChars,
	noteContextOverflow,
	noteOutputCap,
	observeRequestTokens,
	ReasoningEffortSchema,
} from "@cline/shared";
import { toAsyncIterable } from "./async";
import { BUILTIN_PROVIDER_REGISTRATIONS } from "./builtins-runtime";
import { resolveReasoningHistoryMode } from "./model-facts";
import { GatewayRegistry } from "./registry";
import { isPositiveFiniteNumber } from "./utils";

export type * from "@cline/shared";

/**
 * The synthesized per-turn cap at the window this default was written for.
 *
 * Kept as the anchor of {@link DEFAULT_GATEWAY_OUTPUT_WINDOW_SHARE} rather than
 * as the answer: 32,000 is the right cap for a 128k model and for no other.
 */
export const DEFAULT_GATEWAY_MAX_OUTPUT_TOKENS = 32_000;

/** The window {@link DEFAULT_GATEWAY_MAX_OUTPUT_TOKENS} was chosen against. */
const DEFAULT_GATEWAY_OUTPUT_WINDOW = 128_000;

/**
 * The share of the context window a synthesized output cap takes: 32,000 per
 * 128,000, applied at whatever window the model actually reports.
 *
 * A flat cap is wrong at both ends. On a 32,768-token model 32,000 is the whole
 * window, so filling the cap leaves nothing for the conversation; on a
 * 262,144-token model it is an eighth of it, and the model is held to a reply
 * length seven eighths of its room could have covered. The second end is the
 * costly one on Ollama, which sizes the thinking budget from
 * `min(num_predict, num_ctx)`: measured on a3b at 262,144 context, effort
 * `high` (half) came out at 16,000 thinking tokens and 9 turns of one
 * transaction ended inside a 511-token band at the cap, 147,000 tokens — 39% of
 * everything the transaction generated — spent on thinking that was cut off and
 * resumed from a summary. The same session compacted zero times: the window was
 * never the constraint, the flat cap was.
 *
 * This is the share compaction already reserves for output at cold start
 * ({@link COLD_START_OUTPUT_ROOM_WINDOW_SHARE} in `compaction-shared`), which is
 * what makes the two agree by construction rather than by coincidence.
 */
const DEFAULT_GATEWAY_OUTPUT_WINDOW_SHARE =
	DEFAULT_GATEWAY_MAX_OUTPUT_TOKENS / DEFAULT_GATEWAY_OUTPUT_WINDOW;

/**
 * The per-turn cap to synthesize when the caller asked for none.
 *
 * Only ever a default: an explicitly requested cap (the `num_predict` in the
 * provider settings, or a `maxTokensPerTurn` on the session) is used as-is, and
 * the room left in the window still clamps this.
 *
 * The share applies only where the model publishes no output ceiling of its
 * own, which is where the flat number did the damage: local models declare a
 * window and nothing else, so 32,000 was the whole answer at every window size.
 * A model that does publish one already has a bound its own designers set, and
 * the default's job there is to stay under it rather than to ask for all of it
 * — on Anthropic, `max_tokens` is charged against the per-minute output limit
 * whether or not the reply uses it, so raising a 32,000 request to a model's
 * full 64,000 ceiling would cost throughput and buy nothing.
 */
export function resolveDefaultMaxOutputTokens(
	model: Pick<GatewayModelDefinition, "contextWindow" | "maxOutputTokens"> = {},
): number {
	if (
		isPositiveFiniteNumber(model.maxOutputTokens) ||
		!isPositiveFiniteNumber(model.contextWindow)
	) {
		return DEFAULT_GATEWAY_MAX_OUTPUT_TOKENS;
	}
	return Math.max(
		GATEWAY_MIN_OUTPUT_TOKENS,
		Math.floor(model.contextWindow * DEFAULT_GATEWAY_OUTPUT_WINDOW_SHARE),
	);
}

/**
 * The output ceiling a provider named while refusing the cap we sent.
 *
 * A synthesized cap is a guess -- {@link resolveDefaultMaxOutputTokens} takes a
 * share of the window because a model that publishes no ceiling gives it
 * nothing better to go on -- and on a large window that guess can exceed every
 * ceiling that exists. Measured: a 1,048,576-token window resolved to 262,144
 * (mann1x/cline#59), and the model behind it accepts 131,072, so every request
 * of the session was refused before it started.
 *
 * The refusal carries the number the guess should have been. Reading it back
 * turns a hard failure into one wasted round trip, and only for models the
 * catalog does not know -- which is the same set the guess was for.
 */
const OUTPUT_CEILING_PATTERNS: RegExp[] = [
	// Ollama Cloud / Z.ai: "max_tokens (262144) exceeds model's maximum output
	// tokens (131072) for model glm-5.2". The one shape measured from a report.
	/maximum output tokens\s*\((\d+)\)/i,
	// Anthropic: "max_tokens: 200000 > 64000, which is the maximum allowed
	// number of output tokens for ...".
	/max_tokens:\s*\d+\s*>\s*(\d+)/i,
	// OpenAI: "max_tokens is too large: 262144. This model supports at most
	// 128000 completion tokens".
	/supports at most\s*(\d+)\s*completion tokens/i,
];

/**
 * The ceiling a provider named, if the failure was about the output cap.
 *
 * Deliberately narrow: it matches only messages that state a number, so a
 * refusal for any other reason returns undefined and is rethrown untouched.
 */
export function extractRejectedOutputCeiling(
	error: unknown,
): number | undefined {
	const text =
		error instanceof Error
			? `${error.message} ${describeErrorBody(error)}`
			: typeof error === "string"
				? error
				: "";
	if (!text) {
		return undefined;
	}
	for (const pattern of OUTPUT_CEILING_PATTERNS) {
		const found = text.match(pattern);
		if (found) {
			const ceiling = Number.parseInt(found[1], 10);
			if (isPositiveFiniteNumber(ceiling)) {
				return ceiling;
			}
		}
	}
	return undefined;
}

/**
 * AI SDK errors carry the provider's JSON on the error rather than in
 * `message`, and that is where the ceiling usually is.
 */
function describeErrorBody(error: Error): string {
	const candidate = error as Error & {
		responseBody?: unknown;
		data?: unknown;
		cause?: unknown;
	};
	const parts: string[] = [];
	for (const value of [
		candidate.responseBody,
		candidate.data,
		candidate.cause instanceof Error ? candidate.cause.message : undefined,
	]) {
		if (typeof value === "string") {
			parts.push(value);
		} else if (value && typeof value === "object") {
			try {
				parts.push(JSON.stringify(value));
			} catch {
				// A body that will not serialize tells us nothing; skip it.
			}
		}
	}
	return parts.join(" ");
}

/**
 * Ceilings learned from refusals, keyed by provider and model.
 *
 * Per process rather than persisted: it costs one refused request to relearn
 * after a restart, and a stale ceiling written to disk would outlive the model
 * revision that set it.
 */
const learnedOutputCeilings = new Map<string, number>();

function outputCeilingKey(providerId: string, modelId: string): string {
	return `${providerId}::${modelId}`;
}

/**
 * Start the stream and hold its first event.
 *
 * A refused request does not fail where it is issued. Providers return an async
 * generator, so the HTTP call and the error it raises both happen on the first
 * `next()` -- and a `try` around `provider.stream(...)` catches nothing at all.
 * Pulling one event here is what makes the refusal catchable, and it also draws
 * the line the retry needs: nothing has reached the caller yet, so re-issuing
 * the request cannot duplicate output it has already seen.
 */
async function primeStream<T>(
	stream: AsyncIterable<T> | Iterable<T>,
): Promise<{ first: IteratorResult<T>; rest: AsyncIterable<T> }> {
	const iterator = toAsyncIterable(stream)[Symbol.asyncIterator]();
	const first = await iterator.next();
	return {
		first,
		rest: {
			async *[Symbol.asyncIterator]() {
				let next = first;
				while (!next.done) {
					yield next.value;
					next = await iterator.next();
				}
			},
		},
	};
}

/** Test seam; also lets a host drop what it learned when settings change. */
export function resetLearnedOutputCeilings(): void {
	learnedOutputCeilings.clear();
}

const GATEWAY_OUTPUT_RESERVE_TOKENS = 1_024;

/**
 * The smallest remaining-context cap worth sending as an output limit.
 *
 * That term is `contextWindow - estimatedInputTokens - reserve`: a difference of
 * two large numbers, so it carries the estimate's error magnified. When it comes
 * out below a floor, the estimate is the likelier explanation than a genuinely
 * exhausted window -- compaction reads what the provider counted rather than an
 * estimate, and would have fired first if the window were really full.
 *
 * Sending the tiny number anyway is worse than sending none. Observed live: an
 * estimate running 1.7x high walked the cap down to 60 tokens; Ollama sizes an
 * effort-level thinking budget as a share of `num_predict`, so the budget came
 * out at 15 tokens, the forced end-of-thinking sequence spliced into a tool call
 * the model had already started, and the turn died on "expected '{' in tool
 * call" -- reported to the user as reaching the output limit.
 */
export const GATEWAY_MIN_OUTPUT_TOKENS = 1_024;

/**
 * How long an auxiliary call waits for the conversation to free the model.
 *
 * Long enough to cover a full turn on a local model, short enough that a slot
 * never released -- a stream abandoned without being drained -- costs one wait
 * rather than the life of the process.
 */
const AUXILIARY_SLOT_WAIT_MS = 120_000;

function mergeRequestMetadata(
	defaults: Record<string, unknown> | undefined,
	request: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!defaults && !request) {
		return undefined;
	}
	return {
		...(defaults ?? {}),
		...(request ?? {}),
	};
}

function normalizeReasoningBudgetTokens(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

function normalizeRequestedReasoning(
	value: unknown,
): GatewayStreamRequest["reasoning"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}

	const input = value as Record<string, unknown>;
	const parsedEffort = ReasoningEffortSchema.safeParse(input.effort);
	const normalized = {
		enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
		effort: parsedEffort.success ? parsedEffort.data : undefined,
		budgetTokens: normalizeReasoningBudgetTokens(input.budgetTokens),
	};

	return normalized.enabled !== undefined ||
		normalized.effort !== undefined ||
		normalized.budgetTokens !== undefined
		? normalized
		: undefined;
}

function mergeReasoningOptions(
	defaults: GatewayStreamRequest["reasoning"],
	legacy: GatewayStreamRequest["reasoning"],
	requested: GatewayStreamRequest["reasoning"],
): GatewayStreamRequest["reasoning"] {
	if (legacy?.enabled === false || requested?.enabled === false) {
		return { enabled: false };
	}

	const merged = {
		enabled: requested?.enabled ?? legacy?.enabled ?? defaults?.enabled,
		effort: requested?.effort ?? legacy?.effort ?? defaults?.effort,
		budgetTokens:
			requested?.budgetTokens ?? legacy?.budgetTokens ?? defaults?.budgetTokens,
	};
	if (
		merged.enabled === false &&
		(merged.effort !== undefined || merged.budgetTokens !== undefined)
	) {
		merged.enabled = undefined;
	}

	return Object.values(merged).some((value) => value !== undefined)
		? merged
		: undefined;
}

export interface Gateway {
	registerProvider(registration: GatewayProviderRegistration): this;
	configureProvider(
		config: NonNullable<GatewayConfig["providerConfigs"]>[number],
	): this;
	listProviders(): ReturnType<GatewayRegistry["listProviders"]>;
	listModels(providerId?: string): ReturnType<GatewayRegistry["listModels"]>;
	createAgentModel(
		selection: GatewayModelSelection,
		options?: GatewayModelHandleOptions,
	): AgentModel;
	stream(
		request: GatewayStreamRequest,
	): Promise<AsyncIterable<AgentModelEvent>>;
}

class GatewayModelAdapter implements AgentModel {
	constructor(
		private readonly gateway: DefaultGateway,
		private readonly selection: GatewayModelSelection,
		private readonly defaults: GatewayModelHandleOptions | undefined,
	) {}

	stream(request: AgentModelRequest): Promise<AsyncIterable<AgentModelEvent>> {
		const defaultReasoning = normalizeRequestedReasoning(
			this.defaults?.reasoning,
		);
		const requestedReasoning = normalizeRequestedReasoning(
			request.options?.reasoning,
		);
		const thinking = request.options?.thinking;
		const reasoningEffort = request.options?.reasoningEffort;
		const thinkingBudgetTokens = request.options?.thinkingBudgetTokens;
		const parsedLegacyEffort = ReasoningEffortSchema.safeParse(reasoningEffort);
		const legacyEffort: ReasoningEffort | undefined = parsedLegacyEffort.success
			? parsedLegacyEffort.data
			: undefined;
		const legacyBudgetTokens =
			normalizeReasoningBudgetTokens(thinkingBudgetTokens);
		const legacyReasoning:
			| {
					enabled?: boolean;
					effort?: ReasoningEffort;
					budgetTokens?: number;
			  }
			| undefined =
			typeof thinking === "boolean" ||
			legacyEffort !== undefined ||
			legacyBudgetTokens !== undefined
				? {
						enabled: typeof thinking === "boolean" ? thinking : undefined,
						effort: legacyEffort,
						budgetTokens: legacyBudgetTokens,
					}
				: undefined;
		return this.gateway.stream({
			providerId: this.selection.providerId,
			modelId: this.selection.modelId ?? "",
			systemPrompt: request.systemPrompt,
			messages: request.messages,
			tools: this.defaults?.tools ?? request.tools,
			temperature:
				(request.options?.temperature as number | undefined) ??
				this.defaults?.temperature,
			maxTokens:
				(request.options?.maxTokens as number | undefined) ??
				this.defaults?.maxTokens,
			metadata: mergeRequestMetadata(
				this.defaults?.metadata,
				request.options?.metadata as Record<string, unknown> | undefined,
			),
			reasoning: mergeReasoningOptions(
				defaultReasoning,
				legacyReasoning,
				requestedReasoning,
			),
			signal: request.signal ?? this.defaults?.signal,
			auxiliary: this.defaults?.auxiliary,
		});
	}
}

/**
 * Share of the estimated prompt held back to absorb the estimate's own error.
 *
 * `estimatedInputTokens` is a character count divided by a calibrated ratio,
 * and the ratio is smoothed across turns, so it lags whenever the content
 * changes shape — which it does constantly as a transcript fills with prose and
 * reasoning. A flat reserve cannot cover that: the error scales with the
 * prompt, and the reserve did not.
 *
 * Measured on a 1h19m session that died of it. Estimate 95,115 tokens against a
 * real 103,591 on a 110,000-token window: the estimate was short by 8,476, or
 * 8.9% of itself. The flat 1,024 reserve left `num_predict` at 13,861 when the
 * true remaining room was 5,385. The model reasoned for 6,489 tokens, ran off
 * the end of the window mid-thought, and returned an empty message.
 *
 * 12% is that measured 8.9% with margin, and it is cheap: it comes out of a
 * per-turn output cap, which is the binding constraint only when the prompt has
 * nearly filled the window — precisely the case where being wrong ends the run.
 */
const OUTPUT_RESERVE_ESTIMATE_ERROR_SHARE = 0.12;

/**
 * The reserve to hold back for a prompt of this estimated size.
 *
 * Never below the flat floor, which covers the small fixed costs (chat
 * scaffolding, a stop sequence) that do not scale with the prompt.
 */
function resolveOutputReserveTokens(estimatedInputTokens: number): number {
	if (!isPositiveFiniteNumber(estimatedInputTokens)) {
		return GATEWAY_OUTPUT_RESERVE_TOKENS;
	}
	return Math.max(
		GATEWAY_OUTPUT_RESERVE_TOKENS,
		Math.ceil(estimatedInputTokens * OUTPUT_RESERVE_ESTIMATE_ERROR_SHARE),
	);
}

/**
 * The budget terms, flattened into the message.
 *
 * `BasicLogger` keeps the message and drops the rest, so anything that has to
 * survive into a log file has to be in the string.
 */
function describeOutputBudget(details: {
	contextWindow?: number;
	estimatedInputTokens?: number;
	inputChars?: number;
	reserveTokens?: number;
	remainingContext?: number;
	minOutputTokens?: number;
}): string {
	return Object.entries(details)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${value}`)
		.join(" ");
}

interface GatewayOutputCapInput {
	/**
	 * Skip the process-wide overflow record. Set for calls the machinery makes
	 * for itself, whose budget arithmetic says nothing about the conversation's.
	 */
	suppressGlobalNotes?: boolean;
	requestedMaxTokens?: number;
	model: Pick<GatewayModelDefinition, "contextWindow" | "maxOutputTokens">;
	/**
	 * A ceiling the provider named while refusing a cap, for a model whose
	 * catalog entry publishes none.
	 *
	 * A clamp and not a published ceiling, which is why it is its own term
	 * rather than a `maxOutputTokens` written onto the model. Writing it there
	 * would also tell {@link resolveDefaultMaxOutputTokens} the model declares
	 * its own limit, and it would fall back to the flat 32,000 default -- so a
	 * model that had just said it accepts 131,072 would be held to a quarter of
	 * that. As a clamp the share still sets the number and this only bounds it.
	 */
	outputCeilingTokens?: number;
	estimatedInputTokens: number;
	defaultMaxOutputTokens?: number;
	outputReserveTokens?: number;
	minOutputTokens?: number;
	reasoningBudgetTokens?: number;
	onContextOverflow?: (details: {
		contextWindow: number;
		estimatedInputTokens: number;
		reserveTokens: number;
		remainingContext: number;
		minOutputTokens: number;
	}) => void;
}

export function resolveGatewayRequestMaxTokens(
	input: GatewayOutputCapInput,
): number | undefined {
	return resolveGatewayOutputCap(input).maxTokens;
}

/**
 * The cap and the term that set it.
 *
 * The cap alone is ambiguous in the one place it has to be acted on: a turn
 * truncated at 32,000 tokens says nothing about whether 32,000 was the window's
 * doing or the request's, and only the first is worth compacting for. The
 * arithmetic that knows is this function's, so the answer is returned rather
 * than reconstructed by a caller comparing numbers it would have to guess at.
 */
export function resolveGatewayOutputCap(
	input: GatewayOutputCapInput,
): OutputCapReport {
	const caps: Array<{ tokens: number; source: OutputCapSource }> = [];
	if (isPositiveFiniteNumber(input.requestedMaxTokens)) {
		caps.push({
			tokens: Math.floor(input.requestedMaxTokens),
			source: "requested",
		});
	} else {
		// Providers like Anthropic require max_tokens to exceed the thinking
		// budget, so an explicit reasoning budget lifts the synthesized default
		// (still clamped by model max output and remaining context below).
		const reasoningFloor = isPositiveFiniteNumber(input.reasoningBudgetTokens)
			? Math.floor(input.reasoningBudgetTokens) +
				(input.outputReserveTokens ?? GATEWAY_OUTPUT_RESERVE_TOKENS)
			: 0;
		const defaultMaxOutputTokens = Math.max(
			input.defaultMaxOutputTokens ??
				resolveDefaultMaxOutputTokens(input.model),
			reasoningFloor,
		);
		if (
			isPositiveFiniteNumber(input.model.maxOutputTokens) ||
			isPositiveFiniteNumber(input.model.contextWindow)
		) {
			caps.push({ tokens: defaultMaxOutputTokens, source: "default" });
		}
	}

	if (isPositiveFiniteNumber(input.model.maxOutputTokens)) {
		caps.push({
			tokens: Math.floor(input.model.maxOutputTokens),
			source: "model-max-output",
		});
	}

	if (isPositiveFiniteNumber(input.outputCeilingTokens)) {
		caps.push({
			tokens: Math.floor(input.outputCeilingTokens),
			source: "model-max-output",
		});
	}

	if (isPositiveFiniteNumber(input.model.contextWindow)) {
		const reserveTokens =
			input.outputReserveTokens ??
			resolveOutputReserveTokens(input.estimatedInputTokens);
		const minOutputTokens = isPositiveFiniteNumber(input.minOutputTokens)
			? input.minOutputTokens
			: GATEWAY_MIN_OUTPUT_TOKENS;
		const remainingContext =
			input.model.contextWindow - input.estimatedInputTokens - reserveTokens;
		if (remainingContext < minOutputTokens) {
			const report = {
				contextWindow: input.model.contextWindow,
				estimatedInputTokens: input.estimatedInputTokens,
				reserveTokens,
				remainingContext,
				minOutputTokens,
			};
			// Left where compaction collects it before the next request. Reporting
			// it only through the callback made acting on it optional, and the one
			// caller that mattered only logged: that is how a session walked its
			// cap from 20,547 to nothing over six turns while auto-compact sat
			// below a trigger computed from a different window. Recording it here
			// means finding the overflow and reporting it are the same act.
			if (!input.suppressGlobalNotes) {
				noteContextOverflow(report);
			}
			input.onContextOverflow?.(report);
			// No cap goes out, but the window is still what decided that, and the
			// next truncation is squarely compaction's to fix.
			return { source: "context-overflow", windowBound: true };
		}
		caps.push({
			tokens: Math.floor(remainingContext),
			source: "remaining-context",
		});
	}

	if (caps.length === 0) {
		return { source: "uncapped", windowBound: false };
	}

	// Ties resolve to the window. Two terms landing on the same number leaves no
	// evidence which one truncated the reply, and the costlier mistake is the
	// one that withholds a compaction the window did need.
	let winner = caps[0];
	for (const cap of caps.slice(1)) {
		if (
			cap.tokens < winner.tokens ||
			(cap.tokens === winner.tokens && cap.source === "remaining-context")
		) {
			winner = cap;
		}
	}

	return {
		maxTokens: Math.max(1, Math.floor(winner.tokens)),
		source: winner.source,
		windowBound: winner.source === "remaining-context",
	};
}

export class DefaultGateway implements Gateway {
	private readonly registry: GatewayRegistry;
	private readonly logger: BasicLogger | undefined;
	private readonly telemetry: ITelemetryService | undefined;

	constructor(config: GatewayConfig = {}) {
		this.registry = new GatewayRegistry(config.fetch);
		this.logger = config.logger;
		this.telemetry = config.telemetry;

		if (config.builtins !== false) {
			const builtins = new Set(
				config.builtins ??
					BUILTIN_PROVIDER_REGISTRATIONS.map(
						(provider) => provider.manifest.id,
					),
			);
			for (const builtin of BUILTIN_PROVIDER_REGISTRATIONS) {
				if (builtins.has(builtin.manifest.id)) {
					this.registry.registerProvider(builtin);
				}
			}
		}

		for (const provider of config.providers ?? []) {
			this.registry.registerProvider(provider);
		}

		for (const providerConfig of config.providerConfigs ?? []) {
			this.registry.configureProvider(providerConfig);
		}
	}

	registerProvider(registration: GatewayProviderRegistration): this {
		this.registry.registerProvider(registration);
		return this;
	}

	configureProvider(
		config: NonNullable<GatewayConfig["providerConfigs"]>[number],
	): this {
		this.registry.configureProvider(config);
		return this;
	}

	listProviders() {
		return this.registry.listProviders();
	}

	listModels(providerId?: string) {
		return this.registry.listModels(providerId);
	}

	createAgentModel(
		selection: GatewayModelSelection,
		options?: GatewayModelHandleOptions,
	): AgentModel {
		return new GatewayModelAdapter(this, selection, options);
	}

	/**
	 * Conversation requests currently streaming, and how to wait them out.
	 *
	 * A local server serves one request at a time per model. An auxiliary call
	 * issued while the conversation is streaming does not run alongside it -- it
	 * queues, and if the turn it belongs to has moved on by the time the slot
	 * frees, it is abandoned: no response, no error, nothing in the server's log.
	 * Measured with a probe that sat for 89 seconds and returned only when the
	 * session it was queued behind was stopped.
	 *
	 * So auxiliary calls wait for the slot instead of racing for it. The wait is
	 * one-directional by construction: the conversation never waits for the
	 * machinery, which is what keeps this from becoming a way to stall a turn.
	 */
	#conversationsInFlight = 0;
	#slotFree: Promise<void> = Promise.resolve();
	#releaseSlot: () => void = () => {};

	#takeSlot(): () => void {
		if (this.#conversationsInFlight === 0) {
			this.#slotFree = new Promise<void>((resolve) => {
				this.#releaseSlot = resolve;
			});
		}
		this.#conversationsInFlight += 1;
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			this.#conversationsInFlight -= 1;
			if (this.#conversationsInFlight === 0) {
				this.#releaseSlot();
			}
		};
	}

	/**
	 * Wait for the conversation to release the model, but not indefinitely.
	 *
	 * A stream abandoned without being drained would otherwise hold the slot for
	 * the life of the process, and a summary that never happens is a worse
	 * failure than one that queues.
	 */
	async #awaitFreeSlot(): Promise<void> {
		if (this.#conversationsInFlight === 0) {
			return;
		}
		const waitedFrom = Date.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			this.#slotFree,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, AUXILIARY_SLOT_WAIT_MS);
			}),
		]);
		if (timer) {
			clearTimeout(timer);
		}
		this.logger?.log(
			`Auxiliary request waited ${Date.now() - waitedFrom}ms for the model${
				this.#conversationsInFlight > 0 ? " and gave up waiting" : ""
			}`,
			{ severity: "info" },
		);
	}

	async stream(
		request: GatewayStreamRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
		if (request.auxiliary) {
			await this.#awaitFreeSlot();
		}
		const resolved = this.registry.resolveModel({
			providerId: request.providerId,
			modelId: request.modelId || undefined,
		});
		const providerRecord = await this.registry.createProvider(
			request.providerId,
		);
		const provider = await providerRecord.createProvider(providerRecord.config);
		// Measure what the provider will send, not what it was handed.
		//
		// `toAiSdkMessages` drops all but the last reasoning block for Ollama,
		// and it does it after this point -- so everything measured here that it
		// then removed was counted and never transmitted. Reasoning ran 32-61% of
		// a live transcript by characters, moving every turn, which is the whole
		// of the estimator's error: 5% high on a tool-heavy turn, 45% high two
		// turns after a long think, and always in the direction that shrinks the
		// output cap.
		const reasoningHistory = resolveReasoningHistoryMode(request, {
			provider: resolved.provider,
			model: resolved.model,
			config: providerRecord.config,
		} as GatewayProviderContext);
		const inputChars = measureRequestInputChars(request, { reasoningHistory });
		// Reasoning is counted at its own rate. One ratio for a whole request is
		// an average over two populations that do not tokenize alike, and the mix
		// moves every turn — which undercounts exactly the reasoning-heavy
		// requests that are already closest to the window.
		const reasoningChars = Math.min(
			inputChars,
			measureRequestReasoningChars(request, { reasoningHistory }),
		);
		const estimatedInputTokens =
			reasoningChars > 0
				? estimateTokens(inputChars - reasoningChars) +
					estimateThinkingTokens(reasoningChars)
				: estimateTokens(inputChars);
		const ceilingKey = outputCeilingKey(
			resolved.provider.id,
			resolved.model.id,
		);
		const resolveCap = (ceiling: number | undefined): OutputCapReport =>
			resolveGatewayOutputCap({
				// An auxiliary call running out of room is its own problem, not a
				// reason to compact the conversation it was summarising.
				suppressGlobalNotes: request.auxiliary,
				requestedMaxTokens: request.maxTokens,
				model: resolved.model,
				// A model that publishes its own ceiling needs nothing learned; the
				// resolver already clamps to it. This only stands in where the
				// catalog is silent, which is where a synthesized cap can be
				// impossible.
				outputCeilingTokens: ceiling,
				estimatedInputTokens,
				reasoningBudgetTokens: request.reasoning?.budgetTokens,
				onContextOverflow: (details) => {
					this.logger?.log(
						"Estimated remaining context leaves no usable output budget; sending no output cap" +
							` (${describeOutputBudget(details)})`,
						{
							severity: "warn",
							providerId: resolved.provider.id,
							modelId: resolved.model.id,
							...details,
						},
					);
				},
			});

		const send = async (ceiling: number | undefined) => {
			const outputCap = resolveCap(ceiling);
			const maxTokens = outputCap.maxTokens;
			// The terms behind the cap, not just the cap. A session was watched
			// ratchet from 20,547 down to no cap at all over six turns while
			// compaction sat below its trigger the whole way, and the logs could
			// not say which term moved: the window, the estimate, or the reserve.
			// The structured fields above are dropped by the logger, so they go in
			// the message.
			this.logger?.log(
				`Resolved output cap ${maxTokens ?? "none"} from ${outputCap.source} (${describeOutputBudget(
					{
						contextWindow: resolved.model.contextWindow,
						estimatedInputTokens,
						inputChars,
					},
				)})`,
				{ severity: "info" },
			);
			const stream = await provider.stream(
				{
					...request,
					modelId: resolved.model.id,
					providerId: resolved.provider.id,
					maxTokens,
					defaultedMaxTokens:
						maxTokens !== undefined &&
						!isPositiveFiniteNumber(request.maxTokens),
				},
				{
					provider: resolved.provider,
					model: resolved.model,
					config: providerRecord.config,
					signal: request.signal,
					logger: this.logger,
					telemetry: this.telemetry,
				},
			);
			return { stream, outputCap };
		};

		let sent: {
			stream: AsyncIterable<AgentModelEvent>;
			outputCap: OutputCapReport;
		};
		try {
			const attempt = await send(learnedOutputCeilings.get(ceilingKey));
			sent = {
				stream: (await primeStream(attempt.stream)).rest,
				outputCap: attempt.outputCap,
			};
		} catch (error) {
			const ceiling = extractRejectedOutputCeiling(error);
			// Only a cap this gateway invented is ours to correct. One the caller
			// asked for is a setting, and quietly sending a different number would
			// hide the thing they need to change.
			if (
				ceiling === undefined ||
				isPositiveFiniteNumber(request.maxTokens) ||
				learnedOutputCeilings.get(ceilingKey) === ceiling
			) {
				throw error;
			}
			learnedOutputCeilings.set(ceilingKey, ceiling);
			this.logger?.log(
				`${resolved.provider.id}/${resolved.model.id} refused the output cap and named ${ceiling}` +
					" as its maximum; retrying once at that ceiling and remembering it for this session",
				{
					severity: "warn",
					providerId: resolved.provider.id,
					modelId: resolved.model.id,
				},
			);
			const retry = await send(ceiling);
			sent = {
				stream: (await primeStream(retry.stream)).rest,
				outputCap: retry.outputCap,
			};
		}
		const { stream, outputCap } = sent;
		if (!request.auxiliary) {
			// Left for the agent loop, which sees the truncation but not the terms
			// that caused it. Not from an auxiliary call: its cap is its own, and
			// a conversation turn truncating afterwards would be attributed to it.
			noteOutputCap(outputCap);
		}

		if (request.auxiliary) {
			// Served identically, but it does not get to speak for the session:
			// a condenser prompt is not the conversation, and the ratio measured
			// from one is not the ratio the conversation tokenizes at.
			return toAsyncIterable(stream);
		}
		return holdingSlot(
			calibrateFromUsage(toAsyncIterable(stream), inputChars, reasoningChars),
			this.#takeSlot(),
		);
	}
}

/**
 * Hold the model's slot until the stream is done with it.
 *
 * `finally` covers the abandoned case as well as the finished one: a consumer
 * that breaks out of the loop triggers the generator's `return`, so the slot is
 * released there too rather than when the process ends.
 */
async function* holdingSlot(
	events: AsyncIterable<AgentModelEvent>,
	release: () => void,
): AsyncIterable<AgentModelEvent> {
	try {
		yield* events;
	} finally {
		release();
	}
}

/**
 * Pass events through untouched, and feed any provider-reported input token
 * count back into the estimator paired with the character count of the request
 * that produced it.
 *
 * This is the only place both halves are in hand: the request was serialized
 * here, and the count comes back on this stream. Providers that report nothing
 * leave the estimator on its default.
 */
async function* calibrateFromUsage(
	events: AsyncIterable<AgentModelEvent>,
	inputChars: number,
	reasoningChars?: number,
): AsyncIterable<AgentModelEvent> {
	for await (const event of events) {
		if (
			event.type === "usage" &&
			isPositiveFiniteNumber(event.usage.inputTokens)
		) {
			observeRequestTokens(inputChars, event.usage.inputTokens, reasoningChars);
		}
		yield event;
	}
}

export function createGateway(config?: GatewayConfig): DefaultGateway {
	return new DefaultGateway(config);
}

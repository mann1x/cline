import type {
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
	BasicLogger,
	GatewayConfig,
	GatewayModelDefinition,
	GatewayModelHandleOptions,
	GatewayModelSelection,
	GatewayProviderRegistration,
	GatewayStreamRequest,
	ITelemetryService,
	ReasoningEffort,
} from "@cline/shared";
import {
	estimateTokens,
	measureRequestInputChars,
	noteContextOverflow,
	observeRequestTokens,
	ReasoningEffortSchema,
} from "@cline/shared";
import { toAsyncIterable } from "./async";
import { BUILTIN_PROVIDER_REGISTRATIONS } from "./builtins-runtime";
import type { GatewayProviderContext } from "@cline/shared";
import { resolveReasoningHistoryMode } from "./model-facts";
import { GatewayRegistry } from "./registry";
import { isPositiveFiniteNumber } from "./utils";

export type * from "@cline/shared";

export const DEFAULT_GATEWAY_MAX_OUTPUT_TOKENS = 32_000;
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

export function resolveGatewayRequestMaxTokens(input: {
	requestedMaxTokens?: number;
	model: Pick<GatewayModelDefinition, "contextWindow" | "maxOutputTokens">;
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
}): number | undefined {
	const caps: number[] = [];
	if (isPositiveFiniteNumber(input.requestedMaxTokens)) {
		caps.push(Math.floor(input.requestedMaxTokens));
	} else {
		// Providers like Anthropic require max_tokens to exceed the thinking
		// budget, so an explicit reasoning budget lifts the synthesized default
		// (still clamped by model max output and remaining context below).
		const reasoningFloor = isPositiveFiniteNumber(input.reasoningBudgetTokens)
			? Math.floor(input.reasoningBudgetTokens) +
				(input.outputReserveTokens ?? GATEWAY_OUTPUT_RESERVE_TOKENS)
			: 0;
		const defaultMaxOutputTokens = Math.max(
			input.defaultMaxOutputTokens ?? DEFAULT_GATEWAY_MAX_OUTPUT_TOKENS,
			reasoningFloor,
		);
		if (
			isPositiveFiniteNumber(input.model.maxOutputTokens) ||
			isPositiveFiniteNumber(input.model.contextWindow)
		) {
			caps.push(defaultMaxOutputTokens);
		}
	}

	if (isPositiveFiniteNumber(input.model.maxOutputTokens)) {
		caps.push(Math.floor(input.model.maxOutputTokens));
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
			noteContextOverflow(report);
			input.onContextOverflow?.(report);
			return undefined;
		}
		caps.push(Math.floor(remainingContext));
	}

	if (caps.length === 0) {
		return undefined;
	}

	return Math.max(1, Math.floor(Math.min(...caps)));
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

	async stream(
		request: GatewayStreamRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
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
		const estimatedInputTokens = estimateTokens(inputChars);
		const maxTokens = resolveGatewayRequestMaxTokens({
			requestedMaxTokens: request.maxTokens,
			model: resolved.model,
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
		// The terms behind the cap, not just the cap. A session was watched
		// ratchet from 20,547 down to no cap at all over six turns while
		// compaction sat below its trigger the whole way, and the logs could not
		// say which term moved: the window, the estimate, or the reserve. The
		// structured fields above are dropped by the logger, so they go in the
		// message.
		this.logger?.log(
			`Resolved output cap ${maxTokens ?? "none"} (${describeOutputBudget({
				contextWindow: resolved.model.contextWindow,
				estimatedInputTokens,
				inputChars,
			})})`,
			{ severity: "info" },
		);
		const stream = await provider.stream(
			{
				...request,
				modelId: resolved.model.id,
				providerId: resolved.provider.id,
				maxTokens,
				defaultedMaxTokens:
					maxTokens !== undefined && !isPositiveFiniteNumber(request.maxTokens),
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

		return calibrateFromUsage(toAsyncIterable(stream), inputChars);
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
): AsyncIterable<AgentModelEvent> {
	for await (const event of events) {
		if (
			event.type === "usage" &&
			isPositiveFiniteNumber(event.usage.inputTokens)
		) {
			observeRequestTokens(inputChars, event.usage.inputTokens);
		}
		yield event;
	}
}

export function createGateway(config?: GatewayConfig): DefaultGateway {
	return new DefaultGateway(config);
}

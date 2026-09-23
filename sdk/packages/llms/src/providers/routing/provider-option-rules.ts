import { flattenPromptEnvironment, isClineProvider } from "@cline/shared";
import { toAiSdkReasoning } from "../ai-sdk";
import { DEFAULT_GATEWAY_MAX_OUTPUT_TOKENS } from "../gateway";
import {
	getModelReasoningControls,
	isDeepSeekFamily,
	isGlmModel,
	isKimiK26Family as isKimiK26FamilyFact,
	isMiniMaxM3Model,
	isMoonshotKimiModelIdFallback,
	modelReasoningDefaultsOn,
	providerReasoningRouteMatches,
} from "../model-facts";
import {
	buildLlamaCppSamplingOptions,
	readLlamaCppSamplingOptions,
} from "../vendors/llamacpp-sampling";
import {
	buildOllamaSamplingOptions,
	readOllamaNumCtx,
	readOllamaNumPredict,
	readOllamaSamplingOptions,
} from "../vendors/ollama";
import { buildGatewayReasoningOptions } from "./anthropic-compatible";
import { buildOpenAINativeProviderOptions } from "./generic-compatible";
import {
	buildNativeGlmThinkingProviderOptionsPatch,
	buildRoutedGlmReasoningProviderOptionsPatch,
} from "./glm-thinking";
import { buildMiniMaxThinkingProviderOptionsPatch } from "./minimax-thinking";
import type {
	MatchedProviderOptionRule,
	ProviderOptionBuildInput,
	ProviderOptionMatchInput,
	ProviderOptionRule,
	ProviderOptionSuppression,
} from "./provider-options-types";
import { buildOpenRouterReasoningOptions } from "./reasoning-codecs";
import {
	buildProviderAndAliasPatch,
	buildThinkingPatch,
	type ProviderOptionsPatch,
} from "./utils";

function isKimiK26Family(input: ProviderOptionMatchInput): boolean {
	return isKimiK26FamilyFact(input.context);
}

function isMoonshotKimiModel(input: ProviderOptionMatchInput): boolean {
	return isMoonshotKimiModelIdFallback(input.request);
}

function isDeepSeekModelOrProviderDefault(
	input: ProviderOptionMatchInput,
): boolean {
	return (
		isDeepSeekFamily(input.context) || input.request.providerId === "deepseek"
	);
}

function isMiniMaxM3(input: ProviderOptionMatchInput): boolean {
	return isMiniMaxM3Model(input.request, input.context);
}

function isOllamaReasoningDefaultOnDisable(
	input: ProviderOptionMatchInput,
): boolean {
	return (
		input.request.providerId === "ollama" &&
		input.request.reasoning?.enabled === false &&
		modelReasoningDefaultsOn({
			request: input.request,
			context: input.context,
		})
	);
}

function usesGlmThinkingProviderRouting(
	input: ProviderOptionMatchInput,
): boolean {
	return providerReasoningRouteMatches(
		"glm-thinking",
		input.request,
		input.context,
	);
}

function hasGlmThinkingProviderRouting(
	input: ProviderOptionMatchInput,
): boolean {
	return (
		input.context.provider.metadata?.routing?.reasoning?.format ===
		"glm-thinking"
	);
}

function usesMiniMaxThinkingProviderRouting(
	input: ProviderOptionMatchInput,
): boolean {
	return providerReasoningRouteMatches(
		"minimax-thinking",
		input.request,
		input.context,
	);
}

function resolveFamilyThinkingType(
	input: ProviderOptionMatchInput,
	defaultWhenUnset: "enabled" | "disabled" | undefined,
): "enabled" | "disabled" | undefined {
	const enabled = input.request.reasoning?.enabled;
	if (enabled === true) {
		return "enabled";
	}
	if (enabled === false) {
		return "disabled";
	}
	return defaultWhenUnset;
}

function buildReasoningPatchForProvider(
	input: ProviderOptionBuildInput,
	reasoning: Record<string, unknown> | undefined,
): ProviderOptionsPatch | undefined {
	if (!reasoning) {
		return undefined;
	}
	return buildProviderAndAliasPatch({
		providerId: input.request.providerId,
		providerOptionsKey: input.providerOptionsKey,
		bucketOptions: { reasoning },
	});
}

function buildGeminiThinkingConfig(input: ProviderOptionBuildInput) {
	const budgetTokens = input.request.reasoning?.budgetTokens;
	if (typeof budgetTokens === "number") {
		return {
			thinkingBudget: budgetTokens,
			includeThoughts: true,
		};
	}
	return undefined;
}

const directAnthropicProviderRule: ProviderOptionRule = {
	id: "provider.anthropic.direct",
	phase: "provider",
	description:
		"Direct Anthropic owns the anthropic bucket built by the base patch.",
	applies: (input) => input.request.providerId === "anthropic",
	suppresses: { genericFanout: true },
	build: () => undefined,
};

const directGoogleProviderRule: ProviderOptionRule = {
	id: "provider.google.direct",
	phase: "provider",
	description:
		"Direct Google owns the google bucket used for exact reasoning budgets.",
	applies: (input) => input.request.providerId === "google",
	suppresses: { genericFanout: true },
	build: () => undefined,
};

const openAiAdapterRule: ProviderOptionRule = {
	id: "adapter.openai",
	phase: "adapter",
	description:
		"OpenAI adapter targets the AI SDK openai bucket, not provider-id buckets.",
	applies: (input) => input.target === "openai",
	build: (input) => ({
		openai: {
			strictJsonSchema: false,
			...(["openai", "openai-native"].includes(input.request.providerId)
				? buildOpenAINativeProviderOptions()
				: {}),
		},
	}),
};

const openAiCodexRule: ProviderOptionRule = {
	id: "provider.openai-codex",
	phase: "provider",
	description:
		"Codex CLI uses OpenAI Responses options plus provider-id aliases.",
	applies: (input) => input.request.providerId === "openai-codex",
	suppresses: { genericFanout: true },
	build: (input) => {
		const codexOptions = {
			...input.compatibleOptions,
			instructions: input.request.systemPrompt
				? flattenPromptEnvironment(input.request.systemPrompt)
				: input.request.systemPrompt,
			store: false,
			strictJsonSchema: false,
			systemMessageMode: "remove" as const,
		};

		return {
			openai: codexOptions,
			...buildProviderAndAliasPatch({
				providerId: input.request.providerId,
				providerOptionsKey: input.providerOptionsKey,
				bucketOptions: codexOptions,
			}),
		};
	},
};

const genericProviderFanoutRule: ProviderOptionRule = {
	id: "provider.generic-fanout",
	phase: "provider-fanout",
	description:
		"Default OpenAI-compatible providers receive provider-id and camelCase alias buckets.",
	applies: (input) => input.target !== "openai",
	build: (input) =>
		input.suppressions.genericFanout
			? undefined
			: buildProviderAndAliasPatch({
					providerId: input.request.providerId,
					providerOptionsKey: input.providerOptionsKey,
					bucketOptions: input.compatibleOptions,
				}),
};

const clineGatewayReasoningRule: ProviderOptionRule = {
	id: "provider.cline.reasoning",
	phase: "provider-reasoning",
	description: "Cline gateway accepts the shared gateway reasoning shape.",
	applies: (input) => isClineProvider(input.request.providerId),
	build: (input) =>
		buildReasoningPatchForProvider(
			input,
			buildGatewayReasoningOptions(input.request, input.context),
		),
};

const openRouterReasoningRule: ProviderOptionRule = {
	id: "provider.openrouter.reasoning",
	phase: "provider-reasoning",
	description:
		"OpenRouter expects reasoning controls under its first-class reasoning object.",
	applies: (input) => input.request.providerId === "openrouter",
	suppresses: { genericThinking: true },
	build: (input) =>
		buildReasoningPatchForProvider(
			input,
			buildOpenRouterReasoningOptions(input.request, input.context),
		),
};

const clineMiniMaxM3GatewayReasoningRule: ProviderOptionRule = {
	id: "provider.cline.minimax-m3.gateway-reasoning",
	phase: "provider-reasoning",
	description:
		"Cline-routed MiniMax M3 keeps the gateway reasoning shape instead of leaking generic thinking.",
	applies: (input) =>
		isClineProvider(input.request.providerId) && isMiniMaxM3(input),
	suppresses: { genericThinking: true },
	build: () => undefined,
};

const vercelReasoningRule: ProviderOptionRule = {
	id: "provider.vercel-ai-gateway.reasoning",
	phase: "provider-reasoning",
	description:
		"Vercel maps advertised toggle and budget controls to its gateway reasoning shape.",
	applies: (input) => {
		if (input.request.providerId !== "vercel-ai-gateway") {
			return false;
		}
		const controls = getModelReasoningControls(
			input.context.model.reasoningOptions,
		);
		return (
			(controls?.toggle === true &&
				typeof input.request.reasoning?.enabled === "boolean") ||
			(controls?.budget !== undefined &&
				typeof input.request.reasoning?.budgetTokens === "number") ||
			isMiniMaxM3(input)
		);
	},
	suppresses: { genericThinking: true },
	build: (input) => {
		const reasoning = input.request.reasoning;
		if (!reasoning) {
			return undefined;
		}
		const gatewayReasoning =
			typeof reasoning.budgetTokens === "number"
				? { max_tokens: reasoning.budgetTokens }
				: reasoning.enabled === false
					? { exclude: true }
					: reasoning.enabled === true
						? { enabled: true }
						: undefined;
		return gatewayReasoning
			? buildReasoningPatchForProvider(input, gatewayReasoning)
			: undefined;
	},
};

const directMoonshotReasoningRule: ProviderOptionRule = {
	id: "provider.moonshot.toggle",
	phase: "provider-reasoning",
	description:
		"Direct Moonshot maps advertised toggle controls to thinking.type.",
	applies: (input) =>
		input.request.providerId === "moonshot" &&
		getModelReasoningControls(input.context.model.reasoningOptions)?.toggle ===
			true &&
		typeof input.request.reasoning?.enabled === "boolean",
	suppresses: { genericThinking: true },
	build: (input) =>
		buildThinkingPatch({
			providerId: input.request.providerId,
			providerOptionsKey: input.providerOptionsKey,
			thinkingType: input.request.reasoning?.enabled ? "enabled" : "disabled",
		}),
};

const fireworksReasoningRule: ProviderOptionRule = {
	id: "provider.fireworks.reasoning-budget",
	phase: "provider-reasoning",
	description:
		"Fireworks uses its native thinking object for exact token budgets.",
	applies: (input) =>
		input.request.providerId === "fireworks" &&
		typeof input.request.reasoning?.budgetTokens === "number",
	suppresses: { genericThinking: true },
	build: (input) => {
		const reasoning = input.request.reasoning;
		return buildProviderAndAliasPatch({
			providerId: input.request.providerId,
			providerOptionsKey: input.providerOptionsKey,
			bucketOptions: {
				thinking: {
					type: "enabled",
					budget_tokens: reasoning?.budgetTokens,
				},
			},
		});
	},
};

const togetherReasoningToggleRule: ProviderOptionRule = {
	id: "provider.together.toggle",
	phase: "provider-reasoning",
	description: "Together maps advertised toggle controls to reasoning.enabled.",
	applies: (input) =>
		input.request.providerId === "together" &&
		getModelReasoningControls(input.context.model.reasoningOptions)?.toggle ===
			true &&
		typeof input.request.reasoning?.enabled === "boolean",
	suppresses: { genericThinking: true },
	build: (input) =>
		buildReasoningPatchForProvider(input, {
			enabled: input.request.reasoning?.enabled,
		}),
};

const geminiThinkingRule: ProviderOptionRule = {
	id: "provider.google-gemini.thinking-config",
	phase: "provider",
	description:
		"Google/Gemini/Vertex uses thinkingConfig only for exact token budgets.",
	suppresses: { genericThinking: true },
	applies: (input) =>
		(input.request.providerId === "google" ||
			input.request.providerId === "gemini" ||
			input.request.providerId === "vertex") &&
		typeof input.request.reasoning?.budgetTokens === "number",
	build: (input) => {
		const providerOptionsName =
			input.request.providerId === "vertex" ? "vertex" : "google";
		const thinkingConfig = buildGeminiThinkingConfig(input);
		if (!thinkingConfig) {
			return undefined;
		}
		return {
			[providerOptionsName]: {
				thinkingConfig,
			},
		};
	},
};

const clineReasoningDisabledThinkingRule: ProviderOptionRule = {
	id: "provider.cline.disable-thinking",
	phase: "provider",
	description:
		"Cline-routed non-Kimi-K2.6 Moonshot Kimi models use thinking.type=disabled when reasoning is disabled.",
	applies: (input) =>
		isClineProvider(input.request.providerId) &&
		isMoonshotKimiModel(input) &&
		input.request.reasoning?.enabled === false &&
		!isKimiK26Family(input),
	build: (input) =>
		buildThinkingPatch({
			providerId: input.request.providerId,
			providerOptionsKey: input.providerOptionsKey,
			thinkingType: "disabled",
		}),
};

const kimiK26ThinkingRule: ProviderOptionRule = {
	id: "family.kimi-k2.6.thinking",
	phase: "model-family",
	description: "Kimi K2.6 uses thinking.type only for explicit disable.",
	applies: (input) =>
		isKimiK26Family(input) &&
		input.request.providerId !== "openrouter" &&
		input.request.reasoning?.enabled === false,
	suppresses: { genericThinking: true },
	build: (input) =>
		buildThinkingPatch({
			providerId: input.request.providerId,
			providerOptionsKey: input.providerOptionsKey,
			thinkingType: "disabled",
		}),
};

const deepSeekThinkingRule: ProviderOptionRule = {
	id: "family.deepseek.thinking",
	phase: "model-family",
	description:
		"DeepSeek models use thinking.type only for explicit reasoning enabled/disabled.",
	applies: (input) =>
		input.request.providerId !== "openrouter" &&
		isDeepSeekModelOrProviderDefault(input) &&
		input.target !== "ollama",
	suppresses: { genericThinking: true },
	build: (input) => {
		const thinkingType = resolveFamilyThinkingType(input, undefined);
		return thinkingType
			? buildThinkingPatch({
					providerId: input.request.providerId,
					providerOptionsKey: input.providerOptionsKey,
					thinkingType,
				})
			: undefined;
	},
};

const ollamaReasoningDefaultOnDisableRule: ProviderOptionRule = {
	id: "provider.ollama.reasoning-default-on.disable-none",
	phase: "provider-reasoning",
	description:
		"Ollama models whose reasoning defaults on need reasoningEffort=none when request reasoning is disabled.",
	applies: isOllamaReasoningDefaultOnDisable,
	build: (input) => {
		const bucketOptions = {
			reasoningEffort: "none",
			reasoning: { effort: "none" },
		};
		return {
			...buildProviderAndAliasPatch({
				providerId: input.request.providerId,
				providerOptionsKey: input.providerOptionsKey,
				bucketOptions,
			}),
			openaiCompatible: bucketOptions,
		};
	},
};

/**
 * Ollama's own request options: the context window and the configured sampler.
 *
 * `ollama-ai-provider-v2` has no model-level options hook, so everything
 * Ollama-specific has to arrive as request-scoped provider options. This is the
 * only place that can happen without loss: `buildStreamConfig`'s result is
 * spread *after* the composed provider options in `ai-sdk.ts`, so returning a
 * `providerOptions` from there would replace the whole composed bucket rather
 * than add to it.
 *
 * The sampler comes from the user's Ollama panel and includes `think_budget`,
 * which the package's option schema does not name — the vendored patch gives
 * that schema a catchall so it survives the parse instead of being dropped.
 *
 * `think` is the one reasoning field that does belong in this bucket, and only
 * in its bare `true` form. A *level* still stays top-level, because on Ollama a
 * level is how a budget is bounded and the two must not be stated twice. But a
 * request that named no level has nothing to put top-level and still has to say
 * "think": with `think` absent a reasoning model thinks into `content` instead,
 * measured as a turn at ~51k input ending on the 32,000-token output limit.
 *
 * It must not say so by naming a level. On Ollama a level's budget outranks the
 * model's own `PARAMETER think_budget`. Measured against 0.34.2, `num_predict`
 * 8,000:
 *
 * | model declares | `think` absent | `think: true` | `think: "medium"` |
 * |---|---|---|---|
 * | nothing | unbounded | unbounded | **2,000** |
 * | `think_budget "high"` | 4,000 | 4,000 | **2,000** |
 *
 * So the old default both capped an unbounded model and halved a budget the
 * model had declared for itself, for every user who had not picked a level —
 * which is what "Default (provider decides)" means. `think: true` is the plain
 * "on" the AI SDK's effort scale cannot express, and it leaves the budget to
 * the model.
 */
const ollamaNativeOptionsRule: ProviderOptionRule = {
	id: "provider.ollama.native-options",
	phase: "provider-reasoning",
	description:
		"Ollama receives its context window and configured sampler through native provider options; reasoning stays top-level.",
	applies: (input) => input.target === "ollama",
	suppresses: { genericThinking: true },
	build: (input) => {
		const numPredict = readOllamaNumPredict(input.request, input.context);
		// Read from `requestedReasoning`, not `request.reasoning`: the latter has
		// been cleared by `withoutPortableReasoning` before any rule runs, so it
		// reports "nothing asked" for every request including an explicit off.
		// `toAiSdkReasoning` names a level only when the user named one and
		// returns `"none"` for an off, so an undefined result is exactly the
		// unnamed case — the only one that gets a bare `think`.
		const thinkWithoutALevel =
			toAiSdkReasoning(input.requestedReasoning) === undefined;
		return {
			ollama: {
				...(thinkWithoutALevel ? { think: true } : {}),
				options: {
					num_ctx: readOllamaNumCtx(input.context),
					// Before the sampler, so a `num_predict` the user configured in
					// the Ollama panel still wins — this only fills in the cap the
					// session already believes it is sending.
					...(numPredict !== undefined ? { num_predict: numPredict } : {}),
					...buildOllamaSamplingOptions(
						readOllamaSamplingOptions(input.context.config),
					),
				},
			},
		};
	},
};

/**
 * llama.cpp's per-request sampler and thinking budget.
 *
 * llama.cpp has no provider id of its own — it is reached through the generic
 * OpenAI-compatible form, and nothing identifies one before a response comes
 * back. `opencoti` is llama.cpp underneath and has its own target, so both are
 * named here.
 *
 * That breadth is why the builder sends only what the user actually configured:
 * this same target also carries hosted providers that would reject `min_p` or
 * `repeat_penalty` outright, and for them an unconfigured sampler has to leave
 * the request exactly as it was. A user who types a sampler into the panel for
 * an endpoint that cannot take one has asked for it; a user who types nothing
 * must not have their request changed underneath them.
 *
 * Reasoning is deliberately not suppressed. Unlike Ollama, where the `think`
 * level *is* how the budget is bounded, llama.cpp's budget is an absolute token
 * count in a separate field, so the portable reasoning option and the budget
 * are independent and both belong on the wire.
 */
const llamaCppNativeOptionsRule: ProviderOptionRule = {
	id: "provider.llamacpp.native-options",
	phase: "provider-reasoning",
	description:
		"llama.cpp and opencoti receive the configured sampler and a resolved thinking budget as request fields.",
	applies: (input) =>
		input.target === "openai-compatible" || input.target === "opencoti",
	// It no longer needs a configured sampler to have something to say: an
	// effort level alone now produces a budget, which is the only form of it
	// this engine reads.
	build: (input) => {
		const bucketOptions = buildLlamaCppSamplingOptions(
			readLlamaCppSamplingOptions(input.context.config),
			{
				contextWindow:
					input.context.model?.contextWindow ??
					input.context.model?.maxInputTokens,
				// The cap the session believes it is sending, which is also what
				// `buildOutputBudgetSection` states in the system prompt — the same
				// number an effort level has to take its share of, or the level
				// bounds nothing.
				// The cap the session believes it is sending, which is also what
				// `buildOutputBudgetSection` states in the system prompt.
				//
				// The fallback is load-bearing rather than tidy. A level is a
				// *share*, so with no cap and no context window it resolves to
				// nothing and the setting silently bounds nothing at all -- which
				// is the failure this rule exists to end, reappearing for any
				// profile that never set an output budget. Measured: a bare CLI
				// opencoti profile carries neither, so every level sent no budget.
				// `reasoning-codecs.ts` already scales against this same constant
				// for the same reason.
				numPredict:
					input.request.maxTokens ??
					input.context.model?.maxOutputTokens ??
					DEFAULT_GATEWAY_MAX_OUTPUT_TOKENS,
				// The level the user picked in the panel. llama.cpp has no
				// `reasoning_effort` -- the field the AI SDK emits for a level is
				// read and discarded by the engine -- so unless the level is
				// resolved to a token count here it bounds nothing at all.
				effort: input.portableReasoning ?? input.request.reasoning?.effort,
				enabled: input.request.reasoning?.enabled,
			},
		);
		if (Object.keys(bucketOptions).length === 0) {
			return undefined;
		}
		return {
			...buildProviderAndAliasPatch({
				providerId: input.request.providerId,
				providerOptionsKey: input.providerOptionsKey,
				bucketOptions,
			}),
			openaiCompatible: bucketOptions,
		};
	},
};

const nonGlmProviderRoutingSuppressionRule: ProviderOptionRule = {
	id: "provider.routing.glm-thinking.non-glm.suppress-generic-thinking",
	phase: "provider",
	description:
		"Providers with GLM thinking routing should not apply generic adaptive thinking to non-GLM models.",
	applies: (input) =>
		hasGlmThinkingProviderRouting(input) &&
		input.request.reasoning?.enabled !== undefined &&
		!usesGlmThinkingProviderRouting(input),
	suppresses: { genericThinking: true },
	build: () => undefined,
};

const nativeZaiGlmThinkingRule: ProviderOptionRule = {
	id: "provider.routing.glm-thinking",
	phase: "model-overlay",
	description: "Providers routed to the GLM thinking format use thinking.type.",
	applies: usesGlmThinkingProviderRouting,
	suppresses: { genericThinking: true },
	build: (input) =>
		buildNativeGlmThinkingProviderOptionsPatch(
			input.request,
			input.providerOptionsKey,
		),
};

const miniMaxThinkingRule: ProviderOptionRule = {
	id: "provider.routing.minimax-thinking",
	phase: "model-overlay",
	description: "Direct MiniMax M3 uses thinking.type adaptive/disabled.",
	applies: usesMiniMaxThinkingProviderRouting,
	suppresses: { genericThinking: true },
	build: (input) =>
		buildMiniMaxThinkingProviderOptionsPatch(
			input.request,
			input.providerOptionsKey,
		),
};

const routedGlmReasoningRule: ProviderOptionRule = {
	id: "family.glm.routed-reasoning",
	phase: "model-overlay",
	description:
		"Routed GLM models use the generic reasoning include/exclude shape, not thinking.type.",
	applies: (input) =>
		!usesGlmThinkingProviderRouting(input) &&
		isGlmModel(input.request, input.context),
	suppresses: { genericThinking: true },
	build: (input) =>
		buildRoutedGlmReasoningProviderOptionsPatch(
			input.request,
			input.context,
			input.providerOptionsKey,
			{
				includeProviderBuckets: input.request.providerId !== "openrouter",
			},
		),
};

/**
 * The table is the provider/family behavior matrix. Adding a new exception
 * should mean adding a named rule here, not adding a branch in the composer.
 * Keep model/provider fact detection in `providers/model-facts.ts`; see
 * `sdk/packages/llms/AGENTS.md` for the sources-of-truth boundary.
 */
export const PROVIDER_OPTION_RULES: ReadonlyArray<ProviderOptionRule> = [
	directAnthropicProviderRule,
	directGoogleProviderRule,
	openAiAdapterRule,
	openAiCodexRule,
	genericProviderFanoutRule,
	clineGatewayReasoningRule,
	openRouterReasoningRule,
	clineMiniMaxM3GatewayReasoningRule,
	vercelReasoningRule,
	directMoonshotReasoningRule,
	fireworksReasoningRule,
	geminiThinkingRule,
	clineReasoningDisabledThinkingRule,
	kimiK26ThinkingRule,
	deepSeekThinkingRule,
	ollamaReasoningDefaultOnDisableRule,
	ollamaNativeOptionsRule,
	llamaCppNativeOptionsRule,
	nonGlmProviderRoutingSuppressionRule,
	nativeZaiGlmThinkingRule,
	miniMaxThinkingRule,
	routedGlmReasoningRule,
	togetherReasoningToggleRule,
];

export function matchProviderOptionRules(
	rules: ReadonlyArray<ProviderOptionRule>,
	input: ProviderOptionMatchInput,
): Array<MatchedProviderOptionRule> {
	const matched: Array<MatchedProviderOptionRule> = [];
	for (const rule of rules) {
		if (rule.applies(input)) {
			matched.push({ rule });
		}
	}
	return matched;
}

export function resolveProviderOptionSuppressions(
	matchedRules: ReadonlyArray<MatchedProviderOptionRule>,
): ProviderOptionSuppression {
	return matchedRules.reduce<ProviderOptionSuppression>((result, { rule }) => {
		if (!rule.suppresses) {
			return result;
		}
		return {
			genericThinking:
				result.genericThinking || rule.suppresses.genericThinking || undefined,
			genericFanout:
				result.genericFanout || rule.suppresses.genericFanout || undefined,
		};
	}, {});
}

export function buildProviderOptionRulePatches(
	matchedRules: ReadonlyArray<MatchedProviderOptionRule>,
	input: ProviderOptionBuildInput,
): Array<ProviderOptionsPatch | undefined> {
	return matchedRules.map(({ rule }) => rule.build(input));
}

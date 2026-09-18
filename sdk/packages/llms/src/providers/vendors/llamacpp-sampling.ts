import type { GatewayResolvedProviderConfig } from "@cline/shared";
import type { ProviderSamplingOptions } from "../config";

/**
 * The per-request sampler and thinking budget a llama.cpp server accepts.
 *
 * llama.cpp is reached through the generic `openai-compatible` vendor — there
 * is no provider id for it, and nothing identifies one before a response comes
 * back (`request-timings.ts` recognises it only by the `timings` object on the
 * final frame). So everything here is written to be inert unless the user
 * configured it: an unset field is never sent, and a hosted OpenAI-style
 * endpoint on this same path therefore sees a request byte-identical to the one
 * it saw before. That is the same rule the Ollama vendor states for the same
 * reason — a local model carries a sampler that was tuned against that quant,
 * and a client sending a complete set on every request silently replaces it.
 *
 * Both this and `opencoti` are llama.cpp underneath, which is why one table
 * serves both.
 */

/**
 * Configured sampler field to the name llama.cpp's request schema uses.
 *
 * Verified against `tools/server/server-schema.cpp`. Deliberately absent:
 * `numGpu`, which is Ollama's `num_gpu` and has no per-request form here —
 * llama.cpp decides layer placement with `-ngl` at startup, so sending it would
 * be a field the server does not read, which is the shape of bug this table
 * exists to avoid.
 */
export const LLAMACPP_SAMPLING_WIRE_NAMES = {
	temperature: "temperature",
	topK: "top_k",
	topP: "top_p",
	minP: "min_p",
	typicalP: "typical_p",
	repeatLastN: "repeat_last_n",
	repeatPenalty: "repeat_penalty",
	presencePenalty: "presence_penalty",
	frequencyPenalty: "frequency_penalty",
	seed: "seed",
	numPredict: "n_predict",
	numKeep: "n_keep",
	stop: "stop",
	thinkBudgetMessage: "reasoning_budget_message",
} as const satisfies Partial<Record<keyof ProviderSamplingOptions, string>>;

/**
 * The share of the window an effort level is allowed to spend thinking.
 *
 * Ported verbatim from the Ollama server's own table (`api/types.go`,
 * `thinkBudgetFraction`) so that `high` means the same thing on both engines.
 * llama.cpp has no notion of an effort level — `reasoning_budget_tokens` is an
 * absolute count — so the level has to be resolved to a number on this side,
 * and resolving it with different arithmetic would make the same setting mean
 * two different budgets depending on which server answered.
 *
 * The steps halve rather than crowding the top of the range: how long a model
 * thinks depends on the prompt, not on how much room it was given, so shares
 * near the whole window stop bounding anything once the window is large.
 */
export const LLAMACPP_THINK_BUDGET_FRACTION: Readonly<
	Record<string, readonly [number, number]>
> = {
	max: [4, 5],
	high: [1, 2],
	medium: [1, 4],
	low: [1, 8],
	minimal: [1, 16],
};

/**
 * Alternative spellings of a level.
 *
 * The AI SDK calls the top of its effort scale `xhigh`, which is the position
 * `max` holds here, so a client built on that vocabulary sends it verbatim.
 * Rejecting it would put the strongest level out of reach over spelling.
 */
const LLAMACPP_THINK_LEVEL_ALIASES: Readonly<Record<string, string>> = {
	xhigh: "max",
};

function canonicalThinkLevel(level: string): string {
	const trimmed = level.trim().toLowerCase();
	return LLAMACPP_THINK_LEVEL_ALIASES[trimmed] ?? trimmed;
}

/**
 * The room a level is a share of.
 *
 * Ported from the Ollama server's `ThinkBudgetWindow`. A level bounds thinking
 * so the model still has room left to answer, which makes the response length
 * the thing to divide: when the caller caps it with `n_predict`, a share of the
 * context length can equal or exceed that cap and then bounds nothing — the
 * model spends the whole response thinking and stops at the cap with no answer.
 * So prefer the output cap when it is set, and never exceed the context.
 */
export function resolveLlamaCppThinkBudgetWindow(
	contextWindow: number | undefined,
	numPredict: number | undefined,
): number {
	const ctx = isPositiveInteger(contextWindow) ? contextWindow : 0;
	const predict = isPositiveInteger(numPredict) ? numPredict : 0;
	if (predict <= 0) {
		return ctx;
	}
	return ctx > 0 ? Math.min(predict, ctx) : predict;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Resolve a configured `thinkBudget` to the absolute token count llama.cpp
 * wants, or `undefined` when it does not resolve to one.
 *
 * The field is tri-valued by design, matching Ollama's: a bare token count, an
 * effort level, or absent. A level with no window to take a share of yields
 * nothing rather than a guess — sending `0` would read as "no thinking at all"
 * to the server, which is the opposite of what an effort level asks for.
 */
export function resolveLlamaCppThinkBudgetTokens(
	thinkBudget: string | undefined,
	window: number,
): number | undefined {
	if (thinkBudget === undefined) {
		return undefined;
	}
	const raw = thinkBudget.trim();
	if (raw === "") {
		return undefined;
	}
	const asCount = Number(raw);
	if (Number.isFinite(asCount)) {
		return asCount > 0 ? Math.floor(asCount) : undefined;
	}
	const fraction = LLAMACPP_THINK_BUDGET_FRACTION[canonicalThinkLevel(raw)];
	if (!fraction || window <= 0) {
		return undefined;
	}
	// Rounded down, so the budget never consumes the whole window.
	const budget = Math.floor((window * fraction[0]) / fraction[1]);
	return budget > 0 ? budget : undefined;
}

/**
 * Translate the configured sampler onto llama.cpp's request body.
 *
 * Only fields the user actually set are sent; see the note at the top of this
 * file for why that matters on a shared code path. An empty `stop` list is
 * dropped for the same reason — it is not an instruction to clear the server's.
 */
export function buildLlamaCppSamplingOptions(
	sampling: ProviderSamplingOptions | undefined,
	budget?: {
		contextWindow?: number;
		numPredict?: number;
		/**
		 * The level the request asks for, which is what the provider panel's
		 * dropdown actually writes.
		 *
		 * This used to be missing, and the omission is the whole defect: the
		 * builder bailed out above when no *sampler* was configured, so a user
		 * who set nothing but an effort level sent no budget at all. Measured
		 * live on an opencoti server 2026-09-18, `reasoning_effort` -- the field
		 * the AI SDK emits for the level -- is discarded outright, so the
		 * thinking was unbounded for every one of those requests.
		 */
		effort?: string;
		/** `false` means reason as little as possible, which here is a budget of 0. */
		enabled?: boolean;
	},
): Record<string, unknown> {
	const options: Record<string, unknown> = {};
	for (const [key, wireName] of Object.entries(LLAMACPP_SAMPLING_WIRE_NAMES)) {
		if (!sampling) {
			break;
		}
		const value = sampling[key as keyof ProviderSamplingOptions];
		if (value === undefined || value === null) {
			continue;
		}
		if (typeof value === "number" && !Number.isFinite(value)) {
			continue;
		}
		if (typeof value === "string" && value.trim() === "") {
			continue;
		}
		if (Array.isArray(value)) {
			const entries = value.filter(
				(entry) => typeof entry === "string" && entry !== "",
			);
			if (entries.length === 0) {
				continue;
			}
			options[wireName] = entries;
			continue;
		}
		options[wireName] = value;
	}
	// The budget last, because it is the one field whose value is computed
	// rather than copied: the window it is a share of depends on the output cap
	// this very sampler may have set.
	const window = resolveLlamaCppThinkBudgetWindow(
		budget?.contextWindow,
		isPositiveInteger(sampling?.numPredict)
			? sampling?.numPredict
			: budget?.numPredict,
	);
	const budgetTokens = resolveLlamaCppReasoningBudget(
		{
			thinkBudget: sampling?.thinkBudget,
			effort: budget?.effort,
			enabled: budget?.enabled,
		},
		window,
	);
	if (budgetTokens !== undefined) {
		options.reasoning_budget_tokens = budgetTokens;
	}
	return options;
}

/**
 * The one budget this provider will be sent, from the two places it can come
 * from.
 *
 * Precedence mirrors what the panel makes mutually exclusive: an explicit count
 * is "Custom (reasoning_budget_tokens)" and is the number the user typed, so it
 * outranks a level, which is only ever a share. Neither set means **unbounded**
 * -- and unlike Ollama, where an absent budget hands the decision to the model's
 * own `think_budget`, absent here means the engine bounds nothing at all. So
 * nothing is sent rather than a computed default, and a budget then comes only
 * from the server's own command-line flag if one was given.
 */
export function resolveLlamaCppReasoningBudget(
	source: {
		thinkBudget?: string;
		effort?: string;
		enabled?: boolean;
	},
	window: number,
): number | undefined {
	// Reasoning switched off is not "no preference": it is the smallest budget
	// the engine will take. Verified on the live server -- 0 and 1 both return
	// the same floor, so 0 reads as "as little as possible" rather than as unset.
	if (source.enabled === false) {
		return 0;
	}
	const explicit = resolveLlamaCppThinkBudgetTokens(source.thinkBudget, window);
	if (explicit !== undefined) {
		return explicit;
	}
	return resolveLlamaCppThinkBudgetTokens(source.effort, window);
}

/**
 * The sampler the user configured for this provider entry.
 *
 * Read from the same place every vendor reads it — `providers.json`'s
 * `sampling` — so a value typed into the settings panel reaches a llama.cpp
 * server by the same route it reaches Ollama.
 */
export function readLlamaCppSamplingOptions(
	config: GatewayResolvedProviderConfig | undefined,
): ProviderSamplingOptions | undefined {
	const sampling = config?.options?.sampling;
	return sampling && typeof sampling === "object"
		? (sampling as ProviderSamplingOptions)
		: undefined;
}

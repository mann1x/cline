/**
 * One session's output cap and thinking allowance, for every host.
 *
 * The VS Code factory resolved these for itself and the CLI did not, so at one
 * commit the two sent different numbers for the same model: on a 196,608-token
 * Ollama window the plugin asked for 96,000 tokens a turn (three quarters of
 * the window, under the ceiling) and 24,000 of thinking at `medium`, while the
 * CLI -- and so every harness run -- fell through to the gateway's flat share,
 * 49,152 and 12,288. A test harness that thinks on half the plugin's budget is
 * not measuring the plugin, and a change tuned on one misleads the other. So
 * the rule lives here and both hosts call it.
 *
 * The order is the factory's, verbatim:
 *  - the cap is a configured `num_predict`, then a per-turn override, then a
 *    manual budget, then `auto` against the session's window, then the
 *    gateway's own default;
 *  - thinking is asked of the server on Ollama, which resolves a level itself,
 *    and computed from the same table on a llama.cpp server, which takes an
 *    absolute count;
 *  - the budget message is the configured one, then the model's own.
 */

import * as Llms from "@cline/llms";
import {
	isOllamaNativeProvider,
	type OutputBudgetMode,
	resolveOutputBudgetTokens,
} from "@cline/shared";

export type SessionThinkingEngine = "ollama" | "llamacpp";

/**
 * Engines that take a per-turn thinking budget. Ollama resolves one from a
 * level; a llama.cpp server -- opencoti included -- takes
 * `reasoning_budget_tokens`, an absolute count.
 */
export function sessionThinkingEngine(
	providerId: string,
): SessionThinkingEngine | undefined {
	if (isOllamaNativeProvider(providerId)) {
		return "ollama";
	}
	return providerId === "opencoti" || providerId === "openai-compatible"
		? "llamacpp"
		: undefined;
}

const positive = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;

export interface SessionOutputCapInput {
	/** `sampling.numPredict`: what goes on the wire ahead of anything else. */
	configuredNumPredict?: number;
	/** A per-turn cap the session or the model override set. */
	maxTokensPerTurn?: number;
	outputBudget?: { mode?: OutputBudgetMode; maxTokens?: number };
	/** The session's one window: configured, then declared, then catalog. */
	contextWindow?: number;
	/** What the model says it can emit, when the catalog knows. */
	modelMaxOutputTokens?: number;
}

/** The per-turn cap: what the prompt states and the server truncates at. */
export function resolveSessionOutputCap(input: SessionOutputCapInput): number {
	const explicit =
		positive(input.configuredNumPredict) ??
		positive(input.maxTokensPerTurn) ??
		(input.outputBudget?.mode === "manual"
			? positive(input.outputBudget.maxTokens)
			: undefined);
	if (explicit !== undefined) {
		return Math.floor(explicit);
	}
	return (
		resolveOutputBudgetTokens({
			mode: input.outputBudget?.mode ?? "auto",
			maxTokens: input.outputBudget?.maxTokens,
			contextWindow: input.contextWindow,
			modelMaxOutputTokens: positive(input.modelMaxOutputTokens),
		}) ??
		Llms.resolveDefaultMaxOutputTokens({
			contextWindow: positive(input.contextWindow),
			maxOutputTokens: positive(input.modelMaxOutputTokens),
		})
	);
}

export interface SessionThinkingInput {
	providerId: string;
	modelId: string | undefined;
	baseUrl: string | undefined;
	/** `false` is thinking switched off; anything else leaves it to the level. */
	thinking?: boolean;
	reasoningEffort?: string;
	/** `sampling.thinkBudget`: a level or a bare count, llama.cpp only. */
	configuredThinkBudget?: string;
	configuredNumPredict?: number;
	outputCap: number;
	contextWindow: number | undefined;
	fetchImpl: typeof fetch;
	/**
	 * How Ollama is asked, when a host has its own transport (the extension's
	 * proxy-aware fetch and retry ladder). The question is the same either way:
	 * this model, this level, this num_predict and num_ctx.
	 */
	probeOllama?: (
		baseUrl: string | undefined,
		modelId: string,
		query: { think: string; numPredict: number; numCtx: number | undefined },
	) => Promise<{ level: string; budgetTokens: number } | undefined>;
}

/** The thinking allowance this session will run under, or nothing to state. */
export async function resolveSessionThinkingAllowance(
	input: SessionThinkingInput,
): Promise<{ level: string; budgetTokens: number } | undefined> {
	const engine = sessionThinkingEngine(input.providerId);
	if (!engine || input.thinking === false || !input.modelId) {
		return undefined;
	}
	// The level this session sends; the vendor fills in its default when
	// nothing set one, so that is the level to ask about.
	const think =
		input.reasoningEffort?.trim() || Llms.OLLAMA_DEFAULT_REASONING_EFFORT;
	// A configured num_predict is the cap the server applies; the session's own
	// cap stands in when nothing more specific was set.
	const numPredict = positive(input.configuredNumPredict) ?? input.outputCap;
	if (engine === "llamacpp") {
		const level = input.configuredThinkBudget?.trim() || think;
		const budgetTokens = Llms.resolveLlamaCppThinkBudgetTokens(
			level,
			Llms.resolveLlamaCppThinkBudgetWindow(input.contextWindow, numPredict),
		);
		return budgetTokens === undefined ? undefined : { level, budgetTokens };
	}
	const query = { think, numPredict, numCtx: input.contextWindow };
	return input.probeOllama
		? input.probeOllama(input.baseUrl, input.modelId, query)
		: Llms.probeOllamaThinkBudget(
				input.baseUrl,
				input.modelId,
				query,
				input.fetchImpl,
			);
}

/**
 * What the server appends to reasoning it cut at the budget: the configured
 * message, which goes on the wire and overrides the model file, then the
 * model's own as Ollama reported it.
 */
export function resolveSessionThinkBudgetMessage(input: {
	providerId: string;
	modelId: string | undefined;
	baseUrl: string | undefined;
	configuredMessage?: string;
}): string | undefined {
	const configured = input.configuredMessage?.trim();
	if (configured) {
		return configured;
	}
	return isOllamaNativeProvider(input.providerId)
		? Llms.readDeclaredThinkBudgetMessage(input.baseUrl, input.modelId)
		: undefined;
}

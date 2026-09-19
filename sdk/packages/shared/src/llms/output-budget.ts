/**
 * One output budget, shared by every provider that takes one.
 *
 * The same number is called three things and configured in two places today:
 * Ollama's `num_predict` (built in `readOllamaNumPredict` from the request's
 * `maxTokens`, then overwritten by whatever `sampling.numPredict` the Ollama
 * advanced panel holds), llama.cpp's and opencoti's `n_predict` (read from
 * `sampling.numPredict`, falling back to the same request cap), and the
 * catalog's `maxTokens`. Two settings for one quantity means they can disagree,
 * and the panel's copy silently wins.
 *
 * This resolves it once. The providers keep their own field names on the wire --
 * that part is the vendors' business -- but the number they send comes from
 * here.
 */

/**
 * The most this will ever ask for, however wide the window.
 *
 * Models that advertise a megatoken window start struggling well before they
 * reach it, so a share of the window is not a safe rule on its own past about
 * half a million tokens. This is the operator-set bound on that, and `auto` is
 * clamped to it rather than being trusted to stay sensible on a 1M model.
 */
export const OUTPUT_BUDGET_CEILING_TOKENS = 512_000;

/**
 * What `auto` asks for, as a share of the context window.
 *
 * Measured rather than chosen: 96,000 against a 128,000 window is the setting
 * that made v9-agentic work well on 2026-09-17, and that is three quarters.
 * Deliberately generous, because the cap's job is to not truncate a turn, not
 * to ration one -- the same session's turns actually cost 392 to 23,140 tokens.
 * What the budget must *not* do is push the compaction trigger down, and that
 * is a property of what compaction reserves, not of what the request asks for;
 * see `resolveCompactionTriggerTokens`.
 */
export const OUTPUT_BUDGET_AUTO_WINDOW_SHARE = 0.75;

export type OutputBudgetMode = "auto" | "manual";

export interface OutputBudgetInput {
	/** Unset reads as `auto`: a profile written before this setting existed. */
	mode?: OutputBudgetMode;
	/**
	 * On `manual`, the cap to send. On `auto`, the user's own ceiling, which may
	 * only lower {@link OUTPUT_BUDGET_CEILING_TOKENS}, never raise it. Empty in
	 * both cases means "the default", which is why `manual` with nothing typed
	 * resolves to the same number `auto` would.
	 */
	maxTokens?: number;
	contextWindow?: number;
	/** What the model itself says it can emit, when the catalog knows. */
	modelMaxOutputTokens?: number;
}

const positive = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * The cap to send, or `undefined` when there is nothing to size against.
 *
 * `undefined` is a real answer and not a failure: with no window and no typed
 * value there is no honest number, and the gateway's own default is a better
 * guess than one invented here.
 */
export function resolveOutputBudgetTokens(
	input: OutputBudgetInput,
): number | undefined {
	const ceiling = OUTPUT_BUDGET_CEILING_TOKENS;
	const modelBound = positive(input.modelMaxOutputTokens)
		? input.modelMaxOutputTokens
		: Number.POSITIVE_INFINITY;

	if (input.mode === "manual" && positive(input.maxTokens)) {
		// Not clamped to `modelMaxOutputTokens`: manual is the user overriding a
		// catalog entry that is routinely wrong for a local model, and clamping
		// it there would make the box unable to do the one thing it is for.
		return Math.floor(Math.min(input.maxTokens, ceiling));
	}

	if (!positive(input.contextWindow)) {
		return undefined;
	}

	const autoCeiling = positive(input.maxTokens)
		? Math.min(input.maxTokens, ceiling)
		: ceiling;
	const target = input.contextWindow * OUTPUT_BUDGET_AUTO_WINDOW_SHARE;
	return Math.max(1, Math.floor(Math.min(target, autoCeiling, modelBound)));
}

/**
 * The share of the cap a model is told to aim for when the cap is effectively
 * the whole context window, leaving the rest for the conversation.
 */
const OUTPUT_BUDGET_SAFE_SHARE = 0.75;

/**
 * The point at which a per-turn cap stops being a cap and becomes the context
 * window: at or above this share of it, filling the cap leaves nothing for
 * anything else.
 */
const OUTPUT_BUDGET_WINDOW_SHARE_THRESHOLD = 0.9;

/**
 * Build the system-prompt section describing the per-turn output cap.
 *
 * Every request carries a `maxOutputTokens` the provider truncates at
 * (`num_predict`, for Ollama), and nothing in the prompt mentions it: the model
 * is asked for a full plan plus edits with no idea its reply will be cut off
 * mid-sentence, thinking included, and the turn wasted. When no per-model
 * override exists the value is the gateway default of 32,000, which on a
 * 32,768-token model is the entire context window — filling it leaves nothing
 * for the conversation and forces a compaction round trip.
 *
 * `thinking` names the share of that cap the model may spend reasoning, when
 * the provider enforces one. Ollama does: a level is a fraction of
 * `min(num_predict, num_ctx)`, computed server-side, and a model told only the
 * outer cap reads the whole of it as available to think in. Sessions ended on
 * "reached the maximum output token limit" with the entire allowance spent
 * inside the thinking block and no answer written.
 *
 * Exported for tests: the wording is the whole behaviour.
 */
export function buildOutputBudgetSection(
	outputCap: number,
	contextWindow: number | undefined,
	thinking?: { level: string; budgetTokens: number },
): string {
	let section =
		`\n\n# Output Budget\n\nEach reply you produce is capped at ${outputCap} tokens, thinking included. ` +
		"Anything past the cap is cut off mid-sentence and the turn is wasted.";
	if (thinking && thinking.budgetTokens > 0) {
		section +=
			` Of that, at most ${thinking.budgetTokens} tokens may be spent thinking (effort ${thinking.level}); ` +
			"reasoning past that point is cut short, so reach a decision inside it and write the answer with what is left.";
	}
	if (
		contextWindow !== undefined &&
		outputCap >= contextWindow * OUTPUT_BUDGET_WINDOW_SHARE_THRESHOLD
	) {
		const safeCap = Math.floor(outputCap * OUTPUT_BUDGET_SAFE_SHARE);
		const reservedPercent = Math.round((1 - OUTPUT_BUDGET_SAFE_SHARE) * 100);
		section +=
			` That cap is effectively the whole ${contextWindow}-token context window, so keep each reply under ` +
			`${safeCap} tokens and leave the remaining ${reservedPercent}% free for compaction.`;
	} else if (contextWindow !== undefined) {
		section += ` The context window is ${contextWindow} tokens.`;
	}
	section +=
		" Prefer several focused tool calls over one oversized reply: if the remaining work does not fit, " +
		"do the part that fits, call the tools it needs, and continue in the next turn.";
	return section;
}

/** The marker that says a prompt already states a per-turn cap. */
const OUTPUT_BUDGET_HEADING = "# Output Budget";

/**
 * Add the Output Budget section to a system prompt, unless it is already there.
 *
 * Every host's session is built through one bootstrap, and this is called from
 * it, so a host that does not assemble the section itself still tells the model
 * the cap its reply will be cut at. The CLI never did: the wording lived in the
 * VS Code factory, so a harness run and a plugin run at the same commit gave
 * the model different instructions about the same limit.
 *
 * The guard is not defensive tidiness. VS Code resolves a richer allowance --
 * it asks Ollama for the budget the server will actually enforce rather than
 * deriving one -- and appends the section before this runs. Appending a second
 * one would put two different caps in a single prompt, which is worse than
 * either alone, so the host's own statement wins where there is one.
 */
export function withOutputBudgetSection(
	systemPrompt: string,
	budget: {
		outputCap: number | undefined;
		contextWindow?: number;
		thinking?: { level: string; budgetTokens: number };
	},
): string {
	if (!positive(budget.outputCap)) {
		return systemPrompt;
	}
	if (systemPrompt.includes(OUTPUT_BUDGET_HEADING)) {
		return systemPrompt;
	}
	return `${systemPrompt}${buildOutputBudgetSection(
		budget.outputCap,
		budget.contextWindow,
		budget.thinking,
	)}`;
}

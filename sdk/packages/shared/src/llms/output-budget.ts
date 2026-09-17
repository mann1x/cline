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

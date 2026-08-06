/**
 * Ollama's own thinking-budget arithmetic, mirrored.
 *
 * Ollama does not consume `REASONING_EFFORT_RATIOS`. It receives a level as a
 * string and computes the budget server-side, from its own table and against
 * its own window, so the ratios in `reasoning-effort.ts` describe a different
 * provider's contract and predict the wrong number here. Anything on this side
 * that wants to say what a level will cost — a prompt section, a clamp, a log
 * line — has to use these values or it is guessing.
 *
 * The source of truth is `api/types.go` in the Ollama fork:
 * `thinkBudgetFraction`, `thinkLevelAliases`, `canonicalThinkLevel`,
 * `ThinkBudgetWindow` and `ThinkValue.BudgetTokens`. Keep the two in step; the
 * tests pin the fractions so a drift is a failure rather than a surprise.
 */

/**
 * The share of the window each level may spend inside a thinking block.
 *
 * Stored as an exact fraction rather than a float because the server divides
 * with integer arithmetic (`window * num / den`), and a float would round the
 * other way often enough to disagree by a token at the boundary.
 *
 * The steps halve instead of crowding the top of the range: how long a model
 * thinks depends on the prompt, not on how much room it was given, so shares
 * near the whole window stop bounding anything once the window is large. Note
 * that `max` is 4/5, not 1 — the budget never consumes the whole window,
 * because a model that spends its entire allowance thinking stops at the cap
 * with no answer written.
 */
export const OLLAMA_THINK_BUDGET_FRACTIONS: Readonly<
	Record<string, readonly [number, number]>
> = {
	max: [4, 5],
	high: [1, 2],
	medium: [1, 4],
	low: [1, 8],
	minimal: [1, 16],
};

/**
 * The level a request stands for when it does not name one.
 *
 * `medium` rather than the strongest: asking a model to think is not asking it
 * to think as hard as it can. Shared with the Ollama vendor so the level the
 * wire defaults to and the level this module costs out cannot drift apart.
 */
export const OLLAMA_DEFAULT_THINK_LEVEL = "medium" as const;

/**
 * Alternative spellings of a level.
 *
 * The AI SDK calls the top of its effort scale `xhigh`, which is the position
 * `max` holds here, so a client built on that vocabulary sends it verbatim.
 */
export const OLLAMA_THINK_LEVEL_ALIASES: Readonly<Record<string, string>> = {
	xhigh: "max",
};

/** Resolves an alias to the level it names; leaves anything else alone. */
export function canonicalOllamaThinkLevel(level: string): string {
	const normalized = level.trim().toLowerCase();
	return OLLAMA_THINK_LEVEL_ALIASES[normalized] ?? normalized;
}

/** Whether a level carries a budget, as opposed to reaching the model as a bare string. */
export function isBudgetedOllamaThinkLevel(level: string): boolean {
	return canonicalOllamaThinkLevel(level) in OLLAMA_THINK_BUDGET_FRACTIONS;
}

/**
 * The room a level is a share of.
 *
 * A level bounds thinking so the model still has space left to answer, which
 * makes the *response* length the thing to divide. When the caller caps the
 * response with `num_predict`, a share of the context length can equal or
 * exceed that cap and then bounds nothing. Prefer `num_predict` when it is
 * set, and never exceed the context.
 */
export function ollamaThinkBudgetWindow(
	numCtx: number | undefined,
	numPredict: number | undefined,
): number {
	const ctx = positiveOrZero(numCtx);
	const predict = positiveOrZero(numPredict);
	if (predict <= 0) {
		return ctx;
	}
	if (ctx > 0) {
		return Math.min(predict, ctx);
	}
	return predict;
}

/**
 * The tokens a level may spend thinking inside `window`, or 0 when the level
 * carries no budget. Rounds down, so the budget never consumes the whole
 * window.
 */
export function ollamaThinkBudgetTokens(
	level: string,
	window: number,
): number {
	const fraction = OLLAMA_THINK_BUDGET_FRACTIONS[canonicalOllamaThinkLevel(level)];
	if (!fraction || window <= 0) {
		return 0;
	}
	const budget = Math.floor((window * fraction[0]) / fraction[1]);
	return budget > 0 ? budget : 0;
}

/**
 * What a configured `think_budget` will actually cost, given the room this
 * request has.
 *
 * A level scales with the window and so shrinks along with `num_predict` as
 * the conversation grows. A literal token count does not: it was chosen once,
 * against a window that no longer exists, and once it reaches or exceeds the
 * response cap the model spends the whole reply thinking and the turn ends on
 * the output limit with nothing written. Clamping a literal to the same share
 * a level would have taken is what keeps a fixed number honest.
 */
export function resolveOllamaThinkBudget(input: {
	thinkBudget?: string | number;
	level?: string;
	numCtx?: number;
	numPredict?: number;
}): { tokens: number; window: number; clamped: boolean } {
	const window = ollamaThinkBudgetWindow(input.numCtx, input.numPredict);
	const ceiling = input.level
		? ollamaThinkBudgetTokens(input.level, window)
		: ollamaThinkBudgetTokens("max", window);

	const literal = parseLiteralBudget(input.thinkBudget);
	if (literal !== undefined) {
		if (ceiling > 0 && literal > ceiling) {
			return { tokens: ceiling, window, clamped: true };
		}
		return { tokens: literal, window, clamped: false };
	}

	const level =
		typeof input.thinkBudget === "string" && input.thinkBudget.trim() !== ""
			? input.thinkBudget
			: input.level;
	if (!level) {
		return { tokens: 0, window, clamped: false };
	}
	return {
		tokens: ollamaThinkBudgetTokens(level, window),
		window,
		clamped: false,
	};
}

function parseLiteralBudget(value: string | number | undefined) {
	if (typeof value === "number") {
		return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
	}
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	// `Number.parseInt` would read "4high" as 4; a budget is the whole string
	// or it is a level.
	if (!/^\d+$/.test(trimmed)) {
		return undefined;
	}
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveOrZero(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: 0;
}

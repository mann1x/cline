/**
 * Chars-per-token approximation used for compaction triggering, request-size
 * diagnostics and the remaining-context term of the output cap.
 *
 * 3 chars/token is the starting point: it deliberately over-counts against the
 * conventional 4 so trigger thresholds fire before provider rejection rather
 * than after. It stays the value in force until a provider reports what a
 * request actually cost, after which `observeRequestTokens` replaces it with
 * the measured ratio for that provider and that content.
 *
 * The reason to prefer a measured ratio over a conservative constant is that
 * over-counting is only safe in one direction. It makes the compaction trigger
 * fire early (safe), but it also shrinks the remaining-context term that caps
 * output (not safe) -- and that term is a difference of two large numbers, so
 * it amplifies whatever error the approximation carries. Measured against one
 * provider's own tokenizer, 3 ran 15-18% high on reasoning-heavy English, and
 * a 0.14% error in the estimate became an 18.4% error in the cap. Safety
 * margin belongs in the thresholds that want it -- which already state it
 * explicitly -- not in the approximation every caller reads.
 */

export const CHARS_PER_TOKEN = 3;

/**
 * The same approximation, for reasoning text specifically.
 *
 * One ratio for a whole request is a weighted average of two populations that
 * do not tokenize alike. A serialized request is mostly JSON, code and tool
 * output — punctuation, escapes and identifiers, where a character is often
 * not a token's worth of anything, measured on this workload at 3.8 to 4.4
 * characters per token. Reasoning is prose the model wrote for itself, and runs
 * near 2.7.
 *
 * Averaging them works exactly as long as the mix holds still, and it does not:
 * reasoning was between 32% and 61% of a live transcript by characters and
 * moved every turn. Each departure from the average becomes error, and the
 * error is not symmetric in consequence. A request that is unusually
 * reasoning-heavy is *undercounted*, which is the direction that lets a request
 * be built too large — measured live at 71,610 estimated tokens for a request
 * the server then rejected against a 110,000 window, which cost that run its
 * transcript: overflow recovery is deliberately deterministic, so it fell to
 * basic compaction and cut nineteen messages to three.
 *
 * So the two are counted apart. This is the starting point for the reasoning
 * half, replaced by measurement as soon as a turn reports what its own output
 * cost.
 */
export const THINKING_CHARS_PER_TOKEN = 2.7;

/**
 * A ratio outside these bounds says something went wrong with the measurement
 * rather than something about the content -- a truncated request, a provider
 * counting something other than the prompt -- so it is discarded.
 *
 * The upper bound has to clear what a large-vocabulary tokenizer does to a
 * serialized request, which is well past the 4-ish chars/token of plain English:
 * `measureRequestInputChars` counts JSON, where every quote, brace and escape is
 * a character but rarely a token of its own. Measured on Gemma-4 (262k vocab)
 * against its own count: 645,803 serialized characters for 78,138 prompt tokens,
 * a ratio of 8.26. At a ceiling of 8 that observation -- and every later one in
 * the session -- was discarded as broken, so the ratio stayed frozen at a stale
 * 5.07 while the estimate it fed ran 1.7x high, and the remaining-context term
 * of the output cap decayed from 14,695 tokens to 60 over ten turns.
 */
const MIN_OBSERVED_CHARS_PER_TOKEN = 1.2;
const MAX_OBSERVED_CHARS_PER_TOKEN = 16;

/** Weight given to the newest observation once a baseline exists. */
const OBSERVATION_WEIGHT = 0.3;

/**
 * Calibration state, held on `globalThis` rather than in module scope.
 *
 * Module scope would be the obvious home and is the wrong one here, because
 * this module does not exist once at runtime. `@cline/llms` bundles internal
 * workspace code into its own output ("bundle internal workspace code" --
 * llms/bun.mts filters `@cline/*` out of `external`), while `@cline/core`
 * keeps its declared dependencies external and imports the published package.
 * So the gateway, which records what a request cost, and the compaction
 * pipeline, which reads it back, run against two different copies of this file
 * with two different sets of module variables.
 *
 * That is not a hypothetical: it shipped. Across 14 consecutive compaction
 * decisions the observed request count stayed `undefined` and the ratio stayed
 * on its 3.0 default while the provider was reporting real counts on every
 * turn -- so the trigger fell back to an estimate running 1.96x high, and
 * compacted transcripts that had ample room.
 *
 * `Symbol.for` resolves through the cross-realm registry, so every copy of
 * this module -- however many the bundler produces -- addresses the same slot.
 */
const CALIBRATION_STATE = Symbol.for("cline.shared.tokenCalibration");

interface TokenCalibrationState {
	charsPerToken?: number;
	thinkingCharsPerToken?: number;
	requestTokens?: number;
	contextOverflow?: ContextOverflowReport;
	outputCap?: OutputCapReport;
}

/**
 * What the request path found when it ran out of room.
 *
 * Every other trigger in this file is a projection: a character count, a ratio,
 * a share held back against the ratio being wrong. This one is not. It is the
 * budget arithmetic having already failed for a request that was about to go
 * out, which is true whatever the projections said.
 */
export interface ContextOverflowReport {
	contextWindow: number;
	estimatedInputTokens: number;
	reserveTokens: number;
	remainingContext: number;
	minOutputTokens: number;
}

/**
 * Which term set the output cap on the last request.
 *
 * `requested` is the caller's own limit (a configured `num_predict`, say),
 * `model-max-output` the model's declared ceiling, `default` the synthesized
 * fallback -- none of which compaction can move. `remaining-context` and
 * `context-overflow` are the window: the room left after the prompt, which is
 * exactly what compaction makes.
 */
export type OutputCapSource =
	| "requested"
	| "default"
	| "model-max-output"
	| "remaining-context"
	| "context-overflow"
	| "uncapped";

/**
 * What limited the reply, recorded for whoever has to react to a truncation.
 *
 * A turn cut off at its output cap looks identical either way -- same finish
 * reason, same half-written message -- but the two causes want opposite
 * responses. A window-bound cap is compaction's to fix. A cap that came from
 * the request or the model is not: shrinking the transcript cannot raise it, so
 * compacting there spends the transcript to change nothing, and the turn is
 * retried against the same ceiling with less of the work it was doing.
 */
export interface OutputCapReport {
	maxTokens?: number;
	source: OutputCapSource;
	/** Whether the winning term was the context window. */
	windowBound: boolean;
}

function calibration(): TokenCalibrationState {
	const container = globalThis as unknown as Record<symbol, unknown>;
	const existing = container[CALIBRATION_STATE] as
		| TokenCalibrationState
		| undefined;
	if (existing) {
		return existing;
	}
	const created: TokenCalibrationState = {};
	container[CALIBRATION_STATE] = created;
	return created;
}

/**
 * The ratio in force: measured if a provider has reported one, otherwise the
 * conservative default.
 */
export function charsPerToken(): number {
	return calibration().charsPerToken ?? CHARS_PER_TOKEN;
}

/** The reasoning ratio in force: measured if a turn has reported one. */
export function thinkingCharsPerToken(): number {
	return calibration().thinkingCharsPerToken ?? THINKING_CHARS_PER_TOKEN;
}

/**
 * Record what a turn's own output cost, to calibrate the reasoning ratio.
 *
 * The evidence is already in the transcript: a completed assistant turn carries
 * the provider's own output-token count alongside the characters it produced.
 * Only turns that are mostly reasoning are used — the caller decides that,
 * since it is the one holding the message — because a turn that is mostly a
 * tool call would teach this ratio about JSON.
 */
export function observeThinkingTokens(chars: number, tokens: number): void {
	if (!Number.isFinite(chars) || !Number.isFinite(tokens)) {
		return;
	}
	if (chars <= 0 || tokens <= 0) {
		return;
	}
	const ratio = chars / tokens;
	if (
		ratio < MIN_OBSERVED_CHARS_PER_TOKEN ||
		ratio > MAX_OBSERVED_CHARS_PER_TOKEN
	) {
		return;
	}
	const state = calibration();
	state.thinkingCharsPerToken =
		state.thinkingCharsPerToken === undefined
			? ratio
			: state.thinkingCharsPerToken * (1 - OBSERVATION_WEIGHT) +
				ratio * OBSERVATION_WEIGHT;
}

/** Tokens for reasoning text, which is denser than the rest of a request. */
export function estimateThinkingTokens(chars: number): number {
	return Math.max(1, Math.ceil(chars / thinkingCharsPerToken()));
}

/**
 * Record that a request of `chars` characters cost `tokens` input tokens
 * according to the provider. The first observation is taken whole -- the
 * default it replaces is a guess, not a measurement -- and subsequent ones are
 * smoothed, so one unusual request cannot move the estimate far.
 *
 * The count and the ratio are recorded independently, because only one of them
 * can be wrong. `tokens` is what the provider counted for the request that just
 * ran; nothing about the character measurement can make that untrue. The ratio
 * pairs it with a character count, and a mismatched pairing is what the bounds
 * above reject -- so a rejected ratio must not take the count down with it.
 * Keeping them together froze `lastObservedRequestTokens` at a count from
 * fourteen turns earlier while the compaction trigger kept reading it.
 */
export function observeRequestTokens(
	chars: number,
	tokens: number,
	reasoningChars?: number,
): void {
	if (!Number.isFinite(chars) || !Number.isFinite(tokens)) {
		return;
	}
	if (chars <= 0 || tokens <= 0) {
		return;
	}
	const state = calibration();
	state.requestTokens = tokens;
	// With the reasoning share known, this ratio describes the rest of the
	// request rather than a blend of two populations. Charging reasoning at its
	// own rate first and calibrating on what is left is what keeps the two
	// halves of the estimate from both trying to account for the same
	// characters.
	const reasoning =
		typeof reasoningChars === "number" &&
		Number.isFinite(reasoningChars) &&
		reasoningChars > 0
			? Math.min(reasoningChars, chars)
			: 0;
	let ratio = chars / tokens;
	if (reasoning > 0 && reasoning < chars) {
		const remainingTokens = tokens - estimateThinkingTokens(reasoning);
		if (remainingTokens > 0) {
			ratio = (chars - reasoning) / remainingTokens;
		}
	}
	if (
		ratio < MIN_OBSERVED_CHARS_PER_TOKEN ||
		ratio > MAX_OBSERVED_CHARS_PER_TOKEN
	) {
		return;
	}
	state.charsPerToken =
		state.charsPerToken === undefined
			? ratio
			: state.charsPerToken * (1 - OBSERVATION_WEIGHT) +
				ratio * OBSERVATION_WEIGHT;
}

/**
 * Adopt a measurement taken from somewhere other than a live response, and only
 * while nothing has been measured in this process.
 *
 * A resumed session starts with no measurement at all, so the trigger falls
 * back to the character estimate — and that estimate assumes three characters
 * per token, against a measured 5.9 for real transcript content. Measured live
 * on two consecutive resumes: 237,977 and 261,494 estimated tokens against a
 * 115,200 trigger, both compacting immediately, while the same session had been
 * reporting 108,099 and 72,995 actual tokens minutes earlier in the previous
 * process. Every resume after a host restart therefore threw away most of the
 * transcript before the first request.
 *
 * The measurement is out there: the transcript records what the provider
 * counted for each turn it already ran. This is how it gets back in. It never
 * overwrites a live observation — a real response is always better evidence
 * than a reconstruction of one.
 */
export function seedRequestTokenCalibration(
	chars: number,
	tokens: number,
): void {
	if (calibration().charsPerToken !== undefined) {
		return;
	}
	observeRequestTokens(chars, tokens);
}

/**
 * What the last request actually cost, according to the provider, or
 * `undefined` before any response has been seen.
 *
 * Unlike an estimate this cannot be wrong -- it is what was counted -- but it
 * describes the previous request rather than the next one, so a caller trades
 * exactness for being one turn behind.
 */
export function lastObservedRequestTokens(): number | undefined {
	return calibration().requestTokens;
}

/**
 * Record that a request could not be given a usable output budget.
 *
 * The request path is the only place that learns this, and it learns it too
 * late to act: the prompt is already built. Compaction runs before the *next*
 * request and is the thing that can do something about it, so the finding is
 * left here for it to collect.
 *
 * This is deliberately not a threshold. A window whose remaining room will not
 * hold a minimum reply is full, whether or not any ratio agreed -- which is the
 * property that makes it worth having alongside the estimate-driven trigger
 * rather than instead of it.
 */
export function noteContextOverflow(report: ContextOverflowReport): void {
	calibration().contextOverflow = report;
}

/**
 * Take the pending overflow report, if there is one, and clear it.
 *
 * Consumed rather than read so a single overflow forces a single compaction:
 * left set, it would force one on every following turn, including the ones the
 * compaction it triggered had already made room for.
 */
export function consumeContextOverflow(): ContextOverflowReport | undefined {
	const state = calibration();
	const report = state.contextOverflow;
	state.contextOverflow = undefined;
	return report;
}

/**
 * Record which term capped the reply on the request that just went out.
 *
 * Read rather than consumed, unlike the overflow report above: that one is an
 * event that must force exactly one compaction, this one is a standing fact
 * about the last request, overwritten by the next. A reader asking "was the cap
 * that just truncated this turn the window's?" wants the answer to survive
 * being asked, and every request rewrites it before the question can go stale.
 */
export function noteOutputCap(report: OutputCapReport): void {
	calibration().outputCap = report;
}

/** What capped the last request, or `undefined` before the first one. */
export function lastOutputCap(): OutputCapReport | undefined {
	return calibration().outputCap;
}

/** Drop any measured ratio and fall back to `CHARS_PER_TOKEN`. */
export function resetTokenCalibration(): void {
	const state = calibration();
	state.charsPerToken = undefined;
	state.thinkingCharsPerToken = undefined;
	state.requestTokens = undefined;
	state.contextOverflow = undefined;
	state.outputCap = undefined;
}

export function estimateTokens(chars: number): number {
	return Math.max(1, Math.ceil(chars / charsPerToken()));
}

export interface TokenEstimatedRequest {
	systemPrompt?: string;
	messages: readonly unknown[];
	tools?: readonly unknown[];
}

function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	try {
		return (
			JSON.stringify(value, (_key, nestedValue: unknown) => {
				if (typeof nestedValue === "bigint") {
					return nestedValue.toString();
				}
				if (typeof nestedValue !== "object" || nestedValue === null) {
					return nestedValue;
				}
				if (seen.has(nestedValue)) {
					return "[Circular]";
				}
				seen.add(nestedValue);
				return nestedValue;
			}) ?? ""
		);
	} catch {
		return String(value ?? "");
	}
}

/**
 * Serialized size of the complete provider request payload, in characters.
 *
 * Separate from the token estimate because a caller that will later learn the
 * request's true token cost needs the character count to pair with it -- see
 * `observeRequestTokens`.
 */
/**
 * How much of the transcript's reasoning the provider will actually send.
 *
 * Mirrors the request path's own rule. Kept as a plain value rather than a
 * predicate so the estimator does not have to know which providers do what.
 */
export type ReasoningHistoryMode = "all" | "last" | "none";

/**
 * The messages as the provider will send them, for measurement purposes.
 *
 * The estimator measured the request it was handed; the provider then dropped
 * most of its reasoning and sent the rest. Everything between those two points
 * was counted and never transmitted.
 *
 * This was not a rounding error. Measured on a live 43-message session,
 * reasoning was between 32% and 61% of the transcript by characters, and the
 * share moved every turn as the model alternated between long thinking and
 * tool work -- so the estimate ran 5% high on one turn and 45% high two turns
 * later. Calibration cannot absorb that: pairing an inflated character count
 * with a true token count only teaches the ratio the *average* inflation, and
 * every departure from that average becomes error, always in the direction that
 * overstates the prompt and shrinks the output cap.
 */
function withSentReasoningOnly(
	messages: TokenEstimatedRequest["messages"],
	mode: ReasoningHistoryMode,
): TokenEstimatedRequest["messages"] {
	if (mode === "all" || messages === undefined) {
		return messages;
	}
	// "the last reasoning there is", not "the last message" -- the final message
	// is usually a tool result, and taking it would drop every block.
	let lastReasoningIndex = -1;
	if (mode === "last") {
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			if (hasReasoningPart((messages[i] as { content?: unknown })?.content)) {
				lastReasoningIndex = i;
				break;
			}
		}
	}
	return messages.map((message, index) => {
		const content = (message as { content?: unknown }).content;
		if (index === lastReasoningIndex || !hasReasoningPart(content)) {
			return message;
		}
		return {
			...(message as object),
			content: (content as unknown[]).filter((part) => !isReasoningPart(part)),
		} as (typeof messages)[number];
	});
}

/**
 * Both spellings of a reasoning part.
 *
 * The runtime's own messages call it `reasoning`; the stored transcript and the
 * `apiMessages` the compaction pipeline measures call it `thinking`. A filter
 * that knew only one would silently do nothing on the other -- which is not a
 * visible failure, just an estimate quietly back to counting what is never sent.
 */
const REASONING_PART_TYPES = new Set([
	"reasoning",
	"thinking",
	"redacted_thinking",
]);

function isReasoningPart(part: unknown): boolean {
	return (
		typeof part === "object" &&
		part !== null &&
		REASONING_PART_TYPES.has((part as { type?: string }).type ?? "")
	);
}

function hasReasoningPart(content: unknown): boolean {
	return Array.isArray(content) && content.some(isReasoningPart);
}

/**
 * How many of a request's characters are reasoning.
 *
 * Measured the same way the whole request is — serialized — so the two counts
 * are in the same unit and one can be subtracted from the other without the
 * remainder quietly meaning something else.
 */
export function measureRequestReasoningChars(
	request: TokenEstimatedRequest,
	options?: { reasoningHistory?: ReasoningHistoryMode },
): number {
	const messages = withSentReasoningOnly(
		request.messages,
		options?.reasoningHistory ?? "all",
	);
	let chars = 0;
	for (const message of messages) {
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) {
			continue;
		}
		for (const part of content) {
			if (isReasoningPart(part)) {
				chars += safeStringify(part).length;
			}
		}
	}
	return chars;
}

export function measureRequestInputChars(
	request: TokenEstimatedRequest,
	options?: { reasoningHistory?: ReasoningHistoryMode },
): number {
	const messages = withSentReasoningOnly(
		request.messages,
		options?.reasoningHistory ?? "all",
	);
	let serialized: string;
	try {
		serialized = JSON.stringify({
			systemPrompt: request.systemPrompt,
			messages,
			tools: request.tools,
		});
	} catch {
		serialized = [
			safeStringify(request.systemPrompt),
			safeStringify(messages),
			safeStringify(request.tools),
		].join("\n");
	}
	return serialized.length;
}

/**
 * Estimate the complete provider request payload so request execution and
 * pre-request policies use the same definition of input utilization.
 */
export function estimateRequestInputTokens(
	request: TokenEstimatedRequest,
	options?: { reasoningHistory?: ReasoningHistoryMode },
): number {
	const chars = measureRequestInputChars(request, options);
	const reasoningChars = Math.min(
		chars,
		measureRequestReasoningChars(request, options),
	);
	if (reasoningChars <= 0) {
		return estimateTokens(chars);
	}
	// Counted apart because they do not tokenize alike, and because the mix
	// moves every turn. See THINKING_CHARS_PER_TOKEN.
	return (
		estimateTokens(chars - reasoningChars) +
		estimateThinkingTokens(reasoningChars)
	);
}

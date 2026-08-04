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
 * A ratio outside these bounds says something went wrong with the measurement
 * rather than something about the content -- a truncated request, a provider
 * counting something other than the prompt -- so it is discarded.
 */
const MIN_OBSERVED_CHARS_PER_TOKEN = 1.2;
const MAX_OBSERVED_CHARS_PER_TOKEN = 8;

/** Weight given to the newest observation once a baseline exists. */
const OBSERVATION_WEIGHT = 0.3;

let observedCharsPerToken: number | undefined;
let observedRequestTokens: number | undefined;

/**
 * The ratio in force: measured if a provider has reported one, otherwise the
 * conservative default.
 */
export function charsPerToken(): number {
	return observedCharsPerToken ?? CHARS_PER_TOKEN;
}

/**
 * Record that a request of `chars` characters cost `tokens` input tokens
 * according to the provider. The first observation is taken whole -- the
 * default it replaces is a guess, not a measurement -- and subsequent ones are
 * smoothed, so one unusual request cannot move the estimate far.
 */
export function observeRequestTokens(chars: number, tokens: number): void {
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
	observedCharsPerToken =
		observedCharsPerToken === undefined
			? ratio
			: observedCharsPerToken * (1 - OBSERVATION_WEIGHT) +
				ratio * OBSERVATION_WEIGHT;
	observedRequestTokens = tokens;
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
	return observedRequestTokens;
}

/** Drop any measured ratio and fall back to `CHARS_PER_TOKEN`. */
export function resetTokenCalibration(): void {
	observedCharsPerToken = undefined;
	observedRequestTokens = undefined;
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
export function measureRequestInputChars(
	request: TokenEstimatedRequest,
): number {
	let serialized: string;
	try {
		serialized = JSON.stringify({
			systemPrompt: request.systemPrompt,
			messages: request.messages,
			tools: request.tools,
		});
	} catch {
		serialized = [
			safeStringify(request.systemPrompt),
			safeStringify(request.messages),
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
): number {
	return estimateTokens(measureRequestInputChars(request));
}

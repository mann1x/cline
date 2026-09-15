// LanguageModelV4 middleware that waits out an admission refusal instead of
// failing the turn on it.
//
// opencoti's KV admission gate (`--admission-poolless`, enforced by DEFAULT
// since 0236) and PolyKV's per-pool policy both refuse with `429` +
// `Retry-After`. That is a normal operating condition on a busy server, not a
// fault: the engine is telling the client when to come back, and the request
// has cost nothing -- the refusal happens before tokenisation, in under a
// millisecond, precisely so that a server never fails a request after charging
// it a prefill.
//
// Nothing read it. `@ai-sdk/openai-compatible` -- the vendor every llama.cpp
// endpoint including opencoti goes through -- passes no `isRetryable` predicate
// to `postToApi`, so `APICallError.isRetryable` is `undefined`, and the AI
// SDK's own retry (`shouldRetry: ... error.isRetryable === true`) declines.
// A subagent spawned against a saturated pool therefore died on the first
// refusal, which is the "subagents blocked by the floor_tps" failure: the
// engine had said "in two seconds", and the client heard "no".
//
// Why a middleware of its own rather than a branch in `retry-empty-response`:
// that one retries a stream that produced nothing, and it awaits its first
// `doStream()` eagerly, outside the ReadableStream it returns. A refusal
// rejects *that* call, before any stream exists, so it propagates out of the
// empty-response middleware untouched. The two failures happen at different
// moments and need different waits -- one is the server's own number, the other
// is a backoff of ours.
//
// This is applied INSIDE the empty-response retry, so that a refusal on one of
// that middleware's own re-dials is paced too.
//
// What is deliberately NOT handled here: the settling hold. On a pool whose
// admission measurement has not settled, the engine does not refuse -- it
// *holds* the request server-side in 150 ms steps up to `settle_max_ms`, then
// waives and admits. It never reaches a client as a 429, so there is nothing to
// distinguish and no retry budget to protect. On c7 there is also no
// `X-PolyKV-Settle-Waived` header to tell a waiver from a measured admit; c8
// adds one, and neither changes anything on this path.

import type { LanguageModelV4Middleware } from "@ai-sdk/provider";
import { classifyProviderError } from "../error-classification";
import { sleep } from "./backoff";

/** Minimal logger surface (a subset of `BasicLogger`). */
interface RetryLogger {
	log?(message: string, meta?: Record<string, unknown>): void;
}

export interface RetryRateLimitOptions {
	/** Total attempts including the first (so `4` means up to 3 retries). */
	maxAttempts?: number;
	/**
	 * Longest this will wait for one retry, whatever the server asked for.
	 *
	 * The engine's own answer is a flat `2`, but a proxy in front of it -- or a
	 * later release -- may name minutes, and an agent that disappears for ten
	 * of them is indistinguishable from one that hung.
	 */
	maxRetryAfterMs?: number;
	/** Wait when the refusal named no delay at all. */
	defaultRetryAfterMs?: number;
	logger?: RetryLogger;
	/** Seam for tests; the real one is abort-aware. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Default total attempts (first try + 3 retries). */
export const DEFAULT_RATE_LIMIT_MAX_ATTEMPTS = 4;
/** Default ceiling on one wait. */
export const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;
/** Default wait when the server named none. */
export const DEFAULT_RATE_LIMIT_RETRY_DELAY_MS = 2_000;

const MAX_WALK_DEPTH = 8;

function headerBag(value: unknown): Record<string, unknown> | undefined {
	if (value == null || typeof value !== "object") {
		return undefined;
	}
	// `Headers` where the runtime has it; a plain record from the AI SDK's
	// `responseHeaders`, which is already lower-cased.
	if (typeof (value as Headers).get === "function") {
		const raw = (value as Headers).get("retry-after");
		return raw == null ? undefined : { "retry-after": raw };
	}
	return value as Record<string, unknown>;
}

function retryAfterFrom(bag: Record<string, unknown>): string | undefined {
	for (const [key, value] of Object.entries(bag)) {
		if (key.toLowerCase() === "retry-after" && typeof value === "string") {
			return value;
		}
	}
	return undefined;
}

/**
 * The delay the server asked for, in milliseconds, or `undefined` when it
 * asked for none.
 *
 * RFC 7231 allows either a delta in seconds or an HTTP-date, and a date already
 * past reads as no wait rather than a negative one. Walked through the error's
 * `cause` chain because a rejection may arrive wrapped -- the AI SDK's
 * `APICallError` carries `responseHeaders`, but a transport that re-throws puts
 * it one or two levels down.
 */
export function readRetryAfterMs(error: unknown): number | undefined {
	let current: unknown = error;
	const seen = new Set<unknown>();
	for (
		let depth = 0;
		depth < MAX_WALK_DEPTH &&
		current != null &&
		typeof current === "object" &&
		!seen.has(current);
		depth++
	) {
		seen.add(current);
		const candidate = current as {
			responseHeaders?: unknown;
			headers?: unknown;
			cause?: unknown;
		};
		for (const source of [candidate.responseHeaders, candidate.headers]) {
			const bag = headerBag(source);
			const raw = bag && retryAfterFrom(bag);
			if (raw === undefined) {
				continue;
			}
			const trimmed = raw.trim();
			if (/^\d+$/.test(trimmed)) {
				return Number(trimmed) * 1000;
			}
			const at = Date.parse(trimmed);
			if (!Number.isNaN(at)) {
				return Math.max(0, at - Date.now());
			}
			// Named, but in no form anyone defines. Treat it as unnamed rather
			// than as zero, so the caller's own default applies.
			return undefined;
		}
		current = candidate.cause;
	}
	return undefined;
}

/**
 * Create a middleware that waits out admission refusals.
 *
 * Applied inside `withEmptyResponseRetry` so every request the turn makes --
 * the first and any empty-response re-dial -- is paced by the server's own
 * answer.
 */
export function createRetryRateLimitMiddleware(
	options: RetryRateLimitOptions = {},
): LanguageModelV4Middleware {
	const maxAttempts = Math.max(
		1,
		options.maxAttempts ?? DEFAULT_RATE_LIMIT_MAX_ATTEMPTS,
	);
	const maxRetryAfterMs = Math.max(
		0,
		options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS,
	);
	const defaultRetryAfterMs = Math.max(
		0,
		options.defaultRetryAfterMs ?? DEFAULT_RATE_LIMIT_RETRY_DELAY_MS,
	);
	const logger = options.logger;
	const wait = options.sleep ?? sleep;

	async function attempt<T>(
		call: () => PromiseLike<T>,
		abortSignal: AbortSignal | undefined,
		modelId: string | undefined,
	): Promise<T> {
		for (let n = 1; ; n++) {
			try {
				return await call();
			} catch (error) {
				// Keyed on the classification, which on this path is keyed on
				// the HTTP status alone -- c7's refusal body says `503` /
				// `unavailable_error` while the status is `429`, and the
				// poolless path still does in c8. A client that trusts the
				// body mis-handles every refusal.
				if (
					n >= maxAttempts ||
					abortSignal?.aborted === true ||
					classifyProviderError(error) !== "rate_limited"
				) {
					throw error;
				}
				const asked = readRetryAfterMs(error);
				const delayMs = Math.min(maxRetryAfterMs, asked ?? defaultRetryAfterMs);
				logger?.log?.(
					"Admission refused; waiting for the server's own retry-after",
					{
						severity: "warn",
						modelId,
						attempt: n,
						maxAttempts,
						retryAfterMs: delayMs,
						serverAskedMs: asked,
					},
				);
				await wait(delayMs, abortSignal);
				if (abortSignal?.aborted) {
					// Cancelled during the wait: surface the failure rather
					// than re-dialing a request nobody is waiting for.
					throw error;
				}
			}
		}
	}

	return {
		specificationVersion: "v4",
		wrapStream: ({ doStream, params, model }) =>
			attempt(doStream, params.abortSignal, model?.modelId),
		wrapGenerate: ({ doGenerate, params, model }) =>
			attempt(doGenerate, params.abortSignal, model?.modelId),
	};
}

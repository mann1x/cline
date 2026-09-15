import type {
	LanguageModelV4StreamPart,
	LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import {
	createRetryRateLimitMiddleware,
	readRetryAfterMs,
} from "./retry-rate-limit";

function streamOf(
	parts: LanguageModelV4StreamPart[],
): LanguageModelV4StreamResult {
	return {
		stream: new ReadableStream<LanguageModelV4StreamPart>({
			start(controller) {
				for (const part of parts) {
					controller.enqueue(part);
				}
				controller.close();
			},
		}),
	} as LanguageModelV4StreamResult;
}

const ok = streamOf([{ type: "stream-start", warnings: [] }]);

/**
 * The refusal opencoti actually sends, transcribed from the engine: status 429
 * with `Retry-After: 2`, and a body that says `503` / `unavailable_error`
 * because `format_error_response` maps UNAVAILABLE that way while the
 * transport status is forced to 429 (c7 G14, and still true on the poolless
 * path in c8). Nothing here may key on the body.
 */
function admissionRefusal(retryAfter = "2"): Error {
	return Object.assign(
		new Error("pool 3 admission rejected: kv headroom exhausted"),
		{
			statusCode: 429,
			responseHeaders: { "retry-after": retryAfter },
			responseBody: JSON.stringify({
				error: {
					code: 503,
					type: "unavailable_error",
					message: "pool 3 admission rejected",
				},
			}),
		},
	);
}

function run(
	doStream: () => Promise<LanguageModelV4StreamResult>,
	options: Parameters<typeof createRetryRateLimitMiddleware>[0] = {},
	abortSignal?: AbortSignal,
) {
	const middleware = createRetryRateLimitMiddleware({
		sleep: async () => {},
		...options,
	});
	// biome-ignore lint/style/noNonNullAssertion: wrapStream is always defined here
	return middleware.wrapStream!({
		doStream,
		doGenerate: vi.fn() as never,
		params: { abortSignal } as never,
		model: { modelId: "lfm2.5-2.6b" } as never,
	});
}

describe("readRetryAfterMs", () => {
	it("reads the seconds the engine sends", () => {
		expect(readRetryAfterMs(admissionRefusal())).toBe(2000);
	});

	// RFC 7231 allows a date as well as a delta, and nothing forbids a proxy
	// in front of the engine from rewriting one into the other.
	it("reads an HTTP-date as the time until it", () => {
		const at = new Date(Date.now() + 5_000).toUTCString();
		const ms = readRetryAfterMs(admissionRefusal(at));
		expect(ms).toBeGreaterThan(3_000);
		expect(ms).toBeLessThanOrEqual(6_000);
	});

	it("says nothing when the server named no delay", () => {
		expect(readRetryAfterMs(new Error("nope"))).toBeUndefined();
		expect(readRetryAfterMs(admissionRefusal("soon"))).toBeUndefined();
	});

	// A date already past is a delay of none, not a negative wait.
	it("never reads a delay as negative", () => {
		expect(
			readRetryAfterMs(
				admissionRefusal(new Date(Date.now() - 60_000).toUTCString()),
			),
		).toBe(0);
	});
});

describe("createRetryRateLimitMiddleware", () => {
	it("passes a request that is not refused straight through", async () => {
		const doStream = vi.fn(async () => ok);
		await run(doStream);
		expect(doStream).toHaveBeenCalledTimes(1);
	});

	// `--admission-poolless` is enforced by default, so this is a normal
	// operating condition on any busy server, not an error. Nothing retried it
	// before: openai-compatible never sets `isRetryable`, so the AI SDK's own
	// retry declines and the turn dies on the first refusal.
	it("waits the server's own Retry-After and comes back", async () => {
		const slept: number[] = [];
		const doStream = vi
			.fn()
			.mockRejectedValueOnce(admissionRefusal())
			.mockResolvedValueOnce(ok);

		await run(doStream, {
			sleep: async (ms: number) => {
				slept.push(ms);
			},
		});

		expect(doStream).toHaveBeenCalledTimes(2);
		expect(slept).toEqual([2000]);
	});

	// The engine's `Retry-After` is a fixed 2, but a proxy or a later release
	// may name minutes, and a subagent that disappears for ten of them is
	// indistinguishable from one that hung.
	it("waits no longer than the configured bound", async () => {
		const slept: number[] = [];
		const doStream = vi
			.fn()
			.mockRejectedValueOnce(admissionRefusal("600"))
			.mockResolvedValueOnce(ok);

		await run(doStream, {
			maxRetryAfterMs: 10_000,
			sleep: async (ms: number) => {
				slept.push(ms);
			},
		});

		expect(slept).toEqual([10_000]);
	});

	it("falls back to its own delay when the server names none", async () => {
		const slept: number[] = [];
		const refusal = Object.assign(new Error("admission rejected"), {
			statusCode: 429,
		});
		const doStream = vi
			.fn()
			.mockRejectedValueOnce(refusal)
			.mockResolvedValueOnce(ok);

		await run(doStream, {
			defaultRetryAfterMs: 1_500,
			sleep: async (ms: number) => {
				slept.push(ms);
			},
		});

		expect(slept).toEqual([1_500]);
	});

	it("gives up after the attempt budget and surfaces the refusal", async () => {
		const doStream = vi.fn().mockRejectedValue(admissionRefusal());
		await expect(run(doStream, { maxAttempts: 3 })).rejects.toThrow(
			/admission rejected/,
		);
		expect(doStream).toHaveBeenCalledTimes(3);
	});

	// Anything that is not a refusal is someone else's to handle: a 400 will
	// be refused identically however long we wait, and re-sending it spends a
	// prefill to learn nothing.
	it.each([
		[
			"a context overflow",
			Object.assign(
				new Error(
					"input (9k tokens) is larger than the max context size (8k tokens)",
				),
				{ statusCode: 400 },
			),
		],
		[
			"a server fault",
			Object.assign(new Error("internal"), { statusCode: 500 }),
		],
	])("does not retry %s", async (_name, error) => {
		const doStream = vi.fn().mockRejectedValue(error);
		await expect(run(doStream)).rejects.toThrow();
		expect(doStream).toHaveBeenCalledTimes(1);
	});

	it("does not re-dial after the user cancels during the wait", async () => {
		const controller = new AbortController();
		const doStream = vi.fn().mockRejectedValue(admissionRefusal());

		await expect(
			run(
				doStream,
				{
					sleep: async () => {
						controller.abort();
					},
				},
				controller.signal,
			),
		).rejects.toThrow();
		expect(doStream).toHaveBeenCalledTimes(1);
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	captureSdkError,
	isSdkErrorReported,
	markSdkErrorReported,
	normalizeSdkError,
	resetSdkErrorRateLimiterForTests,
	SDK_ERROR_RATE_LIMIT_MAX_PER_WINDOW,
	SDK_ERROR_RATE_LIMIT_WINDOW_MS,
	SDK_ERROR_TELEMETRY_EVENT,
	SdkErrorRateLimiter,
	sdkErrorRateLimitKey,
} from "./telemetry";

beforeEach(() => {
	resetSdkErrorRateLimiterForTests();
});

describe("SDK error telemetry", () => {
	it("normalizes unknown errors with sanitized, bounded messages", () => {
		const normalized = normalizeSdkError(
			new Error(
				"request failed: authorization=Bearer abc123 /Users/beatrix/project C:\\Users\\beatrix\\project C:/Users/beatrix/project",
			),
		);

		expect(normalized.error_type).toBe("Error");
		expect(String(normalized.error_message)).toContain("[redacted]");
		expect(String(normalized.error_message)).not.toContain("beatrix");
		expect(String(normalized.error_message)).not.toContain("abc123");
	});

	it("bounds sanitized error messages", () => {
		const normalized = normalizeSdkError(new Error("x".repeat(100)), 48);

		expect(normalized.error_message).toHaveLength(48);
	});

	it("uses a stable fallback for errors without a message", () => {
		expect(normalizeSdkError(new Error("")).error_message).toBe(
			"Unknown error",
		);
		expect(normalizeSdkError([]).error_message).toBe("Unknown error");
		expect(normalizeSdkError({}).error_message).toBe("Unknown error");
	});

	it("prefers an explicitly extracted message while preserving raw metadata", () => {
		const normalized = normalizeSdkError(
			Object.assign(
				new Error("No output generated. Check the stream for errors."),
				{
					code: "invalid_request_error",
					statusCode: 400,
				},
			),
			undefined,
			"prompt is too long",
		);

		expect(normalized).toMatchObject({
			error_type: "Error",
			error_message: "prompt is too long",
			error_code: "invalid_request_error",
			error_status: 400,
		});
	});

	it("captures canonical SDK error events with context", () => {
		const telemetry = {
			capture: vi.fn(),
		};

		captureSdkError(telemetry as never, {
			component: "core",
			operation: "session.shutdown",
			error: Object.assign(new Error("boom"), { code: "EBOOM", status: 503 }),
			severity: "warn",
			context: {
				sessionId: "s1",
				component: "context",
				operation: "context.operation",
				severity: "fatal",
				handled: false,
				error_type: "ContextError",
				error_message: "unsanitized context message",
				error_code: "CONTEXT",
				error_status: 400,
			},
		});

		expect(telemetry.capture).toHaveBeenCalledWith({
			event: SDK_ERROR_TELEMETRY_EVENT,
			properties: expect.objectContaining({
				component: "core",
				operation: "session.shutdown",
				severity: "warn",
				handled: true,
				error_type: "Error",
				error_message: "boom",
				error_code: "EBOOM",
				error_status: 503,
				sessionId: "s1",
			}),
		});
	});
});

describe("SDK error cross-layer de-duplication", () => {
	function createTelemetry() {
		return { capture: vi.fn() };
	}

	it("reports the same error object exactly once across layers", () => {
		const telemetry = createTelemetry();
		const error = new Error("Upstream returned HTTP 429");

		const inner = captureSdkError(telemetry as never, {
			component: "llms",
			operation: "provider.stream",
			error,
			handled: true,
		});
		const outer = captureSdkError(telemetry as never, {
			component: "agents",
			operation: "agent.run",
			error,
			handled: false,
		});

		expect(inner).toBe(true);
		expect(outer).toBe(true);
		expect(telemetry.capture).toHaveBeenCalledTimes(1);
		expect(telemetry.capture).toHaveBeenCalledWith(
			expect.objectContaining({
				properties: expect.objectContaining({
					component: "llms",
					operation: "provider.stream",
				}),
			}),
		);
	});

	it("dedupes a wrapped error through its cause chain", () => {
		const telemetry = createTelemetry();
		const original = new Error("Upstream returned HTTP 429");

		captureSdkError(telemetry as never, {
			component: "llms",
			operation: "provider.stream",
			error: original,
		});
		const middle = new Error("stream failed", { cause: original });
		const outer = new Error("run failed", { cause: middle });
		captureSdkError(telemetry as never, {
			component: "agents",
			operation: "agent.run",
			error: outer,
		});

		expect(telemetry.capture).toHaveBeenCalledTimes(1);
	});

	it("still reports errors that were never seen by an inner layer", () => {
		const telemetry = createTelemetry();

		captureSdkError(telemetry as never, {
			component: "llms",
			operation: "provider.stream",
			error: new Error("first failure"),
		});
		captureSdkError(telemetry as never, {
			component: "agents",
			operation: "agent.run",
			error: new Error("second failure"),
		});

		expect(telemetry.capture).toHaveBeenCalledTimes(2);
	});

	it("returns false (and does not mark) when telemetry is unavailable", () => {
		const error = new Error("boom");

		expect(
			captureSdkError(undefined, {
				component: "llms",
				operation: "provider.stream",
				error,
			}),
		).toBe(false);
		expect(isSdkErrorReported(error)).toBe(false);
	});

	it("marks and detects reported errors, including frozen ones", () => {
		const frozen = Object.freeze(new Error("frozen"));
		markSdkErrorReported(frozen);
		expect(isSdkErrorReported(frozen)).toBe(true);

		markSdkErrorReported("not an object");
		expect(isSdkErrorReported("not an object")).toBe(false);
	});

	it("is cycle-safe when walking cause chains", () => {
		const a = new Error("a");
		const b = new Error("b", { cause: a });
		(a as { cause?: unknown }).cause = b;

		expect(isSdkErrorReported(a)).toBe(false);
		markSdkErrorReported(b);
		expect(isSdkErrorReported(a)).toBe(true);
	});
});

describe("SDK error rate limiting", () => {
	function createTelemetry() {
		return { capture: vi.fn() };
	}

	it("allows the first N identical errors then suppresses the rest", () => {
		const telemetry = createTelemetry();

		for (let i = 0; i < 100; i++) {
			captureSdkError(telemetry as never, {
				component: "llms",
				operation: "provider.stream",
				error: new Error("Upstream returned HTTP 429"),
			});
		}

		expect(telemetry.capture).toHaveBeenCalledTimes(
			SDK_ERROR_RATE_LIMIT_MAX_PER_WINDOW,
		);
	});

	it("does not suppress distinct errors", () => {
		const telemetry = createTelemetry();

		for (let i = 0; i < 10; i++) {
			captureSdkError(telemetry as never, {
				component: "llms",
				operation: "provider.stream",
				error: new Error(`distinct failure kind ${"x".repeat(i + 1)}`),
			});
		}

		expect(telemetry.capture).toHaveBeenCalledTimes(10);
	});

	it("coalesces messages that differ only by numbers into one key", () => {
		const key = (message: string) =>
			sdkErrorRateLimitKey(SDK_ERROR_TELEMETRY_EVENT, {
				component: "agents",
				operation: "agent.run",
				error_type: "Error",
				error_message: message,
			});

		expect(key("iteration 14 failed")).toBe(key("iteration 99 failed"));
		expect(key("iteration 14 failed")).not.toBe(key("compaction failed"));
	});

	it("carries suppressed_count onto the next allowed emission after the window resets", () => {
		let nowMs = 0;
		const limiter = new SdkErrorRateLimiter({
			maxPerWindow: 2,
			windowMs: 1_000,
			now: () => nowMs,
		});

		expect(limiter.admit("k")).toEqual({ allowed: true, suppressedCount: 0 });
		expect(limiter.admit("k")).toEqual({ allowed: true, suppressedCount: 0 });
		expect(limiter.admit("k").allowed).toBe(false);
		expect(limiter.admit("k").allowed).toBe(false);
		expect(limiter.admit("k").allowed).toBe(false);

		nowMs = 1_000;
		expect(limiter.admit("k")).toEqual({ allowed: true, suppressedCount: 3 });
		expect(limiter.admit("k")).toEqual({ allowed: true, suppressedCount: 0 });
	});

	it("bounds a 12-hour hot loop to dozens of events", () => {
		let nowMs = 0;
		const limiter = new SdkErrorRateLimiter({ now: () => nowMs });
		let emitted = 0;

		// One identical failure every 10 seconds for 12 hours.
		const totalMs = 12 * SDK_ERROR_RATE_LIMIT_WINDOW_MS;
		for (; nowMs < totalMs; nowMs += 10_000) {
			if (limiter.admit("hot-loop").allowed) {
				emitted += 1;
			}
		}

		expect(emitted).toBe(12 * SDK_ERROR_RATE_LIMIT_MAX_PER_WINDOW);
	});

	it("bounds tracked keys without throwing", () => {
		const limiter = new SdkErrorRateLimiter({ maxTrackedKeys: 4 });
		for (let i = 0; i < 100; i++) {
			expect(limiter.admit(`key-${i}`).allowed).toBe(true);
		}
	});
});

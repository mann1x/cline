import { describe, expect, it } from "vitest";
import {
	classifyTurnFault,
	classifyTurnFaultError,
	isKvEviction,
	isKvEvictionError,
} from "./turn-faults";

describe("what a failed turn was", () => {
	it("reads the 1tmrl restart and refusals as retryable faults", () => {
		expect(classifyTurnFault("server is shutting down")).toBe("transport");
		expect(
			classifyTurnFault(
				"pool 5 admission rejected: projected mean tps below floor",
			),
		).toBe("refusal");
		expect(
			classifyTurnFault(
				"admission rejected: context allocation exhausted (largest admissible 160 < peak 70000)",
			),
		).toBe("refusal");
	});

	it("reads gateways with nothing behind them and dropped sockets as transport", () => {
		for (const message of [
			"Bad Gateway",
			"503 Service Unavailable",
			"Gateway Timeout",
			"Loading model",
			"Cannot connect to API: connect ECONNREFUSED 10.0.0.2:8244",
			"socket hang up",
			"other side closed",
			"fetch failed",
			"terminated",
		]) {
			expect(classifyTurnFault(message), message).toBe("transport");
		}
	});

	it("reads a provider chunk the SDK could not read as transport", () => {
		// Verbatim from 4.100.195: opencoti's keepalive stream opened with
		// `data: null`, and 48 of 75 agents ended on this.
		for (const message of [
			'Type validation failed: Value: null.\nError message: [{"expected":"object","code":"invalid_type","path":[],"message":"Invalid input: expected object, received null"}]',
			'Type validation failed for chunk: Value: {"choices":"bogus"}.\nError message: invalid',
			'JSON parsing failed: Text: {"choices":[{"delta.\nError message: Unexpected end of JSON input',
		]) {
			expect(classifyTurnFault(message), message).toBe("transport");
		}
		// A tool call's own arguments are the model's, however they fail.
		expect(
			classifyTurnFault(
				"Invalid input for tool read_files: Type validation failed: Value: {}.",
			),
		).toBeUndefined();
	});

	it("reads a batch the engine failed to decode as transport", () => {
		// Verbatim from opencoti b108 on 8244: one slot's rebase left its
		// positions inconsistent, llama_decode failed the shared batch, and
		// every agent decoding in it ended on this -- 47 requests in 5 hits.
		for (const message of [
			"Invalid input batch.",
			"500 Invalid input batch.",
			"Error: Invalid input batch.",
		]) {
			expect(classifyTurnFault(message), message).toBe("transport");
		}
	});

	it("reads the engine's KV-full eviction as a refusal and its batch throw as transport", () => {
		// Verbatim from opencoti b108 on 8244, swarm 0926: 11 agents ended on
		// the eviction and 4 on the speculative sub-batch throw. Neither says
		// anything about the request; the eviction means "no room now".
		expect(
			classifyTurnFault(
				"Evicted to keep other in-flight requests alive: the KV cache could not fit another token and this was the largest live sequence. Context size has been exceeded.",
			),
		).toBe("refusal");
		expect(
			classifyTurnFault(
				"got exception: speculative batch index 32 is not inside the current sub-batch [0, 32)",
			),
		).toBe("transport");
	});

	it("reads the eviction's error_kind as a refusal, whatever its text says", () => {
		// kv_observable_v1 (opencoti b115, patch 0399): the partial evict's 500
		// carries `error_kind` beside `message`. The class is what the provider
		// layer derives from it; the text may be anything.
		expect(classifyTurnFault("Internal server error", "kv_evicted")).toBe(
			"refusal",
		);
		expect(isKvEviction("Internal server error", "kv_evicted")).toBe(true);
		const thrown = Object.assign(new Error("Internal server error"), {
			status: 500,
			responseBody: JSON.stringify({
				error: {
					code: 500,
					message: "Evicted to keep other in-flight requests alive",
					type: "server_error",
					error_kind: "evicted_kv_full",
				},
			}),
		});
		expect(classifyTurnFaultError(thrown)).toBe("refusal");
		expect(isKvEvictionError(thrown)).toBe(true);
		expect(
			isKvEvictionError({
				error: { message: "x", error_kind: "evicted_kv_full" },
			}),
		).toBe(true);
	});

	it("tells the eviction from every other refusal", () => {
		// Older engines name no error_kind: the text still says it.
		expect(
			isKvEviction(
				"Evicted to keep other in-flight requests alive: the KV cache could not fit another token.",
			),
		).toBe(true);
		expect(
			isKvEviction("pool 5 admission rejected: projected mean tps below floor"),
		).toBe(false);
		expect(isKvEviction("slow down", "rate_limited")).toBe(false);
		expect(
			isKvEvictionError(
				Object.assign(new Error("x"), {
					status: 500,
					responseBody: '{"error":{"error_kind":"session_busy"}}',
				}),
			),
		).toBe(false);
	});

	it("reads a rate limit as a refusal", () => {
		expect(classifyTurnFault("slow down", "rate_limited")).toBe("refusal");
	});

	it("leaves the request's and the model's own failures alone", () => {
		for (const message of [
			"400 invalid_request_error: unknown field",
			"model returned empty response",
			"Agent runtime exceeded maxIterations (40)",
			"This model's maximum context length is 8192 tokens",
			undefined,
		]) {
			expect(classifyTurnFault(message)).toBeUndefined();
		}
		expect(classifyTurnFault("bad", "context_window_exceeded")).toBeUndefined();
	});

	it("walks a thrown error's code, status and cause", () => {
		expect(
			classifyTurnFaultError(
				Object.assign(new TypeError("fetch failed"), {
					cause: { code: "ECONNRESET", message: "read ECONNRESET" },
				}),
			),
		).toBe("transport");
		expect(
			classifyTurnFaultError(Object.assign(new Error("x"), { status: 502 })),
		).toBe("transport");
		expect(
			classifyTurnFaultError(Object.assign(new Error("x"), { status: 429 })),
		).toBe("refusal");
		expect(classifyTurnFaultError(new Error("boom"))).toBeUndefined();
	});
});

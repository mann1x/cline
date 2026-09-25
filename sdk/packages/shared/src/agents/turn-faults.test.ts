import { describe, expect, it } from "vitest";
import { classifyTurnFault, classifyTurnFaultError } from "./turn-faults";

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

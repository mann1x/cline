import { describe, expect, it } from "vitest";
import {
	isModelMissing,
	isNodeUnreachable,
	isWastedNodeRun,
} from "./node-reachability";

/**
 * Measured on pandorum 2026-09-22, in a five-agent fan-out:
 *
 *   {"text":"model 'ornith-27b_tb:iq4_xs-128k' not found","iterations":1,
 *    "finishReason":"error","usage":{"inputTokens":0,"outputTokens":0},
 *    "nodeId":"node-mucvow61"}
 *
 * The server holds 193 models and not that one. Two agents died on it, a third
 * died when the lead retried into the same node, and the node stayed in the
 * rotation for the whole session because -- correctly, by the reachability
 * test -- a server that answers is not unreachable.
 */
describe("a node whose server does not have its model", () => {
	it("reads the engine's own wording", () => {
		expect(isModelMissing("model 'ornith-27b_tb:iq4_xs-128k' not found")).toBe(
			true,
		);
		expect(isModelMissing("The model `gpt-4o` does not exist")).toBe(true);
		expect(isModelMissing("unknown model")).toBe(true);
		expect(isModelMissing('{"error":{"code":"model_not_found"}}')).toBe(true);
	});

	// The same discipline the reachability test is written to: a node taken out
	// of rotation for something that is not the node's fault is the opposite
	// failure, and worse, because it is silent.
	it("is not every sentence containing 'not found'", () => {
		expect(isModelMissing("File not found: src/main.ts")).toBe(false);
		expect(
			isModelMissing(
				"I looked for the model's weights and the report was not found in the directory you named",
			),
		).toBe(false);
		expect(isModelMissing("rate limit exceeded")).toBe(false);
		expect(isModelMissing(undefined)).toBe(false);
	});

	// It must stay out of the transport test: this server answered.
	it("is not unreachability", () => {
		expect(isNodeUnreachable(new Error("model 'x' not found"))).toBe(false);
	});
});

describe("whether an attempt may be placed again", () => {
	const wasted = {
		finishReason: "error",
		text: "model 'ornith-27b_tb:iq4_xs-128k' not found",
		usage: { inputTokens: 0, outputTokens: 0 },
	};

	it("re-places a run that reached no model", () => {
		expect(isWastedNodeRun(wasted)).toBe(true);
	});

	// The guard that makes re-placing safe at all. A failure that burned tokens
	// may have edited a file, and running it again elsewhere would do it twice.
	it("never re-places a run that spent something", () => {
		expect(
			isWastedNodeRun({
				...wasted,
				usage: { inputTokens: 1200, outputTokens: 40 },
			}),
		).toBe(false);
	});

	it("leaves an ordinary failure alone", () => {
		expect(
			isWastedNodeRun({
				finishReason: "error",
				text: "context window exceeded",
				usage: { inputTokens: 0, outputTokens: 0 },
			}),
		).toBe(false);
		expect(
			isWastedNodeRun({
				finishReason: "stop",
				text: "the model is not found in the file I read",
				usage: { inputTokens: 900, outputTokens: 100 },
			}),
		).toBe(false);
	});
});

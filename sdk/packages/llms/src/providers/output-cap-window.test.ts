import { describe, expect, it } from "vitest";
import { resolveGatewayOutputCap } from "./gateway";

describe("the output cap report", () => {
	it("carries the window whatever decided the cap", () => {
		// A cap the caller asked for says nothing about the window, and a
		// reader sizing what else fits beside the request needs it.
		const asked = resolveGatewayOutputCap({
			requestedMaxTokens: 8_000,
			model: { contextWindow: 96_000 },
			estimatedInputTokens: 48_000,
		} as never);
		expect(asked.windowBound).toBe(false);
		expect(asked.contextWindow).toBe(96_000);

		const bound = resolveGatewayOutputCap({
			model: { contextWindow: 96_000 },
			estimatedInputTokens: 80_000,
		} as never);
		expect(bound.windowBound).toBe(true);
		expect(bound.contextWindow).toBe(96_000);
	});

	it("names no window for a model that declares none", () => {
		const report = resolveGatewayOutputCap({
			requestedMaxTokens: 8_000,
			model: {},
			estimatedInputTokens: 48_000,
		} as never);
		expect(report.contextWindow).toBeUndefined();
	});
});

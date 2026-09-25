import { describe, expect, it } from "vitest";
import {
	resetContextMinimumWarnings,
	warnIfWindowBelowMinimum,
} from "./context-minimum-warning";

function sink() {
	const lines: Array<{ message: string; severity?: string }> = [];
	return {
		lines,
		logger: {
			log: (message: string, meta?: { severity?: string }) => {
				lines.push({ message, severity: meta?.severity });
			},
		},
	};
}

describe("the session-start minimum warning", () => {
	it("warns once, naming both numbers, when the window is below the minimum", () => {
		resetContextMinimumWarnings();
		const { lines, logger } = sink();
		const input = {
			sessionId: "short",
			logger,
			contextWindow: 32_768,
			systemPromptTokens: 1_600,
			toolSchemaTokens: 12_000,
			mcpToolSchemaTokens: 3_600,
			outputCapTokens: 24_000,
		};
		warnIfWindowBelowMinimum(input);
		warnIfWindowBelowMinimum(input);
		expect(lines).toHaveLength(1);
		expect(lines[0]?.severity).toBe("warn");
		expect(lines[0]?.message).toContain(
			"32,768 is below the 41,200 this profile needs (system prompt + tools + MCP 17,200, output room 24,000)",
		);
	});

	it("says nothing when the window holds a turn", () => {
		resetContextMinimumWarnings();
		const { lines, logger } = sink();
		warnIfWindowBelowMinimum({
			sessionId: "roomy",
			logger,
			contextWindow: 131_072,
			systemPromptTokens: 1_600,
			toolSchemaTokens: 12_000,
			outputCapTokens: 24_000,
		});
		expect(lines).toEqual([]);
	});

	it("resolves the output room from the budget when no cap is given", () => {
		resetContextMinimumWarnings();
		const { lines, logger } = sink();
		// Three quarters of 16,384 is 12,288; plus 8,000 of fixed price.
		warnIfWindowBelowMinimum({
			sessionId: "budget",
			logger,
			contextWindow: 16_384,
			systemPromptTokens: 8_000,
		});
		expect(lines[0]?.message).toContain("16,384 is below the 20,288");
	});
});

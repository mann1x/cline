import { describe, expect, it } from "vitest";
import {
	AGENT_WINDOW_DEFAULT_SHARE_PERCENT,
	describeContextShortfall,
	normalizeAgentWindowShare,
	resolveAgentWindowFloor,
	resolveContextMinimum,
	resolveContextMinimumForWindow,
} from "./context-minimum";

describe("resolveContextMinimum", () => {
	it("is the fixed price plus the output room", () => {
		const minimum = resolveContextMinimum({
			systemPromptTokens: 1_600,
			toolSchemaTokens: 8_600,
			mcpToolSchemaTokens: 7_000,
			outputRoomTokens: 24_000,
		});
		expect(minimum).toEqual({
			systemPromptTokens: 1_600,
			toolSchemaTokens: 8_600,
			mcpToolSchemaTokens: 7_000,
			fixedPriceTokens: 17_200,
			outputRoomTokens: 24_000,
			minimumTokens: 41_200,
		});
	});

	it("reads a missing or nonsensical part as nothing", () => {
		expect(
			resolveContextMinimum({
				systemPromptTokens: Number.NaN,
				toolSchemaTokens: -5,
				outputRoomTokens: 1_000,
			}).minimumTokens,
		).toBe(1_000);
	});
});

describe("resolveContextMinimumForWindow", () => {
	it("takes the output room from the automatic budget for that window", () => {
		// Three quarters of 32,768.
		const minimum = resolveContextMinimumForWindow({
			contextWindow: 32_768,
			systemPromptTokens: 1_600,
			toolSchemaTokens: 15_600,
		});
		expect(minimum.outputRoomTokens).toBe(24_576);
		expect(minimum.minimumTokens).toBe(17_200 + 24_576);
	});

	it("caps the output room at the budget's ceiling on a wide window", () => {
		expect(
			resolveContextMinimumForWindow({ contextWindow: 262_144 })
				.outputRoomTokens,
		).toBe(96_000);
	});

	it("lets an explicit cap win over the budget", () => {
		expect(
			resolveContextMinimumForWindow({
				contextWindow: 262_144,
				explicitOutputCap: 8_192,
			}).outputRoomTokens,
		).toBe(8_192);
	});

	it("honours a manual budget", () => {
		expect(
			resolveContextMinimumForWindow({
				contextWindow: 262_144,
				outputBudget: { mode: "manual", maxTokens: 16_000 },
			}).outputRoomTokens,
		).toBe(16_000);
	});
});

describe("resolveAgentWindowFloor", () => {
	const cases: Array<[number, number, number, number]> = [
		// window, minimum, share, floor
		[262_144, 116_000, 0, 116_000],
		[262_144, 116_000, 50, 189_072],
		[262_144, 116_000, 100, 262_144],
		[131_072, 60_000, 0, 60_000],
		[131_072, 60_000, 50, 95_536],
		[131_072, 60_000, 100, 131_072],
		[65_536, 20_000, 25, 31_384],
	];
	for (const [contextWindow, minimumTokens, sharePercent, floor] of cases) {
		it(`is ${floor} at ${sharePercent}% of a ${contextWindow} window over a ${minimumTokens} minimum`, () => {
			expect(
				resolveAgentWindowFloor({ contextWindow, minimumTokens, sharePercent }),
			).toBe(floor);
		});
	}

	it("defaults to half way", () => {
		expect(AGENT_WINDOW_DEFAULT_SHARE_PERCENT).toBe(50);
		expect(
			resolveAgentWindowFloor({ contextWindow: 100_000, minimumTokens: 0 }),
		).toBe(50_000);
	});

	it("never asks for more than the window, even when the minimum exceeds it", () => {
		expect(
			resolveAgentWindowFloor({
				contextWindow: 32_768,
				minimumTokens: 41_200,
				sharePercent: 0,
			}),
		).toBe(32_768);
	});

	it("has no answer without a window", () => {
		expect(
			resolveAgentWindowFloor({ contextWindow: 0, minimumTokens: 10 }),
		).toBeUndefined();
	});
});

describe("normalizeAgentWindowShare", () => {
	it("clamps to 0..100 and rounds", () => {
		expect(normalizeAgentWindowShare(-4)).toBe(0);
		expect(normalizeAgentWindowShare(140)).toBe(100);
		expect(normalizeAgentWindowShare(33.6)).toBe(34);
		expect(normalizeAgentWindowShare("25")).toBe(25);
	});

	it("reads zero as zero, not as unset", () => {
		expect(normalizeAgentWindowShare(0)).toBe(0);
	});

	it("reads anything else as the default", () => {
		expect(normalizeAgentWindowShare(undefined)).toBe(50);
		expect(normalizeAgentWindowShare("abc")).toBe(50);
		expect(normalizeAgentWindowShare("")).toBe(50);
	});
});

describe("describeContextShortfall", () => {
	const minimum = resolveContextMinimum({
		systemPromptTokens: 1_600,
		toolSchemaTokens: 15_600,
		outputRoomTokens: 24_000,
	});

	it("names both numbers and the parts when the window is short", () => {
		expect(describeContextShortfall(32_768, minimum)).toBe(
			"32,768 is below the 41,200 this profile needs (system prompt + tools + MCP 17,200, output room 24,000). Turns will be cut short or refused.",
		);
	});

	it("says nothing at or above the minimum", () => {
		expect(describeContextShortfall(41_200, minimum)).toBeUndefined();
		expect(describeContextShortfall(65_536, minimum)).toBeUndefined();
	});

	it("says nothing without a window", () => {
		expect(describeContextShortfall(undefined, minimum)).toBeUndefined();
	});
});

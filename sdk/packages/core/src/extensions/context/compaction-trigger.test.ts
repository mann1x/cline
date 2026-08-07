import { describe, expect, it } from "vitest";
import {
	COMPACTION_TRIGGER_RATIO,
	DEFAULT_OUTPUT_ROOM_TOKENS,
	resolveCompactionTriggerTokens,
} from "./compaction-shared";

describe("the compaction trigger", () => {
	it("keeps a full turn's output inside the window", () => {
		// The live failure: 110,000 window, 32,000 cap. The ratio alone put the
		// trigger at 99,000, leaving 11,000 for a reply that could ask for 32,000.
		expect(
			resolveCompactionTriggerTokens({
				maxInputTokens: 110_000,
				contextWindow: 110_000,
				modelMaxTokens: 32_000,
			}),
		).toBe(78_000);
	});

	it("never sits above the window it is meant to protect", () => {
		// The window the wire carried was 110,000 while the trigger was computed
		// from a stale 128,000, putting it 5,200 tokens past the end.
		const trigger = resolveCompactionTriggerTokens({
			maxInputTokens: 128_000,
			contextWindow: 110_000,
			modelMaxTokens: 32_000,
		});
		expect(trigger).toBeLessThan(110_000);
	});

	it("falls back to the gateway's own default cap", () => {
		expect(
			resolveCompactionTriggerTokens({
				maxInputTokens: 200_000,
				contextWindow: 200_000,
			}),
		).toBe(200_000 - DEFAULT_OUTPUT_ROOM_TOKENS);
	});

	it("does not let an outsized cap collapse a small window", () => {
		// A 32,000 cap against a 40,000 window would trigger at 8,000 and compact
		// almost every turn; the cap is the unreasonable figure there.
		expect(
			resolveCompactionTriggerTokens({
				maxInputTokens: 40_000,
				contextWindow: 40_000,
				modelMaxTokens: 32_000,
			}),
		).toBe(20_000);
	});

	it("keeps the ratio as the bound when it is the smaller one", () => {
		expect(
			resolveCompactionTriggerTokens({
				maxInputTokens: 100_000,
				contextWindow: 1_000_000,
				modelMaxTokens: 8_000,
			}),
		).toBe(100_000 * COMPACTION_TRIGGER_RATIO);
	});

	it("is the plain ratio when no window is reported", () => {
		expect(resolveCompactionTriggerTokens({ maxInputTokens: 64_000 })).toBe(
			64_000 * COMPACTION_TRIGGER_RATIO,
		);
	});
});

import { describe, expect, it } from "vitest";
import {
	DEFAULT_MIN_OUTDATED_REWRITE_BYTES,
	resolveMinOutdatedRewriteBytes,
} from "./message-builder";

describe("resolveMinOutdatedRewriteBytes", () => {
	// A fixed 64KB was the bug: measured live at 110k tokens, 13,801 bytes of
	// correctly-detected superseded reads were never reclaimed because the
	// threshold was larger than anything a session that size accumulates.
	it("scales below the old fixed threshold for a mid-size window", () => {
		const threshold = resolveMinOutdatedRewriteBytes(110_000);
		expect(threshold).toBeLessThan(DEFAULT_MIN_OUTDATED_REWRITE_BYTES);
		expect(threshold).toBeLessThan(13_801);
	});

	// 64KB is more text than a 32k window can hold at all, so the threshold
	// could never be reached.
	it("floors small windows instead of asking for more than they hold", () => {
		expect(resolveMinOutdatedRewriteBytes(32_000)).toBe(4_096);
		expect(resolveMinOutdatedRewriteBytes(1_000)).toBe(4_096);
	});

	it("caps large windows so cleanup does not wait forever", () => {
		expect(resolveMinOutdatedRewriteBytes(1_000_000)).toBe(65_536);
	});

	it("grows with the window between the bounds", () => {
		expect(resolveMinOutdatedRewriteBytes(200_000)).toBeGreaterThan(
			resolveMinOutdatedRewriteBytes(110_000),
		);
	});

	it("falls back to the fixed default when the window is unknown", () => {
		expect(resolveMinOutdatedRewriteBytes(undefined)).toBe(
			DEFAULT_MIN_OUTDATED_REWRITE_BYTES,
		);
		expect(resolveMinOutdatedRewriteBytes(0)).toBe(
			DEFAULT_MIN_OUTDATED_REWRITE_BYTES,
		);
		expect(resolveMinOutdatedRewriteBytes(Number.NaN)).toBe(
			DEFAULT_MIN_OUTDATED_REWRITE_BYTES,
		);
	});
});

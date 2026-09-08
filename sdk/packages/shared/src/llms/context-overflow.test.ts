import { beforeEach, describe, expect, it } from "vitest";
import {
	consumeContextOverflow,
	noteContextOverflow,
	resetTokenCalibration,
} from "./tokens";

const report = {
	contextWindow: 110_000,
	estimatedInputTokens: 104_000,
	reserveTokens: 12_480,
	remainingContext: -6_480,
	minOutputTokens: 1_024,
};

describe("the context overflow signal", () => {
	beforeEach(() => {
		resetTokenCalibration();
	});

	it("has nothing to report before anything overflows", () => {
		expect(consumeContextOverflow()).toBeUndefined();
	});

	it("hands the report to the first caller", () => {
		noteContextOverflow(report);
		expect(consumeContextOverflow()).toEqual(report);
	});

	it("forces one compaction, not one per following turn", () => {
		noteContextOverflow(report);
		expect(consumeContextOverflow()).toEqual(report);
		expect(consumeContextOverflow()).toBeUndefined();
	});

	it("is cleared with the rest of the calibration state", () => {
		noteContextOverflow(report);
		resetTokenCalibration();
		expect(consumeContextOverflow()).toBeUndefined();
	});
});

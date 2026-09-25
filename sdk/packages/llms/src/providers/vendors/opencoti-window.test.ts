import { describe, expect, it } from "vitest";
import { classifyProviderError } from "../error-classification";
import {
	formatWindowK,
	isOpencotiWindowUnavailableError,
	OpencotiWindowUnavailableError,
	parseOpencotiWindowUnavailable,
} from "./opencoti-window";

describe("the window refusal", () => {
	it("words a resume the way the card does", () => {
		const error = new OpencotiWindowUnavailableError({
			asked: 262_144,
			floor: 262_144,
			largestAdmissible: 131_072,
			resume: true,
		});
		expect(error.message).toMatch(
			/^Can't resume this conversation\. It was opened with a 256k window and needs the same to continue\. The server has 128k free right now\./,
		);
	});

	// The error object does not survive to the host; its message does.
	it("round-trips its numbers through the message alone", () => {
		const details = {
			asked: 262_144,
			floor: 65_536,
			largestAdmissible: 32_768,
			resume: false,
		};
		const message = `Agent error: ${new OpencotiWindowUnavailableError(details).message}`;
		expect(parseOpencotiWindowUnavailable(message)).toEqual(details);
	});

	it("keeps an unstated free figure unstated", () => {
		const error = new OpencotiWindowUnavailableError({
			asked: 131_072,
			floor: 131_072,
			resume: true,
		});
		expect(parseOpencotiWindowUnavailable(error.message)).toEqual({
			asked: 131_072,
			floor: 131_072,
			resume: true,
		});
	});

	it("reads nothing into an unrelated error", () => {
		expect(parseOpencotiWindowUnavailable("429 Too Many Requests")).toBe(
			undefined,
		);
		expect(parseOpencotiWindowUnavailable(undefined)).toBe(undefined);
	});

	// Neither retryable (it had its wait) nor an overflow (compacting cannot
	// make room on the server). Either verdict would act on it.
	it("classifies as neither a rate limit nor an overflow", () => {
		const error = new OpencotiWindowUnavailableError({
			asked: 262_144,
			floor: 262_144,
			largestAdmissible: 131_072,
			resume: true,
		});
		expect(classifyProviderError(error)).toBe("unknown");
		expect(classifyProviderError(new Error(error.message))).toBe("unknown");
		expect(
			isOpencotiWindowUnavailableError(new Error("wrapped", { cause: error })),
		).toBe(true);
	});

	it("rounds a window to k", () => {
		expect(formatWindowK(262_144)).toBe("256k");
		expect(formatWindowK(100_000)).toBe("98k");
	});
});

import { describe, expect, it } from "vitest"
import { formatRunDuration } from "./run-duration"

describe("formatRunDuration", () => {
	// No floor, unlike the annotation row: the completion box is read to find
	// out what the work cost, so a short run has a right to answer.
	it("reports a short run in seconds", () => {
		expect(formatRunDuration(45_000)).toBe("45s")
		expect(formatRunDuration(1_400)).toBe("1s")
		expect(formatRunDuration(59_400)).toBe("59s")
	})

	// A run that happened took some time, and "0s" reads as a bug.
	it("never reports a run as taking no time", () => {
		expect(formatRunDuration(0)).toBe("1s")
		expect(formatRunDuration(200)).toBe("1s")
	})

	it("switches to minutes at a minute", () => {
		expect(formatRunDuration(60_000)).toBe("1m")
		expect(formatRunDuration(28 * 60_000)).toBe("28m")
	})

	it("splits hours out once there are any", () => {
		expect(formatRunDuration(62 * 60_000)).toBe("1h2m")
		expect(formatRunDuration(60 * 60_000)).toBe("1h0m")
	})

	it("rounds to the nearer minute", () => {
		expect(formatRunDuration(59 * 60_000 + 50_000)).toBe("1h0m")
		expect(formatRunDuration(10 * 60_000 + 20_000)).toBe("10m")
	})

	it("says nothing about a nonsense duration", () => {
		expect(formatRunDuration(Number.NaN)).toBeUndefined()
		expect(formatRunDuration(-1)).toBeUndefined()
	})
})

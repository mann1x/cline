import { describe, expect, it } from "vitest"
import { formatDuration, formatRate, summarizeTimings, timingRows } from "./request-timings"

describe("formatDuration", () => {
	it("picks the unit the number reads best in", () => {
		expect(formatDuration(840)).toBe("840ms")
		expect(formatDuration(4321)).toBe("4.32s")
		expect(formatDuration(17_300)).toBe("17.3s")
		expect(formatDuration(124_000)).toBe("2m 04s")
	})

	it("has nothing to say about a duration that was not reported", () => {
		expect(formatDuration(undefined)).toBeUndefined()
		expect(formatDuration(Number.NaN)).toBeUndefined()
		expect(formatDuration(-1)).toBeUndefined()
	})
})

describe("formatRate", () => {
	it("keeps the decimal only where it distinguishes two runs", () => {
		expect(formatRate(84.23)).toBe("84.2 tok/s")
		expect(formatRate(881.84)).toBe("882 tok/s")
	})

	it("refuses a rate of zero rather than printing one", () => {
		// A zero rate is always a division by a duration that was not measured,
		// and printed it reads as a model that produced nothing per second.
		expect(formatRate(0)).toBeUndefined()
		expect(formatRate(undefined)).toBeUndefined()
	})
})

describe("summarizeTimings", () => {
	it("leads with the wall time, then both throughputs", () => {
		// Prefill and generation are separate numbers and a single "tok/s"
		// hides which of them moved between two runs.
		expect(
			summarizeTimings({
				requestMs: 17_300,
				firstTokenMs: 1200,
				engine: "ollama",
				promptTokens: 15_696,
				promptMs: 17_799,
				promptPerSecond: 881.8,
				generateTokens: 2141,
				generateMs: 27_776,
				generatePerSecond: 77.08,
			}),
		).toBe("17.3s · 882 tok/s prefill · 77.1 tok/s gen · 1.20s to first token")
	})

	it("derives a generation rate for a provider that reports none, and marks it", () => {
		// 240 tokens over the 12s that followed the first token.
		expect(summarizeTimings({ requestMs: 14_000, firstTokenMs: 2000 }, 240)).toBe(
			"14.0s · 20.0 tok/s gen* · 2.00s to first token",
		)
	})

	it("says what it can for a provider that reports nothing of its own", () => {
		expect(summarizeTimings({ requestMs: 4321 })).toBe("4.32s")
	})

	it("has no line at all when there are no timings", () => {
		expect(summarizeTimings(undefined)).toBeUndefined()
		expect(summarizeTimings({})).toBeUndefined()
	})
})

describe("timingRows", () => {
	it("shows only Cline's own measurements when no engine reported", () => {
		const rows = timingRows({ requestMs: 4321, firstTokenMs: 800 })
		expect(rows.map((row) => row.label)).toEqual(["Total", "First token"])
	})

	it("adds a derived generation rate when the token count allows one", () => {
		const rows = timingRows({ requestMs: 14_000, firstTokenMs: 2000 }, 240)
		const rate = rows.find((row) => row.label === "Generation rate")

		expect(rate?.value).toBe("20.0 tok/s")
		// Never presented as the engine's own count of decode steps.
		expect(rate?.note).toBe("derived from output tokens and Cline's timing")
	})

	it("prefers the engine's generation rate over the derived one", () => {
		const rows = timingRows(
			{
				requestMs: 14_000,
				firstTokenMs: 2000,
				engine: "ollama",
				generateTokens: 2141,
				generateMs: 27_776,
				generatePerSecond: 77.08,
			},
			240,
		)
		const rate = rows.find((row) => row.label === "Generation rate")

		expect(rate?.value).toBe("77.1 tok/s")
		expect(rate?.note).toBeUndefined()
	})

	it("adds the engine's split, and never a row for a field it did not send", () => {
		const rows = timingRows({
			requestMs: 46_500,
			engine: "ollama",
			engineTotalMs: 46_322,
			promptTokens: 15_696,
			promptMs: 17_799,
			promptPerSecond: 881.8,
			generateTokens: 2141,
			generateMs: 27_776,
			generatePerSecond: 77.08,
		})
		const labels = rows.map((row) => row.label)

		expect(labels).toContain("Engine total")
		expect(labels).toContain("Prompt rate")
		expect(labels).toContain("Generation rate")
		// Ollama does not report a cached prefix or a draft model, so neither
		// gets a row reading zero.
		expect(labels).not.toContain("Cached prompt")
		expect(labels).not.toContain("Draft accepted")
		expect(labels).not.toContain("Model load")
	})

	it("states the draft acceptance rate, which is the point of a draft model", () => {
		const rows = timingRows({
			engine: "llamacpp",
			generateTokens: 200,
			generateMs: 4000,
			draftTokens: 120,
			draftAcceptedTokens: 90,
		})
		const draft = rows.find((row) => row.label === "Draft accepted")

		expect(draft?.value).toBe("90 / 120")
		expect(draft?.note).toBe("75% of speculative tokens kept")
	})
})

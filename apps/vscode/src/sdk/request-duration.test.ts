import { describe, expect, it } from "vitest"
import { formatRequestDuration, REQUEST_DURATION_FLOOR_MS } from "./request-duration"

describe("formatRequestDuration", () => {
	// The point of the floor: a short question answered quickly gets no
	// annotation, so the ones that do carry it still mean something.
	it("says nothing about a short request", () => {
		expect(formatRequestDuration(0)).toBeUndefined()
		expect(formatRequestDuration(20_000)).toBeUndefined()
		expect(formatRequestDuration(REQUEST_DURATION_FLOOR_MS - 1)).toBeUndefined()
	})

	it("reports from three minutes up", () => {
		expect(formatRequestDuration(REQUEST_DURATION_FLOOR_MS)).toBe("3m")
		expect(formatRequestDuration(45 * 60_000)).toBe("45m")
	})

	it("splits hours out once there are any", () => {
		expect(formatRequestDuration(62 * 60_000)).toBe("1h2m")
		expect(formatRequestDuration(60 * 60_000)).toBe("1h0m")
		expect(formatRequestDuration(125 * 60_000)).toBe("2h5m")
	})

	// Rounding, not truncation: 59m50s is a minute short of an hour, not 59.
	it("rounds to the nearer minute", () => {
		expect(formatRequestDuration(59 * 60_000 + 50_000)).toBe("1h0m")
		expect(formatRequestDuration(10 * 60_000 + 20_000)).toBe("10m")
	})

	it("says nothing about a nonsense duration", () => {
		expect(formatRequestDuration(Number.NaN)).toBeUndefined()
		expect(formatRequestDuration(Number.POSITIVE_INFINITY)).toBeUndefined()
	})
})

import { describe, expect, it, vi } from "vitest"

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ taskHistory: [] }) }))
vi.mock("@/services/grpc-client", () => ({ TaskServiceClient: { showTaskWithId: vi.fn() } }))

import { MIN_PREVIEW_ROWS, rowsThatFit } from "./HistoryPreview"

describe("rowsThatFit", () => {
	it("fits as many rows as the space holds, gaps included", () => {
		// Rows 60px tall with an 8px gap: 5 rows take 5*60 + 4*8 = 332px.
		expect(rowsThatFit(332, 60)).toBe(5)
		expect(rowsThatFit(331, 60)).toBe(4)
	})

	// The home view scrolls rather than showing fewer than the old fixed three.
	it("never goes under the minimum", () => {
		expect(rowsThatFit(40, 60)).toBe(MIN_PREVIEW_ROWS)
		expect(rowsThatFit(0, 60)).toBe(MIN_PREVIEW_ROWS)
	})

	// Before the first layout (jsdom, or a hidden view) there is nothing to measure.
	it("falls back to the minimum when nothing is measurable", () => {
		expect(rowsThatFit(500, 0)).toBe(MIN_PREVIEW_ROWS)
		expect(rowsThatFit(Number.NaN, 60)).toBe(MIN_PREVIEW_ROWS)
	})

	it("is capped", () => {
		expect(rowsThatFit(100_000, 60)).toBe(30)
	})
})

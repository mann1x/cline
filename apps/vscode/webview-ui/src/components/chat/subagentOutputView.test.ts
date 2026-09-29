import { describe, expect, it } from "vitest"
import { applySubagentOutputUpdate, type InspectChunk } from "./subagentOutputView"

describe("applySubagentOutputUpdate", () => {
	it("joins a chunk that continues the last stretch", () => {
		const first = applySubagentOutputUpdate([], { reset: true, chunks: [{ kind: "reasoning", text: "Let me " }] })
		const next = applySubagentOutputUpdate(first, { reset: false, chunks: [{ kind: "reasoning", text: "look." }] })
		expect(next).toEqual([{ kind: "reasoning", text: "Let me look." }])
		// The previous state is left alone: React compares by reference.
		expect(first).toEqual([{ kind: "reasoning", text: "Let me " }])
	})

	it("keeps two calls apart, and thinking apart from the call", () => {
		const next = applySubagentOutputUpdate([], {
			reset: true,
			chunks: [
				{ kind: "reasoning", text: "Plan." },
				{ kind: "tool", text: "{}", toolName: "editor", toolCallId: "a" },
				{ kind: "tool", text: "{", toolName: "editor", toolCallId: "b" },
			],
		})
		expect(next.map((chunk) => chunk.toolCallId ?? chunk.kind)).toEqual(["reasoning", "a", "b"])
	})

	it("clears on a new step", () => {
		const current: InspectChunk[] = [{ kind: "text", text: "old" }]
		expect(applySubagentOutputUpdate(current, { reset: true, chunks: [] })).toEqual([])
	})

	it("drops the start past the cap", () => {
		const next = applySubagentOutputUpdate(
			[{ kind: "reasoning", text: "abc" }],
			{ reset: false, chunks: [{ kind: "text", text: "defgh" }] },
			6,
		)
		expect(next).toEqual([
			{ kind: "reasoning", text: "c" },
			{ kind: "text", text: "defgh" },
		])
	})
})

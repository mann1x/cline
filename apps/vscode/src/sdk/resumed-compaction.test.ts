import { createSessionCompactionState, projectSessionCompactionState } from "@cline/core"
import { describe, expect, it } from "vitest"
import { sanitizeInitialMessagesForSessionStart } from "./initial-message-sanitizer"
import { rebaseCompactionState, stashRebasedCompaction, takeRebasedCompaction } from "./resumed-compaction"

type Messages = Parameters<typeof projectSessionCompactionState>[1]

/** A transcript as the SDK stores it: each result of a parallel tool batch in a user message of its own. */
function stored(): unknown[] {
	return [
		{ role: "user", content: [{ type: "text", text: "do the work" }] },
		{
			role: "assistant",
			content: [
				{ type: "tool_use", id: "a", name: "read_files", input: {} },
				{ type: "tool_use", id: "b", name: "read_files", input: {} },
			],
		},
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "A" }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "B" }] },
		{ role: "assistant", content: [{ type: "text", text: "read both" }] },
		{ role: "user", content: [{ type: "text", text: "and now?" }] },
	]
}

describe("a saved compaction across a reshaped transcript", () => {
	const raw = stored()
	const summary = [{ role: "user", content: [{ type: "text", text: "SUMMARY of the first five messages" }] }]
	const state = createSessionCompactionState({
		sourceMessages: raw.slice(0, 5) as Messages,
		compactedMessages: summary as Messages,
		conversationId: "s1",
	})
	const reshaped = sanitizeInitialMessagesForSessionStart(raw)

	it("does not fit the transcript the sanitizer reshaped", () => {
		expect(reshaped).not.toBe(raw)
		expect(reshaped.length).toBeLessThan(raw.length)
		expect(projectSessionCompactionState(state, raw as Messages)).toBeDefined()
		expect(projectSessionCompactionState(state, reshaped as Messages)).toBeUndefined()
	})

	it("is rebased so the reshaped transcript resumes compacted", () => {
		const rebased = rebaseCompactionState({
			sessionId: "s1",
			state,
			stored: raw,
			reshaped,
			reshape: sanitizeInitialMessagesForSessionStart,
		})
		expect(rebased).toBeDefined()
		expect(rebased).not.toBe("fits")
		if (!rebased || rebased === "fits") return
		const projected = projectSessionCompactionState(rebased, reshaped as Messages)
		expect(projected).toHaveLength(2)
		expect(JSON.stringify(projected)).toContain("SUMMARY")
		expect(JSON.stringify(projected)).toContain("and now?")
		expect(JSON.stringify(projected)).not.toContain("read both")
	})

	it("is left to core when the transcript was not reshaped", () => {
		expect(rebaseCompactionState({ sessionId: "s1", state, stored: raw, reshaped: raw, reshape: (m) => m })).toBe("fits")
	})

	it("is dropped when it fits neither transcript", () => {
		const other = [{ role: "user", content: [{ type: "text", text: "something else" }] }]
		expect(
			rebaseCompactionState({ sessionId: "s1", state, stored: other, reshaped: other, reshape: (m) => m }),
		).toBeUndefined()
	})

	it("is handed to the one start whose messages it fits", () => {
		const rebased = rebaseCompactionState({
			sessionId: "s1",
			state,
			stored: raw,
			reshaped,
			reshape: sanitizeInitialMessagesForSessionStart,
		})
		if (!rebased || rebased === "fits") throw new Error("expected a rebased state")
		stashRebasedCompaction("s1", rebased)
		expect(takeRebasedCompaction("s1", raw)).toBeUndefined()
		stashRebasedCompaction("s1", rebased)
		expect(takeRebasedCompaction("s1", reshaped)).toBe(rebased)
		expect(takeRebasedCompaction("s1", reshaped)).toBeUndefined()
	})
})

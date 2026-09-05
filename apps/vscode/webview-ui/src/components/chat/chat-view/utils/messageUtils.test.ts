import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { canRestoreWorkspaceFromMessage, filterVisibleMessages, groupLowStakesTools, isToolGroup } from "./messageUtils"

const createTextMessage = (ts: number, text: string): ClineMessage => ({
	type: "say",
	say: "text",
	text,
	ts,
})

const createToolMessage = (ts: number, tool: string): ClineMessage => ({
	type: "say",
	say: "tool",
	text: JSON.stringify({ tool, path: "src/file.ts" }),
	ts,
})

const createReasoningMessage = (ts: number, text: string, partial = false): ClineMessage => ({
	type: "say",
	say: "reasoning",
	text,
	ts,
	...(partial ? { partial: true } : {}),
})

const createBrowserScreenshotMessage = (ts: number): ClineMessage => ({
	type: "say",
	say: "browser_screenshot",
	images: ["data:image/png;base64,iVBORw0KGgo="],
	ts,
})

const createUserFeedbackMessage = (ts: number, text: string): ClineMessage => ({
	type: "say",
	say: "user_feedback",
	text,
	ts,
})

const createTaskMessage = (ts: number, text: string): ClineMessage => ({
	type: "say",
	say: "task",
	text,
	ts,
})

const createAskMessage = (
	ts: number,
	ask: "followup" | "plan_mode_respond",
	options: string[],
	selected?: string,
): ClineMessage => ({
	type: "ask",
	ask,
	text: JSON.stringify(
		ask === "followup" ? { question: "Pick one", options, selected } : { response: "Pick one", options, selected },
	),
	ts,
})

describe("filterVisibleMessages", () => {
	it("hides exact user feedback echoes for selected follow-up options", () => {
		const askMessage = createAskMessage(1, "followup", ["Use this", "Use that"], "Use this")
		const visible = filterVisibleMessages([askMessage, createUserFeedbackMessage(2, "Use this")])

		expect(visible).toEqual([askMessage])
	})

	it("hides exact option echoes when selected has not been persisted on the ask row yet", () => {
		const askMessage = createAskMessage(1, "followup", ["Use this", "Use that"])
		const visible = filterVisibleMessages([askMessage, createUserFeedbackMessage(2, "Use this")])

		expect(visible).toEqual([askMessage])
	})

	it("hides exact user feedback echoes for plan-mode response options", () => {
		const askMessage = createAskMessage(1, "plan_mode_respond", ["Plan it", "Do it"], "Plan it")
		const visible = filterVisibleMessages([askMessage, createUserFeedbackMessage(2, "Plan it")])

		expect(visible).toEqual([askMessage])
	})

	it("keeps custom user feedback that extends a selected option", () => {
		const askMessage = createAskMessage(1, "followup", ["Use this", "Use that"], "Use this")
		const userMessage = createUserFeedbackMessage(2, "Use this: include tests")
		const visible = filterVisibleMessages([askMessage, userMessage])

		expect(visible).toEqual([askMessage, userMessage])
	})

	it("keeps exact option feedback when it includes attachments", () => {
		const askMessage = createAskMessage(1, "followup", ["Use this", "Use that"], "Use this")
		const userMessage: ClineMessage = {
			...createUserFeedbackMessage(2, "Use this"),
			images: ["data:image/png;base64,abc"],
		}
		const visible = filterVisibleMessages([askMessage, userMessage])

		expect(visible).toEqual([askMessage, userMessage])
	})
})

describe("canRestoreWorkspaceFromMessage", () => {
	it("allows restore for user messages that start runs, but not ask answers", () => {
		const messages = [
			createTaskMessage(1, "start"),
			createAskMessage(2, "followup", ["src/index.ts"]),
			createTextMessage(3, "Which file should I inspect?"),
			createUserFeedbackMessage(4, "src/index.ts"),
			createUserFeedbackMessage(5, "next task"),
		]

		expect(canRestoreWorkspaceFromMessage(messages, 1)).toBe(true)
		expect(canRestoreWorkspaceFromMessage(messages, 4)).toBe(false)
		expect(canRestoreWorkspaceFromMessage(messages, 5)).toBe(true)
		expect(canRestoreWorkspaceFromMessage(messages, 999)).toBe(false)
	})
})

describe("groupLowStakesTools", () => {
	it("keeps text that arrives after a low-stakes tool group by finalizing the group first", () => {
		const grouped = groupLowStakesTools([
			createTextMessage(1, "Initial text"),
			createToolMessage(2, "readFile"),
			createTextMessage(3, "Post-tool summary text"),
		])

		expect(grouped).toHaveLength(3)
		expect(grouped[0]).toMatchObject({ type: "say", say: "text", text: "Initial text" })
		expect(isToolGroup(grouped[1])).toBe(true)
		expect(grouped[2]).toMatchObject({ type: "say", say: "text", text: "Post-tool summary text" })
	})

	it("keeps text when no low-stakes tool group is active", () => {
		const grouped = groupLowStakesTools([
			createTextMessage(1, "Initial text"),
			createToolMessage(2, "editedExistingFile"),
			createTextMessage(3, "Follow-up text"),
		])

		expect(grouped).toHaveLength(3)
		expect(grouped[0]).toMatchObject({ type: "say", say: "text", text: "Initial text" })
		expect(grouped[1]).toMatchObject({ type: "say", say: "tool" })
		expect(grouped[2]).toMatchObject({ type: "say", say: "text", text: "Follow-up text" })
	})

	it("keeps standalone reasoning when no low-stakes tool group follows", () => {
		const grouped = groupLowStakesTools([
			createReasoningMessage(1, "Thinking through options"),
			createTextMessage(2, "Answer text"),
		])

		expect(grouped).toHaveLength(2)
		expect(grouped[0]).toMatchObject({ type: "say", say: "reasoning", text: "Thinking through options" })
		expect(grouped[1]).toMatchObject({ type: "say", say: "text", text: "Answer text" })
	})

	it("keeps standalone reasoning before a non-low-stakes tool", () => {
		const grouped = groupLowStakesTools([
			createReasoningMessage(1, "Thinking through options"),
			createToolMessage(2, "editedExistingFile"),
		])

		expect(grouped).toHaveLength(2)
		expect(grouped[0]).toMatchObject({ type: "say", say: "reasoning", text: "Thinking through options" })
		expect(grouped[1]).toMatchObject({ type: "say", say: "tool" })
	})

	it("keeps reasoning visible when low-stakes tool group starts immediately after", () => {
		const grouped = groupLowStakesTools([createReasoningMessage(1, "Planning next read"), createToolMessage(2, "readFile")])

		expect(grouped).toHaveLength(2)
		expect(grouped[0]).toMatchObject({ type: "say", say: "reasoning", text: "Planning next read" })
		expect(isToolGroup(grouped[1])).toBe(true)
	})
})

/**
 * Reasoning absorbed into a tool group is not merely reordered — `ToolGroupRenderer`
 * drops it ("Skip reasoning messages - they should not be in file lists"). So a
 * reasoning row that lands in a group is a reasoning row nobody ever sees, and
 * for a partial row that is the whole live "Thinking..." display.
 */
describe("reasoning that arrives while a tool group is open", () => {
	it("stays visible instead of disappearing into the group", () => {
		const grouped = groupLowStakesTools([
			createToolMessage(1, "readFile"),
			createReasoningMessage(2, "Thinking about the next step"),
		])

		const standalone = grouped.filter((item) => !isToolGroup(item))
		expect(standalone).toContainEqual(expect.objectContaining({ say: "reasoning" }))
	})

	// The live case: the row is still streaming, so this is the only thing on
	// screen while the model thinks.
	it("keeps a streaming reasoning row out of the group", () => {
		const grouped = groupLowStakesTools([
			createToolMessage(1, "readFile"),
			createToolMessage(2, "searchFiles"),
			createReasoningMessage(3, "Thinking", true),
		])

		const standalone = grouped.filter((item) => !isToolGroup(item))
		expect(standalone).toContainEqual(expect.objectContaining({ say: "reasoning", partial: true }))
	})

	// The sequence a browser turn actually produces: the screenshot row is a say
	// type this grouping does not know, and it lands between the tools and the
	// next turn's thinking.
	it("survives a browser screenshot row between the tools and the thinking", () => {
		const grouped = groupLowStakesTools([
			createToolMessage(1, "readFile"),
			createBrowserScreenshotMessage(2),
			createReasoningMessage(3, "Thinking", true),
			createToolMessage(4, "readFile"),
		])

		const standalone = grouped.filter((item) => !isToolGroup(item))
		expect(standalone).toContainEqual(expect.objectContaining({ say: "reasoning", partial: true }))
	})

	it("still groups the tools themselves", () => {
		const grouped = groupLowStakesTools([
			createToolMessage(1, "readFile"),
			createReasoningMessage(2, "Thinking"),
			createToolMessage(3, "searchFiles"),
		])

		expect(grouped.some((item) => isToolGroup(item))).toBe(true)
	})
})

/**
 * An `api_req_started` row is invisible padding by default and is filtered
 * out, which is why the timing line needed the filter and the grouper changed
 * as well as a component: a row that is dropped or folded into a tool group is
 * a row nobody ever sees (mann1x/cline#64).
 */
describe("request timing rows", () => {
	const createApiReqMessage = (ts: number, extra: Record<string, unknown> = {}): ClineMessage => ({
		type: "say",
		say: "api_req_started",
		text: JSON.stringify({ tokensIn: 900, tokensOut: 120, cost: 0.01, ...extra }),
		ts,
	})

	it("stays filtered out when the display is off", () => {
		const messages = [createApiReqMessage(1, { timings: { requestMs: 4321 } }), createTextMessage(2, "done")]

		expect(filterVisibleMessages(messages)).toHaveLength(1)
		expect(filterVisibleMessages(messages, { showRequestTimings: false })).toHaveLength(1)
	})

	it("is kept when the display is on and the row has timings", () => {
		const messages = [createApiReqMessage(1, { timings: { requestMs: 4321 } }), createTextMessage(2, "done")]

		const visible = filterVisibleMessages(messages, { showRequestTimings: true })
		expect(visible).toHaveLength(2)
		expect(visible[0].say).toBe("api_req_started")
	})

	it("is still filtered out when the request reported no timings", () => {
		// Every hosted provider before this shipped, and any request that failed
		// before usage arrived. An empty row would be worse than no row.
		const messages = [createApiReqMessage(1), createTextMessage(2, "done")]

		expect(filterVisibleMessages(messages, { showRequestTimings: true })).toHaveLength(1)
	})

	it("is never absorbed into a tool group", () => {
		// ToolGroupRenderer reads an api_req row for its cost and renders none
		// of the row itself, so absorbing it is hiding it.
		const grouped = groupLowStakesTools([
			createApiReqMessage(1, { timings: { requestMs: 4321 } }),
			createToolMessage(2, "readFile"),
			createToolMessage(3, "listFilesTopLevel"),
		])

		expect(isToolGroup(grouped[0])).toBe(false)
		expect((grouped[0] as ClineMessage).say).toBe("api_req_started")
		expect(grouped.some((item) => isToolGroup(item))).toBe(true)
	})

	it("keeps absorbing an ordinary api_req row", () => {
		const grouped = groupLowStakesTools([
			createApiReqMessage(1),
			createToolMessage(2, "readFile"),
			createToolMessage(3, "listFilesTopLevel"),
		])

		expect(grouped).toHaveLength(1)
		expect(isToolGroup(grouped[0])).toBe(true)
	})
})

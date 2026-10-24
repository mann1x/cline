import type { ClineMessage } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ backgroundEditEnabled: false }))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		backgroundEditEnabled: state.backgroundEditEnabled,
		mcpServers: [],
		vscodeTerminalExecutionMode: "vscodeTerminal",
		clineMessages: [],
		showFeatureTips: false,
		enableCheckpointsSetting: false,
	}),
}))

import { ChatRowContent } from "./ChatRow"

const base = {
	isExpanded: false,
	isLast: false,
	onSetQuote: () => {},
	onToggleExpand: () => {},
}

function editMessage(tool: Record<string, unknown>): ClineMessage {
	return { ts: 1, type: "say", say: "tool", text: JSON.stringify(tool) } as ClineMessage
}

const searchReplace = "------- SEARCH\nconst a = 1\n=======\nconst a = 2\nconst b = 3\n+++++++ REPLACE"

/**
 * Tester report 7a #1: with background edit off, an edit row showed only the
 * payload sent to the tool, collapsed -- no green and red lines, and no `+N`
 * beside "Open in file editor". The host sends the same diff in both modes;
 * the row was choosing not to draw it. Whether the edit is applied in the
 * background or in an editor tab says nothing about whether the user wants to
 * see what changed in the chat.
 */
describe("an edit row's diff", () => {
	for (const backgroundEditEnabled of [false, true]) {
		it(`draws the change with background edit ${backgroundEditEnabled ? "on" : "off"}`, () => {
			state.backgroundEditEnabled = backgroundEditEnabled
			render(
				<ChatRowContent
					message={editMessage({ tool: "editedExistingFile", path: "src/a.ts", content: searchReplace })}
					{...base}
				/>,
			)

			expect(screen.getByText("+2")).toBeTruthy()
			expect(screen.getByText("-1")).toBeTruthy()
		})

		it(`draws a new file as added lines with background edit ${backgroundEditEnabled ? "on" : "off"}`, () => {
			state.backgroundEditEnabled = backgroundEditEnabled
			render(
				<ChatRowContent
					message={editMessage({ tool: "newFileCreated", path: "src/b.ts", content: "one\ntwo\nthree" })}
					{...base}
				/>,
			)

			expect(screen.getByText("+3")).toBeTruthy()
		})
	}
})

/**
 * A side of no lines is the marker straight after the one before it; a side
 * of one blank line has the line. Both used to be written the same way, so an
 * insertion drew a blank line removed and a deletion a blank line added.
 */
describe("an edit row's empty side", () => {
	it("draws an insertion as added lines only", () => {
		render(
			<ChatRowContent
				message={editMessage({
					tool: "editedExistingFile",
					path: "src/c.ts",
					content: "------- SEARCH\n=======\nsX()\n+++++++ REPLACE",
				})}
				{...base}
			/>,
		)

		expect(screen.getByText("+1")).toBeTruthy()
		expect(screen.queryByText("-1")).toBeNull()
	})

	it("draws a removed blank line as one removed line and nothing added", () => {
		render(
			<ChatRowContent
				message={editMessage({
					tool: "editedExistingFile",
					path: "src/d.ts",
					content: "------- SEARCH\n\n=======\n+++++++ REPLACE",
				})}
				{...base}
			/>,
		)

		expect(screen.getByText("-1")).toBeTruthy()
		expect(screen.queryByText("+1")).toBeNull()
	})
})

/**
 * Session 1792839340096_0rlyv: three of four edits refused, and every card
 * read "wants to edit this file", so the model's "my edits failed because of
 * CRLF" could not be checked against what the editor had said.
 */
describe("an edit row once the editor has answered", () => {
	it("says the edit was refused, and shows the editor's answer", () => {
		render(
			<ChatRowContent
				message={editMessage({
					tool: "editedExistingFile",
					path: "src/a.ts",
					content: searchReplace,
					editMode: "SEARCH/REPLACE",
					failed: true,
					report: "Editor operation failed: No replacement performed: text not found in src/a.ts.",
				})}
				{...base}
			/>,
		)
		expect(screen.getByText("Cerebriline's edit was refused (SEARCH/REPLACE):")).toBeTruthy()
		expect(screen.getByText("Refused")).toBeTruthy()
		expect(screen.getByText(/No replacement performed: text not found/)).toBeTruthy()
	})

	it("says the edit was applied, with its result", () => {
		render(
			<ChatRowContent
				message={editMessage({
					tool: "editedExistingFile",
					path: "src/a.ts",
					content: searchReplace,
					editMode: "SEARCH/REPLACE",
					report: "Edited src/a.ts",
				})}
				{...base}
			/>,
		)
		expect(screen.getByText("Cerebriline edited this file (SEARCH/REPLACE):")).toBeTruthy()
		expect(screen.getByText("Result")).toBeTruthy()
	})

	it("still asks while the editor has not answered", () => {
		render(
			<ChatRowContent
				message={editMessage({ tool: "editedExistingFile", path: "src/a.ts", content: searchReplace })}
				{...base}
			/>,
		)
		expect(screen.getByText("Cerebriline wants to edit this file:")).toBeTruthy()
		expect(screen.queryByText("Refused")).toBeNull()
	})
})

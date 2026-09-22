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

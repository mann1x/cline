import type { ClineMessage } from "@shared/ExtensionMessage"
import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		backgroundEditEnabled: false,
		mcpServers: [],
		vscodeTerminalExecutionMode: "vscodeTerminal",
		clineMessages: [],
		showFeatureTips: false,
		enableCheckpointsSetting: false,
	}),
}))

import { ChatRowContent } from "./ChatRow"

/**
 * The message list is keyed by index, so one row's component instance renders
 * whatever message lands at that index next. A tool message returns out of
 * `ChatRowContent` from inside the `if (tool)` switch; a command message runs
 * on to the bottom of the body. Any hook below those returns is therefore
 * called on one render and not the other, and React ends the panel with
 * "Rendered more hooks than during the previous render" (minified #310) --
 * measured on 4.100.145, with the panel replaced by the error boundary the
 * moment a run_commands row arrived behind a tool row.
 */
const base = {
	isExpanded: false,
	isLast: true,
	onSetQuote: () => {},
	onToggleExpand: () => {},
}

const toolMessage = {
	ts: 1,
	type: "say",
	say: "tool",
	text: JSON.stringify({ tool: "readFile", path: "run_game.js" }),
} as ClineMessage

const commandMessage = {
	ts: 2,
	type: "ask",
	ask: "command",
	text: "node run_game.js manic_miner.html",
} as ClineMessage

describe("ChatRowContent hook order", () => {
	it("survives a tool row's instance being reused for a command row", () => {
		const { rerender } = render(<ChatRowContent message={toolMessage} {...base} />)

		expect(() => rerender(<ChatRowContent message={commandMessage} {...base} />)).not.toThrow()
	})

	it("survives the reverse order too", () => {
		const { rerender } = render(<ChatRowContent message={commandMessage} {...base} />)

		expect(() => rerender(<ChatRowContent message={toolMessage} {...base} />)).not.toThrow()
	})
})

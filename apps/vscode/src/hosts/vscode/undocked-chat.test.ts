import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as vscode from "vscode"
import { editorColumnOutsideUndockedChat, setUndockedChatPanel } from "./undocked-chat"

type Listener = (editor: { viewColumn?: number } | undefined) => void

describe("where editors open while the chat is undocked", () => {
	const window = vscode.window as unknown as Record<string, unknown>
	const saved: Record<string, unknown> = {}
	let listener: Listener | undefined
	let groups: number[]

	beforeEach(() => {
		for (const key of ["tabGroups", "activeTextEditor", "onDidChangeActiveTextEditor"]) {
			saved[key] = window[key]
		}
		groups = [1, 2, 3]
		listener = undefined
		window.activeTextEditor = undefined
		window.tabGroups = {
			get all() {
				return groups.map((viewColumn) => ({ viewColumn, tabs: [] }))
			},
		}
		window.onDidChangeActiveTextEditor = (callback: Listener) => {
			listener = callback
			return { dispose: () => (listener = undefined) }
		}
	})

	afterEach(() => {
		setUndockedChatPanel(undefined)
		Object.assign(window, saved)
	})

	it("leaves the choice to VS Code while the chat is docked", () => {
		expect(editorColumnOutsideUndockedChat()).toBeUndefined()
	})

	it("opens in the first group that is not the chat's", () => {
		setUndockedChatPanel(() => 1)
		expect(editorColumnOutsideUndockedChat()).toBe(2)
	})

	it("opens where the user last edited, never in the chat's group", () => {
		setUndockedChatPanel(() => 3)
		listener?.({ viewColumn: 2 })
		expect(editorColumnOutsideUndockedChat()).toBe(2)

		// A file dragged into the chat's window does not make that window the target.
		listener?.({ viewColumn: 3 })
		expect(editorColumnOutsideUndockedChat()).toBe(2)
	})

	it("forgets a group that was closed", () => {
		setUndockedChatPanel(() => 3)
		listener?.({ viewColumn: 2 })
		groups = [1, 3]
		expect(editorColumnOutsideUndockedChat()).toBe(1)
	})

	it("opens beside the chat when its group is the only one", () => {
		groups = [1]
		setUndockedChatPanel(() => 1)
		expect(editorColumnOutsideUndockedChat()).toBe(vscode.ViewColumn.Beside)
	})

	it("stops steering once the chat is docked again", () => {
		setUndockedChatPanel(() => 1)
		setUndockedChatPanel(undefined)
		expect(editorColumnOutsideUndockedChat()).toBeUndefined()
		expect(listener).toBeUndefined()
	})
})

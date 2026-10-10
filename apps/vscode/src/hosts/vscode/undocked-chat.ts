import * as vscode from "vscode"

/**
 * Where editors open while the chat is undocked.
 *
 * An undocked chat is an editor tab in a window of its own. VS Code opens a
 * file or a diff in the active editor group, and with the chat focused that is
 * the chat's group: the file would land on top of the chat, in the small
 * window. Everything the extension opens therefore names a column outside it.
 */

let getPanelColumn: (() => vscode.ViewColumn | undefined) | undefined
let lastEditorColumn: vscode.ViewColumn | undefined
let tracking: vscode.Disposable | undefined

/** Called by the webview provider when the chat is undocked (with a getter) and docked (undefined). */
export function setUndockedChatPanel(getColumn: (() => vscode.ViewColumn | undefined) | undefined): void {
	getPanelColumn = getColumn
	tracking?.dispose()
	tracking = undefined
	lastEditorColumn = undefined
	if (!getColumn) {
		return
	}
	const remember = (editor: vscode.TextEditor | undefined) => {
		if (editor?.viewColumn !== undefined && editor.viewColumn !== getColumn()) {
			lastEditorColumn = editor.viewColumn
		}
	}
	remember(vscode.window.activeTextEditor)
	tracking = vscode.window.onDidChangeActiveTextEditor(remember)
}

/**
 * The column to open an editor in, or undefined when the chat is docked and
 * VS Code's own choice is right: the editor the user last worked in, else the
 * first group that is not the chat's.
 */
export function editorColumnOutsideUndockedChat(): vscode.ViewColumn | undefined {
	const panelColumn = getPanelColumn?.()
	if (!getPanelColumn) {
		return undefined
	}
	const columns = vscode.window.tabGroups.all.map((group) => group.viewColumn).filter((column) => column !== panelColumn)
	if (lastEditorColumn !== undefined && columns.includes(lastEditorColumn)) {
		return lastEditorColumn
	}
	if (columns.length > 0) {
		return Math.min(...columns)
	}
	// The chat's group is the only one, so there is nothing to open into yet.
	return vscode.ViewColumn.Beside
}

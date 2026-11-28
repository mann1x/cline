import type { RemoteActivity } from "@cline/core"
import * as vscode from "vscode"
import { REMOTE_MIRROR_INPUT_HINT, remoteMirrorBanner, renderRemoteActivity } from "@/shared/remote-terminal-render"

/**
 * One read-only tab per remote terminal in VS Code's Terminal panel, showing
 * what the model does there as it happens: each command with its folder, its
 * output while it runs, how it ended, and a line for each read, write and
 * copy. Nothing typed into it goes anywhere.
 *
 * Opened the first time the model uses a machine, without taking focus. When
 * the user closes one, the next activity opens it again. The tabs are not
 * named like Cerebriline's own terminals, so the terminal manager neither
 * counts them toward "Maximum terminals" nor reclaims them.
 */

interface MirrorTab {
	terminal: vscode.Terminal
	write: vscode.EventEmitter<string>
	opened: boolean
	pending: string[]
	atLineStart: boolean
}

export class RemoteTerminalMirror implements vscode.Disposable {
	private readonly tabs = new Map<string, MirrorTab>()
	private readonly closeListener: vscode.Disposable

	constructor() {
		this.closeListener = vscode.window.onDidCloseTerminal((closed) => {
			for (const [name, tab] of this.tabs) {
				if (tab.terminal === closed) {
					tab.write.dispose()
					this.tabs.delete(name)
				}
			}
		})
	}

	handle(event: RemoteActivity): void {
		const tab = this.tabs.get(event.terminal) ?? this.open(event.terminal)
		const text = renderRemoteActivity(event, tab.atLineStart)
		if (!text) return
		tab.atLineStart = text.endsWith("\n")
		if (tab.opened) tab.write.fire(text)
		else tab.pending.push(text)
	}

	private open(name: string): MirrorTab {
		const write = new vscode.EventEmitter<string>()
		let tab: MirrorTab | undefined
		let hinted = false
		const pty: vscode.Pseudoterminal = {
			onDidWrite: write.event,
			open: () => {
				if (!tab) return
				tab.opened = true
				write.fire(remoteMirrorBanner(name))
				for (const text of tab.pending.splice(0)) write.fire(text)
			},
			close: () => {},
			handleInput: () => {
				if (hinted) return
				hinted = true
				write.fire(REMOTE_MIRROR_INPUT_HINT)
			},
		}
		const terminal = vscode.window.createTerminal({
			name: `${name} (remote)`,
			pty,
			iconPath: new vscode.ThemeIcon("remote"),
			isTransient: true,
		})
		tab = { terminal, write, opened: false, pending: [], atLineStart: true }
		this.tabs.set(name, tab)
		return tab
	}

	dispose(): void {
		this.closeListener.dispose()
		for (const tab of this.tabs.values()) {
			tab.write.dispose()
			tab.terminal.dispose()
		}
		this.tabs.clear()
	}
}

let shared: RemoteTerminalMirror | undefined

/** The window's mirror, made on first use. */
export function remoteTerminalMirror(): RemoteTerminalMirror {
	shared ??= new RemoteTerminalMirror()
	return shared
}

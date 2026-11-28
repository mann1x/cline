import type { RemoteActivity } from "@cline/core"

/**
 * How remote-terminal activity reads in the read-only VS Code tabs
 * (`hosts/vscode/remote-terminal-mirror.ts`): plain text with ANSI colour,
 * CR LF line endings, kept free of `vscode` so it is unit-tested.
 */

const ESC = "\x1b["
const dim = (text: string) => `${ESC}2m${text}${ESC}0m`
const cyan = (text: string) => `${ESC}36m${text}${ESC}0m`
const bold = (text: string) => `${ESC}1m${text}${ESC}0m`
const green = (text: string) => `${ESC}32m${text}${ESC}0m`
const red = (text: string) => `${ESC}31m${text}${ESC}0m`
const yellow = (text: string) => `${ESC}33m${text}${ESC}0m`

/** Line endings for a terminal: every newline becomes CR LF. */
export function toTerminalText(text: string): string {
	return text.replace(/\r?\n/g, "\r\n")
}

/** How one activity reads in the tab; `atLineStart` says whether output left the cursor mid-line. */
export function renderRemoteActivity(event: RemoteActivity, atLineStart: boolean): string {
	const lead = atLineStart ? "" : "\r\n"
	const session = dim(`[${event.sessionId.slice(-12)}]`)
	switch (event.type) {
		case "command":
			return `${lead}\r\n${session} ${cyan(event.cwd)}\r\n${bold("$")} ${bold(toTerminalText(event.command))}\r\n`
		case "output":
			return toTerminalText(event.data)
		case "exit": {
			const code = event.exitCode ?? "?"
			const verdict = event.exitCode === 0 ? green(`exit ${code}`) : red(`exit ${code}`)
			return `${lead}${dim("──")} ${verdict} ${dim(`after ${event.seconds.toFixed(1)} s`)}\r\n`
		}
		case "running":
			return `${lead}${dim("──")} ${yellow(`still running as ${event.processId}`)} ${dim(`(${event.seconds.toFixed(1)} s); the model may wait for it again`)}\r\n`
		case "note":
			return `${lead}${session} ${dim(toTerminalText(event.text))}\r\n`
	}
}

export function remoteMirrorBanner(name: string): string {
	return `${dim(`What Cerebriline runs on ${name}, as it happens. Read-only: typing here does nothing.`)}\r\n`
}

export const REMOTE_MIRROR_INPUT_HINT = `\r\n${yellow('This tab only shows what the model runs; it does not take input. To type there yourself, run "Cerebriline: Open a Shell on a Remote Terminal".')}\r\n`

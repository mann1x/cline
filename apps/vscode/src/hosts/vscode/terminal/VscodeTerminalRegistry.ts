import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"

export interface TerminalInfo {
	terminal: vscode.Terminal
	busy: boolean
	lastCommand: string
	id: number
	shellPath?: string
	lastActive: number
	pendingCwdChange?: string
	cwdResolved?: {
		resolve: () => void
		reject: (error: Error) => void
	}
}

// Although vscode.window.terminals provides a list of all open terminals, there's no way to know whether they're busy or not (exitStatus does not provide useful information for most commands). In order to prevent creating too many terminals, we need to keep track of terminals through the life of the extension, as well as session specific terminals for the life of a task (to get latest unretrieved output).
// Since we have promises keeping track of terminal processes, we get the added benefit of keep track of busy terminals even after a task is closed.
/**
 * Why a terminal is waiting to be closed, which is also when it closes.
 *
 * `abandoned-during-preparation` is the no-shell-integration case: the cwd can
 * never be confirmed, so every acquisition abandons the terminal it tried to
 * reuse. `unobserved-command` is a managed command whose completion Cline lost
 * track of.
 */
export type TerminalCleanupReason = "abandoned-during-preparation" | "unobserved-command"

/** The terminal name every Cline-created terminal carries. */
export const CLINE_TERMINAL_NAME = "Cline"

/**
 * Which extension host created a terminal.
 *
 * Terminals outlive the extension host that made them: the window owns them,
 * and a host restart -- which is what installing a `.vsix` does -- leaves the
 * previous host's terminals open with nothing tracking them. Stamping the host
 * into the environment lets `reclaimOrphanedTerminals` prove a terminal belongs
 * to a host that is gone rather than inferring it.
 */
const CLINE_HOST_SESSION_ENV = "CLINE_HOST_SESSION"

export class TerminalRegistry {
	private static terminals: TerminalInfo[] = []
	private static terminalsPendingCleanup = new Map<number, { terminalInfo: TerminalInfo; reason: TerminalCleanupReason }>()
	private static nextTerminalId = 1
	/** Identifies this extension host for the life of the process. */
	private static readonly hostSessionId = `${process.pid}-${Date.now()}`

	static createTerminal(cwd?: string | vscode.Uri | undefined, shellPath?: string): TerminalInfo {
		const terminalOptions: vscode.TerminalOptions = {
			cwd,
			name: CLINE_TERMINAL_NAME,
			iconPath: new vscode.ThemeIcon("cline-icon"),
			// A Cline terminal is reusable only by the extension host that made
			// it: reuse is decided from `TerminalRegistry.terminals`, a static
			// that starts empty in every new host. Persisting one past the window
			// therefore revives a shell nothing can ever reuse and nothing will
			// ever close -- measured on the test host as 16 shells restored in a
			// single second at window start, against a registry that held two.
			isTransient: true,
			env: {
				CLINE_ACTIVE: "true",
				[CLINE_HOST_SESSION_ENV]: TerminalRegistry.hostSessionId,
				// Override $SHELL to match the selected shell profile so that
				// child processes (make, npm scripts, etc.) that read $SHELL
				// see the correct value instead of the user's login shell.
				...(shellPath ? { SHELL: shellPath } : {}),
			},
		}

		// If a specific shell path is provided, use it
		if (shellPath) {
			terminalOptions.shellPath = shellPath
		}

		const terminal = vscode.window.createTerminal(terminalOptions)
		TerminalRegistry.nextTerminalId++
		const newInfo: TerminalInfo = {
			terminal,
			busy: false,
			lastCommand: "",
			id: TerminalRegistry.nextTerminalId,
			shellPath,
			lastActive: Date.now(),
		}
		TerminalRegistry.terminals.push(newInfo)
		return newInfo
	}

	static getTerminal(id: number): TerminalInfo | undefined {
		const terminalInfo = TerminalRegistry.terminals.find((t) => t.id === id)
		if (terminalInfo && TerminalRegistry.isTerminalClosed(terminalInfo.terminal)) {
			TerminalRegistry.removeTerminal(id)
			return undefined
		}
		return terminalInfo
	}

	static updateTerminal(id: number, updates: Partial<TerminalInfo>) {
		const terminal = TerminalRegistry.getTerminal(id)
		if (terminal) {
			Object.assign(terminal, updates)
		}
	}

	static removeTerminal(id: number) {
		TerminalRegistry.terminals = TerminalRegistry.terminals.filter((t) => t.id !== id)
	}

	/**
	 * Evict a terminal now and remember it for disposal.
	 *
	 * Keeping this queue in the global registry preserves cleanup ownership
	 * across task-scoped terminal-manager replacement.
	 *
	 * The reason decides when it closes, because the two cases hold different
	 * things. A terminal abandoned during preparation received nothing but
	 * Cline's own `cd`: there is no output for anyone to read, so it is closed
	 * as soon as the acquisition that abandoned it is finished. A terminal whose
	 * command stopped being observable may have run something the user wants to
	 * look at, so it waits for the next acquisition -- by which time the tool
	 * result reporting the indeterminate outcome has long since been seen.
	 */
	static queueTerminalForCleanup(terminalInfo: TerminalInfo, reason: TerminalCleanupReason): void {
		TerminalRegistry.removeTerminal(terminalInfo.id)
		TerminalRegistry.terminalsPendingCleanup.set(terminalInfo.id, { terminalInfo, reason })
	}

	/**
	 * Dispose the terminals that were cleanup-eligible when this call began.
	 *
	 * With a reason, only the entries queued for it. Without one, everything --
	 * which is what the acquisition boundary does, because by then both kinds
	 * have had their moment.
	 */
	static disposeTerminalsPendingCleanup(reason?: TerminalCleanupReason): void {
		const pending = Array.from(TerminalRegistry.terminalsPendingCleanup.entries())
		for (const [id, entry] of pending) {
			if (reason !== undefined && entry.reason !== reason) {
				continue
			}
			// Remove ownership before dispose(), which may synchronously trigger
			// terminal-close listeners that acquire another terminal. Restore it if
			// disposal fails so the resource is never silently lost.
			TerminalRegistry.terminalsPendingCleanup.delete(id)
			try {
				entry.terminalInfo.terminal.dispose()
			} catch (error) {
				TerminalRegistry.terminalsPendingCleanup.set(id, entry)
				Logger.warn(`[TerminalRegistry] Failed to dispose fallback terminal ${id}; cleanup will be retried`, error)
			}
		}
	}

	/**
	 * Close Cline terminals left behind by an extension host that is gone.
	 *
	 * The seam this covers: a terminal is owned by the *window*, reuse is
	 * decided from a `static` owned by the *extension host*, and nothing in the
	 * ordinary path ever disposes a healthy terminal -- `disposeAll()` keeps
	 * them deliberately, and the cleanup queue only takes the two failure
	 * reasons above. So every host restart (each `--install-extension`, each
	 * "Reload Window") strands the terminals the previous host was reusing:
	 * invisible to the new registry, and with no shell exit to close them they
	 * sit at a prompt forever. Measured on the test host after a day of
	 * deploys: 21 live `pwsh.exe`, against a registry that never held more than
	 * two.
	 *
	 * Safe to call at activation, and only meaningful there: ownership is
	 * proven twice over. A terminal is reclaimed only if it is absent from this
	 * host's registry *and* its `CLINE_HOST_SESSION` is not this host's -- and a
	 * terminal with no stamp at all is one this host provably did not create,
	 * since `createTerminal` always writes it. A user's own shell is untouched:
	 * it carries neither the name nor the stamp.
	 *
	 * @returns how many were closed.
	 */
	static reclaimOrphanedTerminals(): number {
		const tracked = new Set(TerminalRegistry.terminals.map((t) => t.terminal))
		let reclaimed = 0
		for (const terminal of vscode.window.terminals) {
			if (terminal.name !== CLINE_TERMINAL_NAME || tracked.has(terminal)) {
				continue
			}
			const options = terminal.creationOptions as vscode.TerminalOptions
			const env = options?.env as Record<string, string | null | undefined> | undefined
			if (env?.[CLINE_HOST_SESSION_ENV] === TerminalRegistry.hostSessionId) {
				continue
			}
			try {
				terminal.dispose()
				reclaimed += 1
			} catch (error) {
				Logger.warn("[TerminalRegistry] Failed to reclaim an orphaned Cline terminal", error)
			}
		}
		if (reclaimed > 0) {
			Logger.log(`[TerminalRegistry] Reclaimed ${reclaimed} orphaned Cline terminal(s) from a previous extension host`)
		}
		return reclaimed
	}

	static getAllTerminals(): TerminalInfo[] {
		TerminalRegistry.terminals = TerminalRegistry.terminals.filter((t) => !TerminalRegistry.isTerminalClosed(t.terminal))
		return TerminalRegistry.terminals
	}

	// The exit status of the terminal will be undefined while the terminal is active. (This value is set when onDidCloseTerminal is fired.)
	private static isTerminalClosed(terminal: vscode.Terminal): boolean {
		return terminal.exitStatus !== undefined
	}
}

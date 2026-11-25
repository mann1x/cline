import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as sinon from "sinon"
import * as vscode from "vscode"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { TerminalLimitReachedError } from "./terminal-limit"
import { VscodeTerminalManager } from "./VscodeTerminalManager"
import { CLINE_TERMINAL_NAME, TerminalInfo, TerminalRegistry } from "./VscodeTerminalRegistry"

function createNeverEndingStream(): AsyncIterable<string> {
	return {
		async *[Symbol.asyncIterator]() {
			await new Promise(() => {})
		},
	}
}

function createMarkerlessStream(): AsyncIterable<string> {
	return {
		async *[Symbol.asyncIterator]() {
			yield "remote output\n"
			yield "user@remote:~$ "
			await new Promise(() => {})
		},
	}
}

function createFailingStream(error: Error): AsyncIterable<string> {
	return {
		async *[Symbol.asyncIterator]() {
			throw error
		},
	}
}

describe("VscodeTerminalManager", () => {
	let sandbox: sinon.SinonSandbox
	let manager: VscodeTerminalManager

	beforeEach(() => {
		sandbox = sinon.createSandbox({ useFakeTimers: true })
		manager = new VscodeTerminalManager()
		// The test window is shared by every test here, and disposal is not
		// synchronous, so its real terminal count is noise. The limit has its
		// own tests below, with the count stated.
		sandbox.stub(TerminalRegistry, "countOpenTerminals").returns(0)
	})

	afterEach(() => {
		manager.disposeAll()
		TerminalRegistry.disposeTerminalsPendingCleanup()
		sandbox.restore()
	})

	it("creates a fresh terminal after timing out an unconfirmed reused-terminal cwd change", async () => {
		setVscodeHostProviderMock()
		const targetCwd = "/tmp/cline-target"
		const executeCommandStub = sandbox.stub().returns({
			read: () => createNeverEndingStream(),
		})
		const terminalInfo: TerminalInfo = {
			id: 1,
			busy: false,
			lastCommand: "",
			lastActive: Date.now(),
			terminal: {
				shellIntegration: {
					cwd: vscode.Uri.file("/tmp/cline-original"),
					executeCommand: executeCommandStub,
				},
				show: sandbox.stub(),
			} as unknown as vscode.Terminal,
		}
		const getAllTerminalsStub = sandbox.stub(TerminalRegistry, "getAllTerminals").returns([terminalInfo])

		let didResolve = false
		const terminalPromise = manager.getOrCreateTerminal(targetCwd).then((terminal) => {
			didResolve = true
			return terminal
		})

		await sandbox.clock.tickAsync(4999)
		assert.equal(didResolve, false)

		await sandbox.clock.tickAsync(1)
		const terminal = (await terminalPromise) as unknown as TerminalInfo

		try {
			assert.notEqual(terminal, terminalInfo)
			assert.equal(terminalInfo.busy, false)
			assert.equal(terminalInfo.pendingCwdChange, undefined)
			assert.equal(terminalInfo.cwdResolved, undefined)
			assert.equal(terminal.busy, true)
			assert.equal(getAllTerminalsStub.called, true)
			assert.equal(executeCommandStub.calledOnceWith(`cd "${targetCwd}"`), true)
		} finally {
			terminal.terminal.dispose()
			TerminalRegistry.removeTerminal(terminal.id)
		}
	})

	it("reuses a terminal after its cwd change is confirmed", async () => {
		const targetCwd = "/tmp/cline-target"
		let currentCwd = vscode.Uri.file("/tmp/cline-original")
		const terminalInfo: TerminalInfo = {
			id: 1,
			busy: false,
			lastCommand: "",
			lastActive: Date.now(),
			terminal: {
				shellIntegration: {
					get cwd() {
						return currentCwd
					},
					executeCommand: () => ({
						read: () => ({
							async *[Symbol.asyncIterator]() {
								currentCwd = vscode.Uri.file(targetCwd)
							},
						}),
					}),
				},
				show: sandbox.stub(),
			} as unknown as vscode.Terminal,
		}
		sandbox.stub(TerminalRegistry, "getAllTerminals").returns([terminalInfo])

		const terminalPromise = manager.getOrCreateTerminal(targetCwd)
		await sandbox.clock.tickAsync(100)
		const terminal = await terminalPromise

		assert.equal(terminal, terminalInfo)
		assert.equal(terminalInfo.busy, true)
		assert.equal(terminalInfo.pendingCwdChange, undefined)
		assert.equal(terminalInfo.cwdResolved, undefined)
	})

	it("releases a reused terminal reservation when showing it fails", async () => {
		const terminalInfo: TerminalInfo = {
			id: 1,
			busy: false,
			lastCommand: "",
			lastActive: Date.now(),
			terminal: {
				shellIntegration: { cwd: vscode.Uri.file("/tmp/cline-original") },
				show: sandbox.stub().throws(new Error("terminal closed")),
			} as unknown as vscode.Terminal,
		}
		sandbox.stub(TerminalRegistry, "getAllTerminals").returns([terminalInfo])

		await assert.rejects(manager.getOrCreateTerminal("/tmp/cline-target"), /terminal closed/)

		assert.equal(terminalInfo.busy, false)
		assert.equal(terminalInfo.pendingCwdChange, undefined)
		assert.equal(terminalInfo.cwdResolved, undefined)
	})

	it("creates a fresh terminal when the reused-terminal cwd command cannot start", async () => {
		setVscodeHostProviderMock()
		const terminalInfo: TerminalInfo = {
			id: 1,
			busy: false,
			lastCommand: "",
			lastActive: Date.now(),
			terminal: {
				shellIntegration: {
					cwd: vscode.Uri.file("/tmp/cline-original"),
					executeCommand: () => {
						throw new Error("cwd command failed")
					},
				},
				show: sandbox.stub(),
			} as unknown as vscode.Terminal,
		}
		sandbox.stub(TerminalRegistry, "getAllTerminals").returns([terminalInfo])

		const terminal = (await manager.getOrCreateTerminal("/tmp/cline-target")) as unknown as TerminalInfo
		try {
			assert.notEqual(terminal, terminalInfo)
			assert.equal(terminal.busy, true)
			assert.equal(terminalInfo.busy, false)
			assert.equal(terminalInfo.pendingCwdChange, undefined)
			assert.equal(terminalInfo.cwdResolved, undefined)
			assert.equal(TerminalRegistry.getTerminal(terminalInfo.id), undefined)
		} finally {
			terminal.terminal.dispose()
			TerminalRegistry.removeTerminal(terminal.id)
		}
	})

	/**
	 * A shell with no integration can never have its cwd confirmed, so every
	 * acquisition discards the candidate and creates a fresh terminal. Evicting
	 * without closing leaked one window per command (mann1x/cline#56); the
	 * discarded terminal is now closed at the next acquisition boundary.
	 */
	it("closes a terminal it abandons because the cwd could not be confirmed", async () => {
		setVscodeHostProviderMock()
		const disposeStub = sandbox.stub()
		const terminalInfo: TerminalInfo = {
			id: 1,
			busy: false,
			lastCommand: "",
			lastActive: Date.now(),
			terminal: {
				// No shellIntegration at all: `cd` goes out via sendText and the
				// resulting cwd is unobservable, which is the case that leaked.
				sendText: sandbox.stub(),
				show: sandbox.stub(),
				dispose: disposeStub,
			} as unknown as vscode.Terminal,
		}
		sandbox.stub(TerminalRegistry, "getAllTerminals").returns([terminalInfo])

		const acquisition = manager.getOrCreateTerminal("/tmp/cline-target")
		await sandbox.clock.tickAsync(5000)
		const terminal = (await acquisition) as unknown as TerminalInfo

		try {
			assert.notEqual(terminal, terminalInfo)
			assert.equal(TerminalRegistry.getTerminal(terminalInfo.id), undefined)
			// Closed by the time this acquisition resolves, without waiting for
			// a next one. It used to wait, and the queue's only drain was the
			// top of the next acquisition -- so a session whose last command
			// abandoned a terminal left it open until VS Code closed. It holds
			// nothing to read: all it ever received was Cerebriline's own `cd`.
			assert.equal(disposeStub.calledOnce, true)

			// And it is not disposed twice by the drain at the next acquisition.
			TerminalRegistry.disposeTerminalsPendingCleanup()
			assert.equal(disposeStub.calledOnce, true)
		} finally {
			terminal.terminal.dispose()
			TerminalRegistry.removeTerminal(terminal.id)
		}
	})

	// The other half of the same rule: a command Cerebriline stopped being able to
	// observe may have produced output the user wants, so that terminal still
	// waits for the next acquisition rather than closing under them.
	it("leaves an unobserved command's terminal open when an acquisition ends", async () => {
		setVscodeHostProviderMock()
		const abandoned = TerminalRegistry.createTerminal()
		const abandonedDispose = sandbox.spy(abandoned.terminal, "dispose")
		TerminalRegistry.queueTerminalForCleanup(abandoned, "unobserved-command")
		let acquired: TerminalInfo | undefined

		try {
			acquired = (await manager.getOrCreateTerminal("/tmp/cline-unobserved-kept")) as unknown as TerminalInfo
			// The drain at the top of that acquisition takes everything, so this
			// one is gone -- but it was queued before it, not during it.
			assert.equal(abandonedDispose.calledOnce, true)

			const second = TerminalRegistry.createTerminal()
			const secondDispose = sandbox.spy(second.terminal, "dispose")
			TerminalRegistry.queueTerminalForCleanup(second, "unobserved-command")
			acquired.terminal.dispose()
			TerminalRegistry.removeTerminal(acquired.id)
			acquired = (await manager.getOrCreateTerminal("/tmp/cline-unobserved-kept-2")) as unknown as TerminalInfo
			assert.equal(secondDispose.calledOnce, true, "the next acquisition reclaims it")
		} finally {
			acquired?.terminal.dispose()
			if (acquired) {
				TerminalRegistry.removeTerminal(acquired.id)
			}
			TerminalRegistry.disposeTerminalsPendingCleanup()
		}
	})

	it("creates a fresh terminal when the reused-terminal cwd command stream fails", async () => {
		setVscodeHostProviderMock()
		const terminalInfo: TerminalInfo = {
			id: 1,
			busy: false,
			lastCommand: "",
			lastActive: Date.now(),
			terminal: {
				shellIntegration: {
					cwd: vscode.Uri.file("/tmp/cline-original"),
					executeCommand: () => ({ read: () => createFailingStream(new Error("cwd stream failed")) }),
				},
				show: sandbox.stub(),
			} as unknown as vscode.Terminal,
		}
		sandbox.stub(TerminalRegistry, "getAllTerminals").returns([terminalInfo])

		const terminal = (await manager.getOrCreateTerminal("/tmp/cline-target")) as unknown as TerminalInfo
		try {
			assert.notEqual(terminal, terminalInfo)
			assert.equal(terminal.busy, true)
			assert.equal(terminalInfo.busy, false)
			assert.equal(terminalInfo.pendingCwdChange, undefined)
			assert.equal(terminalInfo.cwdResolved, undefined)
			assert.equal(TerminalRegistry.getTerminal(terminalInfo.id), undefined)
		} finally {
			terminal.terminal.dispose()
			TerminalRegistry.removeTerminal(terminal.id)
		}
	})

	it("releases a reused terminal reservation when it closes during cwd setup", async () => {
		let exitStatus: vscode.TerminalExitStatus | undefined
		const terminalInfo: TerminalInfo = {
			id: 1,
			busy: false,
			lastCommand: "",
			lastActive: Date.now(),
			terminal: {
				get exitStatus() {
					return exitStatus
				},
				shellIntegration: {
					cwd: vscode.Uri.file("/tmp/cline-original"),
					executeCommand: () => ({ read: createNeverEndingStream }),
				},
				show: sandbox.stub(),
			} as unknown as vscode.Terminal,
		}
		sandbox.stub(TerminalRegistry, "getAllTerminals").returns([terminalInfo])

		const rejectedAcquisition = assert.rejects(manager.getOrCreateTerminal("/tmp/cline-target"), /exited while preparing/)
		exitStatus = { code: undefined, reason: vscode.TerminalExitReason.Unknown }
		await sandbox.clock.tickAsync(5000)
		await rejectedAcquisition

		assert.equal(terminalInfo.busy, false)
		assert.equal(terminalInfo.pendingCwdChange, undefined)
		assert.equal(terminalInfo.cwdResolved, undefined)
	})

	it("reserves different terminals for parallel acquisitions", async () => {
		setVscodeHostProviderMock()
		const first = (await manager.getOrCreateTerminal("/tmp/cline-parallel")) as unknown as TerminalInfo
		const second = (await manager.getOrCreateTerminal("/tmp/cline-parallel")) as unknown as TerminalInfo

		try {
			assert.notEqual(first.id, second.id)
			assert.equal(first.busy, true)
			assert.equal(second.busy, true)
		} finally {
			first.terminal.dispose()
			second.terminal.dispose()
			TerminalRegistry.removeTerminal(first.id)
			TerminalRegistry.removeTerminal(second.id)
		}
	})

	it("rejects the command and releases the terminal when process startup fails", async () => {
		const terminalInfo: TerminalInfo = {
			id: 1,
			busy: true,
			lastCommand: "",
			lastActive: Date.now(),
			terminal: {
				shellIntegration: {
					executeCommand: () => {
						throw new Error("command startup failed")
					},
				},
				show: sandbox.stub(),
			} as unknown as vscode.Terminal,
		}

		const process = manager.runCommand(
			terminalInfo as unknown as Parameters<VscodeTerminalManager["runCommand"]>[0],
			"failing-command",
		)

		await assert.rejects(process, /command startup failed/)
		assert.equal(TerminalRegistry.getTerminal(terminalInfo.id), undefined)
	})

	it("does not reuse a terminal after its command stream fails", async () => {
		setVscodeHostProviderMock()
		const terminalInfo = TerminalRegistry.createTerminal("/tmp/cline-stream-error")
		sandbox.stub(terminalInfo.terminal, "shellIntegration").get(() => ({
			cwd: vscode.Uri.file("/tmp/cline-stream-error"),
			executeCommand: () => ({ read: () => createFailingStream(new Error("command stream failed")) }),
		}))

		const process = manager.runCommand(
			terminalInfo as unknown as Parameters<VscodeTerminalManager["runCommand"]>[0],
			"long-running-command",
		)
		await assert.rejects(process, /command stream failed/)

		const nextTerminal = (await manager.getOrCreateTerminal("/tmp/cline-stream-error")) as unknown as TerminalInfo
		try {
			assert.notEqual(nextTerminal.id, terminalInfo.id)
			assert.equal(TerminalRegistry.getTerminal(terminalInfo.id), undefined)
		} finally {
			terminalInfo.terminal.dispose()
			nextTerminal.terminal.dispose()
			TerminalRegistry.removeTerminal(nextTerminal.id)
		}
	})

	// mann1x/cline#56: the error path evicted the terminal and nothing ever
	// closed it. It is queued for the same cleanup as an abandoned terminal.
	it("closes a terminal whose command stream failed at the next acquisition", async () => {
		setVscodeHostProviderMock()
		const terminalInfo = TerminalRegistry.createTerminal("/tmp/cline-stream-error-cleanup")
		sandbox.stub(terminalInfo.terminal, "shellIntegration").get(() => ({
			cwd: vscode.Uri.file("/tmp/cline-stream-error-cleanup"),
			executeCommand: () => ({ read: () => createFailingStream(new Error("command stream failed")) }),
		}))
		const disposeSpy = sandbox.spy(terminalInfo.terminal, "dispose")

		const process = manager.runCommand(
			terminalInfo as unknown as Parameters<VscodeTerminalManager["runCommand"]>[0],
			"long-running-command",
		)
		await assert.rejects(process, /command stream failed/)
		assert.equal(disposeSpy.called, false, "the failed command's terminal is not closed under it")

		const nextTerminal = (await manager.getOrCreateTerminal("/tmp/cline-stream-error-cleanup")) as unknown as TerminalInfo
		try {
			assert.equal(disposeSpy.calledOnce, true, "the next acquisition closes the failed terminal")
			assert.notEqual(nextTerminal.id, terminalInfo.id)
		} finally {
			nextTerminal.terminal.dispose()
			TerminalRegistry.removeTerminal(nextTerminal.id)
		}
	})

	it("continues terminal acquisition when pending cleanup fails", async () => {
		setVscodeHostProviderMock()
		const failedCleanup = TerminalRegistry.createTerminal()
		const successfulCleanup = TerminalRegistry.createTerminal()
		const failedDispose = sandbox.stub(failedCleanup.terminal, "dispose").throws(new Error("dispose failed"))
		const successfulDispose = sandbox.spy(successfulCleanup.terminal, "dispose")
		TerminalRegistry.queueTerminalForCleanup(failedCleanup, "unobserved-command")
		TerminalRegistry.queueTerminalForCleanup(successfulCleanup, "unobserved-command")
		let acquiredTerminal: TerminalInfo | undefined
		let didRestoreFailedDispose = false

		try {
			acquiredTerminal = (await manager.getOrCreateTerminal("/tmp/cline-after-cleanup-error")) as unknown as TerminalInfo
			assert.equal(successfulDispose.calledOnce, true)
			assert.notEqual(acquiredTerminal.id, failedCleanup.id)

			failedDispose.restore()
			didRestoreFailedDispose = true
			const retryDispose = sandbox.spy(failedCleanup.terminal, "dispose")
			TerminalRegistry.disposeTerminalsPendingCleanup()
			assert.equal(retryDispose.calledOnce, true)
		} finally {
			if (!didRestoreFailedDispose) {
				failedDispose.restore()
			}
			acquiredTerminal?.terminal.dispose()
			if (acquiredTerminal) {
				TerminalRegistry.removeTerminal(acquiredTerminal.id)
			}
			TerminalRegistry.disposeTerminalsPendingCleanup()
		}
	})

	it("disposes an already-exited fallback terminal exactly once", () => {
		const terminalInfo = TerminalRegistry.createTerminal()
		const disposeSpy = sandbox.spy(terminalInfo.terminal, "dispose")
		sandbox.stub(terminalInfo.terminal, "exitStatus").get(() => ({
			code: 0,
			reason: vscode.TerminalExitReason.Process,
		}))
		TerminalRegistry.queueTerminalForCleanup(terminalInfo, "unobserved-command")

		TerminalRegistry.disposeTerminalsPendingCleanup()
		TerminalRegistry.disposeTerminalsPendingCleanup()

		assert.equal(disposeSpy.calledOnce, true)
	})

	it("defers fallback terminal disposal until the next terminal acquisition", async () => {
		setVscodeHostProviderMock()
		const terminalInfo = TerminalRegistry.createTerminal()
		sandbox.stub(terminalInfo.terminal, "shellIntegration").get(() => undefined)
		sandbox.stub(terminalInfo.terminal, "sendText")
		const disposeSpy = sandbox.spy(terminalInfo.terminal, "dispose")
		let nextTerminal: TerminalInfo | undefined
		let nextManager: VscodeTerminalManager | undefined

		try {
			const process = manager.runCommand(
				terminalInfo as unknown as Parameters<VscodeTerminalManager["runCommand"]>[0],
				"sleep 999",
			)
			await sandbox.clock.tickAsync(4000)
			await sandbox.clock.tickAsync(3000)
			await process

			assert.deepEqual(process.getCompletionDetails?.().unobservedCommand, {
				source: "sendText",
				ownership: "managed",
			})
			assert.equal(disposeSpy.called, false, "the command must not be killed when the fallback result resolves")
			assert.equal(TerminalRegistry.getTerminal(terminalInfo.id), undefined, "the terminal must be evicted from reuse")

			nextManager = new VscodeTerminalManager()
			nextTerminal = (await nextManager.getOrCreateTerminal("/tmp/cline-next-command")) as unknown as TerminalInfo
			assert.equal(disposeSpy.calledOnce, true, "the next acquisition must reclaim the fallback terminal")
		} finally {
			nextManager?.disposeAll()
			nextTerminal?.terminal.dispose()
			if (nextTerminal) {
				TerminalRegistry.removeTerminal(nextTerminal.id)
			}
			if (!disposeSpy.called) {
				terminalInfo.terminal.dispose()
				TerminalRegistry.removeTerminal(terminalInfo.id)
			}
		}
	})

	it("preserves a detached fallback terminal across the next terminal acquisition", async () => {
		setVscodeHostProviderMock()
		const terminalInfo = TerminalRegistry.createTerminal()
		sandbox.stub(terminalInfo.terminal, "shellIntegration").get(() => undefined)
		sandbox.stub(terminalInfo.terminal, "sendText")
		const disposeSpy = sandbox.spy(terminalInfo.terminal, "dispose")
		let nextTerminal: TerminalInfo | undefined

		try {
			const process = manager.runCommand(
				terminalInfo as unknown as Parameters<VscodeTerminalManager["runCommand"]>[0],
				"sleep 999",
			)
			const unobservedCommand = new Promise<void>((resolve) => process.once("unobserved_command", () => resolve()))
			process.detach()
			await sandbox.clock.tickAsync(4000)
			await sandbox.clock.tickAsync(3000)
			await unobservedCommand

			nextTerminal = (await manager.getOrCreateTerminal("/tmp/cline-next-command")) as unknown as TerminalInfo
			assert.equal(disposeSpy.called, false, "Proceed While Running transfers terminal ownership to the user")
			assert.equal(TerminalRegistry.getTerminal(terminalInfo.id), undefined, "detached terminals must not be reused")
		} finally {
			nextTerminal?.terminal.dispose()
			if (nextTerminal) {
				TerminalRegistry.removeTerminal(nextTerminal.id)
			}
			terminalInfo.terminal.dispose()
			TerminalRegistry.removeTerminal(terminalInfo.id)
		}
	})

	it("preserves a continued fallback terminal across the next terminal acquisition", async () => {
		setVscodeHostProviderMock()
		const terminalInfo = TerminalRegistry.createTerminal()
		sandbox.stub(terminalInfo.terminal, "shellIntegration").get(() => undefined)
		sandbox.stub(terminalInfo.terminal, "sendText")
		const disposeSpy = sandbox.spy(terminalInfo.terminal, "dispose")
		let nextTerminal: TerminalInfo | undefined

		try {
			const process = manager.runCommand(
				terminalInfo as unknown as Parameters<VscodeTerminalManager["runCommand"]>[0],
				"sleep 999",
			)
			const unobservedCommand = new Promise<void>((resolve) => process.once("unobserved_command", () => resolve()))
			process.continue()
			await sandbox.clock.tickAsync(4000)
			await sandbox.clock.tickAsync(3000)
			await unobservedCommand

			nextTerminal = (await manager.getOrCreateTerminal("/tmp/cline-next-command")) as unknown as TerminalInfo
			assert.equal(disposeSpy.called, false, "stopping the wait relinquishes cleanup ownership")
			assert.equal(TerminalRegistry.getTerminal(terminalInfo.id), undefined, "continued terminals must not be reused")
		} finally {
			nextTerminal?.terminal.dispose()
			if (nextTerminal) {
				TerminalRegistry.removeTerminal(nextTerminal.id)
			}
			terminalInfo.terminal.dispose()
			TerminalRegistry.removeTerminal(terminalInfo.id)
		}
	})

	it("preserves a markerless shell-integration terminal across the next terminal acquisition", async () => {
		setVscodeHostProviderMock()
		const terminalInfo = TerminalRegistry.createTerminal()
		sandbox.stub(terminalInfo.terminal, "shellIntegration").get(() => ({
			executeCommand: () => ({ read: createMarkerlessStream }),
		}))
		const disposeSpy = sandbox.spy(terminalInfo.terminal, "dispose")
		let nextTerminal: TerminalInfo | undefined

		try {
			const process = manager.runCommand(
				terminalInfo as unknown as Parameters<VscodeTerminalManager["runCommand"]>[0],
				"remote-command",
			)
			await sandbox.clock.tickAsync(15_000)
			await process

			assert.deepEqual(process.getCompletionDetails?.().unobservedCommand, {
				source: "markerlessShellIntegration",
				ownership: "managed",
			})
			nextTerminal = (await manager.getOrCreateTerminal("/tmp/cline-next-command")) as unknown as TerminalInfo
			assert.equal(disposeSpy.called, false, "an SSH or nested-shell session remains user-owned")
			assert.equal(TerminalRegistry.getTerminal(terminalInfo.id), undefined, "markerless terminals must not be reused")
		} finally {
			nextTerminal?.terminal.dispose()
			if (nextTerminal) {
				TerminalRegistry.removeTerminal(nextTerminal.id)
			}
			terminalInfo.terminal.dispose()
			TerminalRegistry.removeTerminal(terminalInfo.id)
		}
	})
})

/**
 * Terminals outlive the extension host that created them, and reuse does not:
 * `TerminalRegistry.terminals` is a static that starts empty in every new host,
 * while the window keeps the shells. Nothing in the ordinary path closes a
 * healthy terminal either -- `disposeAll()` keeps them deliberately and the
 * cleanup queue only takes the two failure reasons. So each host restart (every
 * `--install-extension`, every "Reload Window") stranded the terminals the
 * previous host was reusing. Measured on the test host after a day of deploys:
 * 21 live `pwsh.exe`, 16 of them revived in a single second at window start,
 * against a registry that never held more than two.
 */
// mann1x/cline#56: a cap on how many Cerebriline terminals a window holds.
describe("VscodeTerminalManager terminal limit", () => {
	let sandbox: sinon.SinonSandbox
	let manager: VscodeTerminalManager
	const created: vscode.Terminal[] = []

	function idleTerminal(id: number, lastActive: number, busy = false): TerminalInfo & { dispose: sinon.SinonStub } {
		const dispose = sandbox.stub()
		return {
			id,
			busy,
			lastCommand: "",
			lastActive,
			// No shellIntegration: never in a confirmed cwd, so never reused.
			terminal: { sendText: sandbox.stub(), show: sandbox.stub(), dispose } as unknown as vscode.Terminal,
			dispose,
		}
	}

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		manager = new VscodeTerminalManager()
		// Reuse off, so the acquisition goes straight to opening a terminal --
		// the only place the limit applies.
		manager.setTerminalReuseEnabled(false)
	})

	afterEach(() => {
		manager.disposeAll()
		TerminalRegistry.disposeTerminalsPendingCleanup()
		sandbox.restore()
		for (const terminal of created.splice(0)) {
			terminal.dispose()
		}
	})

	it("closes the least recently used idle terminal to open a new one at the limit", async () => {
		const older = idleTerminal(101, 1_000)
		const newer = idleTerminal(102, 2_000)
		const running = idleTerminal(103, 500, true)
		sandbox.stub(TerminalRegistry, "getAllTerminals").returns([newer, running, older])
		sandbox.stub(TerminalRegistry, "countOpenTerminals").returns(3)
		manager.setMaxTerminals(3)

		const terminal = (await manager.getOrCreateTerminal("/tmp/cline-target")) as unknown as TerminalInfo
		created.push(terminal.terminal)
		TerminalRegistry.removeTerminal(terminal.id)

		assert.equal(older.dispose.callCount, 1)
		assert.equal(newer.dispose.callCount, 0)
		// A busy terminal may be a dev server; it is never closed for room.
		assert.equal(running.dispose.callCount, 0)
		assert.equal(terminal.busy, true)
	})

	it("opens no terminal when every one is busy, and says why", async () => {
		const server = idleTerminal(201, 1_000, true)
		const watcher = idleTerminal(202, 2_000, true)
		sandbox.stub(TerminalRegistry, "getAllTerminals").returns([server, watcher])
		sandbox.stub(TerminalRegistry, "countOpenTerminals").returns(2)
		const createTerminal = sandbox.spy(TerminalRegistry, "createTerminal")
		manager.setMaxTerminals(2)

		await assert.rejects(manager.getOrCreateTerminal("/tmp/cline-target"), (error: unknown) => {
			assert.ok(error instanceof TerminalLimitReachedError)
			assert.equal(error.limit, 2)
			assert.equal(error.open, 2)
			return true
		})
		assert.equal(createTerminal.callCount, 0)
		assert.equal(server.dispose.callCount, 0)
		assert.equal(watcher.dispose.callCount, 0)
	})

	it("opens a terminal below the limit without closing anything", async () => {
		const idle = idleTerminal(301, 1_000)
		sandbox.stub(TerminalRegistry, "getAllTerminals").returns([idle])
		sandbox.stub(TerminalRegistry, "countOpenTerminals").returns(1)
		manager.setMaxTerminals(2)

		const terminal = (await manager.getOrCreateTerminal("/tmp/cline-target")) as unknown as TerminalInfo
		created.push(terminal.terminal)
		TerminalRegistry.removeTerminal(terminal.id)

		assert.equal(idle.dispose.callCount, 0)
	})

	it("has no limit at 0", async () => {
		const server = idleTerminal(401, 1_000, true)
		sandbox.stub(TerminalRegistry, "getAllTerminals").returns([server])
		sandbox.stub(TerminalRegistry, "countOpenTerminals").returns(50)
		manager.setMaxTerminals(0)

		const terminal = (await manager.getOrCreateTerminal("/tmp/cline-target")) as unknown as TerminalInfo
		created.push(terminal.terminal)
		TerminalRegistry.removeTerminal(terminal.id)

		assert.equal(terminal.busy, true)
	})

	// The count is of windows, not of what the registry tracks: a terminal
	// left open on purpose (an ssh session) is still one.
	it("counts untracked Cerebriline windows, and not other terminals, closed ones or ones being closed", () => {
		const tracked = idleTerminal(501, 1_000)
		const leaving = idleTerminal(502, 1_000)
		sandbox.stub(TerminalRegistry, "getAllTerminals").returns([tracked])
		TerminalRegistry.queueTerminalForCleanup(leaving, "over-limit")
		const window = [
			tracked.terminal,
			{ name: CLINE_TERMINAL_NAME, exitStatus: undefined },
			{ name: CLINE_TERMINAL_NAME, exitStatus: { code: 0 } },
			{ name: "my own shell", exitStatus: undefined },
			Object.assign(leaving.terminal, { name: CLINE_TERMINAL_NAME, exitStatus: undefined }),
		] as unknown as vscode.Terminal[]

		assert.equal(TerminalRegistry.countOpenTerminals(window), 2)
	})
})

describe("TerminalRegistry orphan reclamation", () => {
	let sandbox: sinon.SinonSandbox
	const created: vscode.Terminal[] = []

	beforeEach(() => {
		sandbox = sinon.createSandbox()
	})

	afterEach(() => {
		// Restore before disposing: the tests stub `dispose` to observe it, and
		// a stubbed terminal is still open.
		sandbox.restore()
		for (const terminal of created.splice(0)) {
			terminal.dispose()
		}
	})

	// The half that stops them accumulating across *window* sessions: without
	// this VS Code revives them into the next window, where they are orphaned
	// before the extension host has even started.
	it("creates terminals that do not persist across window sessions", () => {
		const info = TerminalRegistry.createTerminal(undefined)
		created.push(info.terminal)
		TerminalRegistry.removeTerminal(info.id)

		const options = info.terminal.creationOptions as vscode.TerminalOptions
		assert.equal(options.isTransient, true)
	})

	// Asserted on the terminal itself rather than on the returned count: the
	// window is shared with every other test in this file, and disposal is not
	// synchronous, so a count is a statement about all of them.
	it("closes a Cerebriline terminal left by a previous extension host", () => {
		const orphan = vscode.window.createTerminal({
			name: CLINE_TERMINAL_NAME,
			env: { CLINE_ACTIVE: "true", CLINE_HOST_SESSION: "a-host-that-is-gone" },
		})
		created.push(orphan)
		const dispose = sandbox.stub(orphan, "dispose")

		TerminalRegistry.reclaimOrphanedTerminals()

		assert.equal(dispose.callCount, 1)
	})

	// Ownership is proven, not inferred. A terminal this host created carries
	// this host's stamp and is tracked, so it survives reclamation running while
	// it is open.
	it("leaves this host's own terminal alone", () => {
		const info = TerminalRegistry.createTerminal(undefined)
		created.push(info.terminal)
		const dispose = sandbox.stub(info.terminal, "dispose")

		TerminalRegistry.reclaimOrphanedTerminals()

		assert.equal(dispose.callCount, 0)
		TerminalRegistry.removeTerminal(info.id)
	})

	// The user's own shells are not Cerebriline's to close, and they carry neither the
	// name nor the stamp.
	it("leaves a terminal that is not Cerebriline's alone", () => {
		const mine = vscode.window.createTerminal({ name: "my own shell" })
		created.push(mine)
		const dispose = sandbox.stub(mine, "dispose")

		TerminalRegistry.reclaimOrphanedTerminals()

		assert.equal(dispose.callCount, 0)
	})
})

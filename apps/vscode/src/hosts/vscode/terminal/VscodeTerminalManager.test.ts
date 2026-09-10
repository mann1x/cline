import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as sinon from "sinon"
import * as vscode from "vscode"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { VscodeTerminalManager } from "./VscodeTerminalManager"
import { TerminalInfo, TerminalRegistry } from "./VscodeTerminalRegistry"

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
			// nothing to read: all it ever received was Cline's own `cd`.
			assert.equal(disposeStub.calledOnce, true)

			// And it is not disposed twice by the drain at the next acquisition.
			TerminalRegistry.disposeTerminalsPendingCleanup()
			assert.equal(disposeStub.calledOnce, true)
		} finally {
			terminal.terminal.dispose()
			TerminalRegistry.removeTerminal(terminal.id)
		}
	})

	// The other half of the same rule: a command Cline stopped being able to
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

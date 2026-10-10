import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StateManager } from "@/core/storage/StateManager"
import { ClineFileStorage } from "@/shared/storage/ClineFileStorage"
import { createStorageContext, type StorageContext } from "@/shared/storage/storage-context"

vi.mock("@/services/logging/distinctId", () => ({
	initializeDistinctId: vi.fn(async () => undefined),
	getDistinctId: () => "test",
}))

describe("StateManager with another window writing the shared state", () => {
	let clineDir: string
	let storage: StorageContext
	let stateManager: StateManager
	let otherWindow: ClineFileStorage
	let stop: () => void
	const synced = vi.fn()

	beforeEach(async () => {
		clineDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-manager-shared-"))
		storage = createStorageContext({ clineDir, workspacePath: clineDir })
		;(StateManager as unknown as { instance: StateManager | null }).instance = null
		await StateManager.initialize(storage)
		stateManager = StateManager.get()
		synced.mockClear()
		stateManager.registerCallbacks({ onSyncExternalChange: synced })
		stop = stateManager.watchExternalChanges()
		otherWindow = new ClineFileStorage(path.join(clineDir, "data", "globalState.json"))
	})

	afterEach(() => {
		stop()
		;(StateManager as unknown as { instance: StateManager | null }).instance = null
		fs.rmSync(clineDir, { recursive: true, force: true })
	})

	const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

	it("takes over a setting the other window changed and tells the view", async () => {
		expect(stateManager.getGlobalSettingsKey("messageHistoryLimit")).toBe(50)

		otherWindow.set("messageHistoryLimit", 7)
		storage.globalStateBackingStore.refreshFromDisk()
		await settle()

		expect(stateManager.getGlobalSettingsKey("messageHistoryLimit")).toBe(7)
		expect(synced).toHaveBeenCalledTimes(1)
	})

	it("keeps this window's unsaved change to the same setting", async () => {
		stateManager.setGlobalState("messageHistoryLimit", 20)

		otherWindow.set("messageHistoryLimit", 7)
		storage.globalStateBackingStore.refreshFromDisk()
		await settle()

		expect(stateManager.getGlobalSettingsKey("messageHistoryLimit")).toBe(20)
		await stateManager.flushPendingState()
		expect(new ClineFileStorage(path.join(clineDir, "data", "globalState.json")).get("messageHistoryLimit")).toBe(20)
	})

	it("does not write back over the other window's change to a different setting", async () => {
		otherWindow.set("messageHistoryLimit", 7)

		stateManager.setGlobalState("messageHistoryEnabled", false)
		await stateManager.flushPendingState()
		await settle()

		const onDisk = new ClineFileStorage(path.join(clineDir, "data", "globalState.json"))
		expect(onDisk.get("messageHistoryLimit")).toBe(7)
		expect(onDisk.get("messageHistoryEnabled")).toBe(false)
		expect(stateManager.getGlobalSettingsKey("messageHistoryLimit")).toBe(7)
	})

	it("leaves this window's mode and draft alone", async () => {
		stateManager.setGlobalState("mode", "act")
		await stateManager.flushPendingState()

		otherWindow.setBatch({ mode: "plan", messageDraft: "typed elsewhere" })
		storage.globalStateBackingStore.refreshFromDisk()
		await settle()

		expect(stateManager.getGlobalSettingsKey("mode")).toBe("act")
		expect(stateManager.getGlobalStateKey("messageDraft")).toBe("")
		expect(synced).not.toHaveBeenCalled()
	})
})

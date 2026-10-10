import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ConversationLocks, describeHeldConversation } from "./conversation-lock"

describe("ConversationLocks", () => {
	let dir: string
	let clock: number
	const alive = new Set<number>()

	const windowWith = (windowId: string, pid: number, extra: { host?: string; workspace?: string } = {}) => {
		alive.add(pid)
		const { workspace, ...rest } = extra
		return new ConversationLocks({
			getWorkspace: () => workspace,
			dir,
			windowId,
			pid,
			heartbeatMs: 0,
			staleMs: 60_000,
			now: () => clock,
			isProcessAlive: (candidate) => alive.has(candidate),
			...rest,
		})
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-locks-"))
		clock = Date.now()
		alive.clear()
	})

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true })
	})

	it("refuses a conversation another window has open, and names that window", () => {
		const first = windowWith("w1", 101, { workspace: "/work/alpha" })
		const second = windowWith("w2", 102)

		expect(first.tryAcquire("c1")).toBeUndefined()
		const holder = second.tryAcquire("c1")

		expect(holder).toMatchObject({ windowId: "w1", pid: 101 })
		expect(second.holderOf("c1")).toMatchObject({ windowId: "w1" })
		expect(first.holderOf("c1")).toBeUndefined()
		expect(holder && describeHeldConversation(holder)).toContain("(alpha)")
	})

	it("lets two windows hold different conversations", () => {
		const first = windowWith("w1", 101)
		const second = windowWith("w2", 102)

		expect(first.tryAcquire("c1")).toBeUndefined()
		expect(second.tryAcquire("c2")).toBeUndefined()
	})

	it("frees the conversation when the window lets it go", () => {
		const first = windowWith("w1", 101)
		const second = windowWith("w2", 102)
		first.tryAcquire("c1")

		first.release("c1")

		expect(second.tryAcquire("c1")).toBeUndefined()
		expect(first.tryAcquire("c1")).toMatchObject({ windowId: "w2" })
	})

	it("follows the set of conversations the window shows", () => {
		const first = windowWith("w1", 101)
		const second = windowWith("w2", 102)

		first.hold(["c1", "c2"])
		expect(second.holderOf("c1")).toBeDefined()
		expect(second.holderOf("c2")).toBeDefined()

		first.hold(["c2"])
		expect(second.holderOf("c1")).toBeUndefined()
		expect(second.holderOf("c2")).toBeDefined()

		first.dispose()
		expect(second.holderOf("c2")).toBeUndefined()
	})

	it("takes over a claim whose window is gone", () => {
		const first = windowWith("w1", 101)
		const second = windowWith("w2", 102)
		first.tryAcquire("c1")

		alive.delete(101)

		expect(second.tryAcquire("c1")).toBeUndefined()
	})

	it("does not mistake a reloaded window for the one before it", () => {
		const before = windowWith("w1-before-reload", 101)
		before.tryAcquire("c1")
		const after = windowWith("w1-after-reload", 101)

		expect(after.holderOf("c1")).toMatchObject({ windowId: "w1-before-reload" })
	})

	it("takes over a claim that stopped being refreshed, whatever its process id says", () => {
		const first = windowWith("w1", 101, { host: "other-machine" })
		const second = windowWith("w2", 102)
		first.tryAcquire("c1")

		clock += 30_000
		first.refresh()
		clock += 45_000
		expect(second.holderOf("c1")).toBeDefined()

		clock += 60_000
		expect(second.tryAcquire("c1")).toBeUndefined()
	})

	it("gives up a claim another window took over instead of fighting for it", () => {
		const first = windowWith("w1", 101)
		const second = windowWith("w2", 102)
		first.tryAcquire("c1")
		alive.delete(101)
		second.tryAcquire("c1")
		alive.add(101)

		first.refresh()
		first.release("c1")

		expect(second.holderOf("c1")).toBeUndefined()
		expect(first.holderOf("c1")).toMatchObject({ windowId: "w2" })
	})
})

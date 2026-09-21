import { beforeEach, describe, expect, it, vi } from "vitest"

const execa = vi.hoisted(() => vi.fn())
vi.mock("@packages/execa", () => ({ execa }))
vi.mock("@/shared/services/Logger", () => ({ Logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }))

import { getDocumentsPath, resetDocumentsPathCache } from "./documents-path"

describe("getDocumentsPath", () => {
	beforeEach(() => {
		execa.mockReset()
		// Every platform lookup here is a process spawn; resolve them all so the
		// test says the same thing on Windows, Linux and macOS.
		execa.mockResolvedValue({ stdout: "/home/t/Documents" })
		resetDocumentsPathCache()
	})

	it("spawns the platform lookup once and reuses the answer", async () => {
		// `getAllHooksDirs` calls this on every PreToolUse and PostToolUse, so
		// twice per tool call -- 274-296ms a side on Windows, where the lookup
		// is a PowerShell spawn. A user's Documents folder does not move while
		// the editor is running, so once per process is enough.
		const first = await getDocumentsPath()
		const spawnsAfterFirst = execa.mock.calls.length

		const second = await getDocumentsPath()

		expect(second).toBe(first)
		expect(execa.mock.calls.length).toBe(spawnsAfterFirst)
	})

	it("shares one in-flight resolution between concurrent callers", () => {
		// Identity, not call counting: concurrent callers must join the same
		// resolution rather than race to start their own spawn.
		expect(getDocumentsPath()).toBe(getDocumentsPath())
	})

	it("resolves again after the cache is dropped", async () => {
		await getDocumentsPath()
		const spawnsAfterFirst = execa.mock.calls.length

		resetDocumentsPathCache()
		await getDocumentsPath()

		expect(execa.mock.calls.length).toBeGreaterThan(spawnsAfterFirst)
	})
})

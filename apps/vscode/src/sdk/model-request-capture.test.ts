import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createModelRequestWriter } from "./model-request-capture"

const dirs: string[] = []
afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		await rm(dir, { recursive: true, force: true })
	}
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe("createModelRequestWriter", () => {
	it("writes one file per request in a folder per conversation, in send order", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "capture-"))
		dirs.push(dir)
		const write = createModelRequestWriter(dir)
		const at = "2026-10-16T06:10:34.600Z"
		write({ at, url: "http://pandorum:22434/api/chat", method: "POST", sessionId: "1792130372956_xm6e1", body: { n: 1 } })
		write({ at, url: "http://pandorum:22434/api/chat", method: "POST", sessionId: "1792130372956_xm6e1", body: { n: 2 } })
		write({ at, url: "http://x/api/chat", method: "POST", body: { n: 3 } })
		await settle()
		const files = (await readdir(path.join(dir, "1792130372956_xm6e1"))).sort()
		expect(files).toHaveLength(2)
		const first = JSON.parse(await readFile(path.join(dir, "1792130372956_xm6e1", files[0]), "utf8"))
		expect(first.body).toEqual({ n: 1 })
		expect(await readdir(path.join(dir, "no-session"))).toHaveLength(1)
	})

	it("turns a session id that is not a safe folder name into one", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "capture-"))
		dirs.push(dir)
		createModelRequestWriter(dir)({
			at: "2026-10-16T06:10:34.600Z",
			url: "http://x/api/chat",
			method: "POST",
			sessionId: "task/agent:1",
			body: {},
		})
		await settle()
		expect(await readdir(dir)).toEqual(["task_agent_1"])
	})
})

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ClineFileStorage } from "./ClineFileStorage"

describe("ClineFileStorage shared between two windows", () => {
	let dir: string
	let file: string

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-file-storage-"))
		file = path.join(dir, "globalState.json")
	})

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true })
	})

	const onDisk = () => JSON.parse(fs.readFileSync(file, "utf-8"))

	it("keeps another window's change when this window writes a different key", () => {
		fs.writeFileSync(file, JSON.stringify({ model: "a", mode: "act" }))
		const first = new ClineFileStorage(file)
		const second = new ClineFileStorage(file)

		first.set("model", "b")
		second.set("mode", "plan")

		expect(onDisk()).toEqual({ model: "b", mode: "plan" })
		expect(second.get("model")).toBe("b")
	})

	it("does not bring back a key another window deleted", () => {
		fs.writeFileSync(file, JSON.stringify({ draft: "hello", mode: "act" }))
		const first = new ClineFileStorage(file)
		const second = new ClineFileStorage(file)

		first.delete("draft")
		second.set("mode", "plan")

		expect(onDisk()).toEqual({ mode: "plan" })
	})

	it("reports the keys another window changed, and not its own", () => {
		fs.writeFileSync(file, JSON.stringify({ model: "a" }))
		const first = new ClineFileStorage(file)
		const second = new ClineFileStorage(file)
		const seen: string[][] = []
		second.onDidChangeExternally((keys) => seen.push([...keys]))

		first.setBatch({ model: "b", added: 1 })
		expect(second.refreshFromDisk()).toEqual(expect.arrayContaining(["model", "added"]))
		expect(second.get("model")).toBe("b")

		second.set("own", true)
		expect(second.refreshFromDisk()).toEqual([])
		expect(seen).toHaveLength(1)
	})

	it("reports a change found while writing, except for the keys being written", () => {
		fs.writeFileSync(file, JSON.stringify({ model: "a", mode: "act" }))
		const first = new ClineFileStorage(file)
		const second = new ClineFileStorage(file)
		const seen: string[] = []
		second.onDidChangeExternally((keys) => seen.push(...keys))

		first.setBatch({ model: "b", mode: "plan" })
		second.set("mode", "act")

		expect(seen).toEqual(["model"])
		expect(onDisk()).toEqual({ model: "b", mode: "act" })
	})

	it("does not empty the file when it cannot be parsed", () => {
		fs.writeFileSync(file, JSON.stringify({ model: "a" }))
		const store = new ClineFileStorage(file)
		fs.writeFileSync(file, "{ not json")

		store.set("mode", "plan")

		expect(onDisk()).toEqual({ model: "a", mode: "plan" })
	})

	it("takes over a lock left behind by a dead process", () => {
		const store = new ClineFileStorage(file)
		fs.writeFileSync(`${file}.lock`, "")
		const old = new Date(Date.now() - 60_000)
		fs.utimesSync(`${file}.lock`, old, old)

		store.set("mode", "plan")

		expect(onDisk()).toEqual({ mode: "plan" })
		expect(fs.existsSync(`${file}.lock`)).toBe(false)
	})
})

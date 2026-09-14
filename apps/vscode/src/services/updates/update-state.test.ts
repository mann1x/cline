import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { readUpdateState, updateStatePath, writeUpdateState } from "./update-state"

async function storage(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "cerebriline-updates-"))
}

describe("the updater's own state", () => {
	it("is empty on a fresh install", async () => {
		expect(await readUpdateState(await storage())).toEqual({})
	})

	it("survives a round trip", async () => {
		const root = await storage()
		await writeUpdateState(root, { lastCheckedAt: 1_700_000_000_000, skippedVersion: "4.100.115" })

		expect(await readUpdateState(root)).toEqual({
			lastCheckedAt: 1_700_000_000_000,
			skippedVersion: "4.100.115",
		})
	})

	it("reads an unparseable file as nothing known", async () => {
		// A disk that filled mid-write leaves half a JSON object. Throwing here
		// would run on the activation path, so it cannot throw.
		const root = await storage()
		await fs.mkdir(path.dirname(updateStatePath(root)), { recursive: true })
		await fs.writeFile(updateStatePath(root), '{"lastCheckedAt":17000', "utf8")

		expect(await readUpdateState(root)).toEqual({})
	})

	it("ignores fields of the wrong type rather than trusting them", async () => {
		const root = await storage()
		await fs.mkdir(path.dirname(updateStatePath(root)), { recursive: true })
		await fs.writeFile(updateStatePath(root), '{"lastCheckedAt":"soon","skippedVersion":7}', "utf8")

		expect(await readUpdateState(root)).toEqual({})
	})

	it("does not throw when the storage path cannot be written", async () => {
		// A regular file standing where the directory should be: mkdir fails
		// with ENOTDIR. This runs on the activation path, so it must swallow it.
		const root = await storage()
		const blocked = path.join(root, "blocked")
		await fs.writeFile(blocked, "not a directory", "utf8")

		await expect(writeUpdateState(blocked, { lastCheckedAt: 1 })).resolves.toBeUndefined()
	})
})

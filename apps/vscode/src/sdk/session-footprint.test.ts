import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { measureSessionDir } from "./session-footprint"

describe("measureSessionDir", () => {
	const dirs: string[] = []
	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true })
		}
	})
	const tempDir = () => {
		const dir = mkdtempSync(path.join(tmpdir(), "footprint-"))
		dirs.push(dir)
		return dir
	}

	it("splits a session's bytes by what wrote them", async () => {
		const dir = tempDir()
		writeFileSync(path.join(dir, "s1.messages.json"), "x".repeat(100))
		writeFileSync(path.join(dir, "s1.json"), "x".repeat(20))
		writeFileSync(path.join(dir, "agent_1_abc.messages.json"), "x".repeat(300))
		writeFileSync(path.join(dir, "agent_2_def.messages.json"), "x".repeat(50))
		const overlay = path.join(dir, "agent-overlays", "call_1", "src")
		mkdirSync(overlay, { recursive: true })
		writeFileSync(path.join(overlay, "main.ts"), "x".repeat(1000))
		// A file named like a transcript inside an overlay is the agent's copy of
		// a workspace file, not a transcript.
		writeFileSync(path.join(overlay, "agent_x.messages.json"), "x".repeat(7))

		expect(await measureSessionDir(dir)).toEqual({
			totalBytes: 1477,
			sessionBytes: 120,
			agentTranscriptBytes: 350,
			overlayBytes: 1007,
		})
	})

	// An overlay can hold a symlink copied up from the workspace. Following it
	// would count its target -- which may be the whole workspace -- as the
	// session's own bytes.
	it.skipIf(process.platform === "win32")("counts a symlink, never what it points to", async () => {
		const dir = tempDir()
		const outside = tempDir()
		writeFileSync(path.join(outside, "big.bin"), "x".repeat(50_000))
		const overlay = path.join(dir, "agent-overlays", "call_1")
		mkdirSync(overlay, { recursive: true })
		symlinkSync(path.join(outside, "big.bin"), path.join(overlay, "link"))

		const footprint = await measureSessionDir(dir)
		expect(footprint?.overlayBytes).toBeLessThan(1_000)
	})

	it("is undefined for a session that has no directory", async () => {
		expect(await measureSessionDir(path.join(tempDir(), "missing"))).toBeUndefined()
	})
})

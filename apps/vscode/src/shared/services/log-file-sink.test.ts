import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createLogFileSink } from "./log-file-sink"

/**
 * The point of the sink is that the log can be read while the window is still
 * running, so what these cover is timing: written without a reload, without a
 * flush call, and without waiting for a buffer to fill.
 */
describe("createLogFileSink", () => {
	let directory: string

	beforeEach(async () => {
		directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cline-log-sink-"))
	})

	afterEach(async () => {
		await fs.promises.rm(directory, { recursive: true, force: true })
	})

	function read(name = "extension.log"): Promise<string> {
		return fs.promises.readFile(path.join(directory, name), "utf8")
	}

	async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			if (await predicate()) {
				return
			}
			await new Promise((resolve) => setTimeout(resolve, 5))
		}
		throw new Error("timed out waiting for the sink")
	}

	it("writes on its own once logging goes idle", async () => {
		const sink = createLogFileSink({ directory, idleMs: 10 })
		sink.write("first")
		sink.write("second")

		// No flush() call: this is the reload the sink exists to avoid.
		await waitFor(async () => fs.existsSync(path.join(directory, "extension.log")))
		await waitFor(async () => (await read()).includes("second"))
		expect(await read()).toBe("first\nsecond\n")

		await sink.dispose()
	})

	it("writes a stream that never goes idle", async () => {
		// A run that logs continuously would otherwise reset the idle timer
		// forever and never reach disk — the case the deadline is for.
		const sink = createLogFileSink({ directory, idleMs: 1000, maxLatencyMs: 20 })
		const stop = Date.now() + 200
		const interval = setInterval(() => {
			if (Date.now() < stop) {
				sink.write("busy")
			}
		}, 5)

		try {
			await waitFor(async () => fs.existsSync(path.join(directory, "extension.log")))
			expect(await read()).toContain("busy")
		} finally {
			clearInterval(interval)
			await sink.dispose()
		}
	})

	it("keeps the order of lines across flushes", async () => {
		const sink = createLogFileSink({ directory, idleMs: 5 })
		for (let index = 0; index < 50; index += 1) {
			sink.write(`line ${index}`)
			// Flushing on every line is the worst case for the append chain.
			void sink.flush()
		}
		await sink.dispose()

		const lines = (await read()).trimEnd().split("\n")
		expect(lines).toHaveLength(50)
		expect(lines[0]).toBe("line 0")
		expect(lines[49]).toBe("line 49")
	})

	it("rotates instead of growing without limit", async () => {
		const sink = createLogFileSink({ directory, idleMs: 5, maxBytes: 64 })
		sink.write("x".repeat(200))
		await sink.flush()
		sink.write("after rotation")
		await sink.flush()

		expect(await read("extension.log.1")).toContain("x")
		expect(await read()).toBe("after rotation\n")

		await sink.dispose()
	})

	it("swallows a directory it cannot write", async () => {
		// A logger that throws takes down whatever was being logged.
		const sink = createLogFileSink({
			directory: path.join(directory, "file-in-the-way", "logs"),
			idleMs: 5,
		})
		await fs.promises.writeFile(path.join(directory, "file-in-the-way"), "not a directory")

		sink.write("dropped")
		await expect(sink.flush()).resolves.toBeUndefined()
		await sink.dispose()
	})

	it("flushes what is buffered when disposed", async () => {
		const sink = createLogFileSink({ directory, idleMs: 60_000 })
		sink.write("teardown")
		await sink.dispose()

		expect(await read()).toBe("teardown\n")
	})
})

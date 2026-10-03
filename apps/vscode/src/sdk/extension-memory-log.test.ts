import { describe, expect, it } from "vitest"
import { formatMemoryLine } from "./extension-memory-log"

describe("formatMemoryLine", () => {
	it("gives the host's memory in whole megabytes, with what Cerebriline is running", () => {
		const MB = 1024 * 1024
		expect(
			formatMemoryLine(
				{ rss: 1585 * MB, heapUsed: 412.4 * MB, heapTotal: 520 * MB, external: 96 * MB, arrayBuffers: 12 * MB },
				2573.6,
				3,
			),
		).toBe(
			"[memory] rss=1585MB heapUsed=412MB heapTotal=520MB external=96MB arrayBuffers=12MB agents=3 uptime=2574s (extension host, shared by all extensions)",
		)
	})
})

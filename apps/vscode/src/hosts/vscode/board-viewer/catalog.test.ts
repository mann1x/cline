import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { viewerCatalog } from "./catalog"

/** What the step form completes from (owner, 2026-11-27: "how do you know the tool to read files is read_files?"). */

let root: string | undefined
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true })
	root = undefined
})

describe("the step form's catalog", () => {
	it("lists the conversation's tools a pipeline calls, the workspace's agents and the expression functions", () => {
		root = mkdtempSync(join(tmpdir(), "viewer-catalog-"))
		mkdirSync(join(root, ".cline", "agents"), { recursive: true })
		writeFileSync(
			join(root, ".cline", "agents", "reviewer.md"),
			"---\nname: reviewer\ndescription: Reviews a change\n---\nYou review code.\n",
		)
		const catalog = viewerCatalog(root, 1)
		expect(catalog.tools).toContain("read_files")
		expect(catalog.tools).not.toContain("spawn_agent")
		expect(catalog.agents).toContain("reviewer")
		expect(catalog.functions).toEqual(expect.arrayContaining(["len", "join", "default"]))
	})
})

import { describe, expect, it } from "vitest"
import {
	createListFilesTool,
	type DirectoryEntry,
	isWithin,
	normalizeMaxResults,
	renderDirectory,
	renderMatches,
	type WorkspaceLister,
} from "./list-files-tool"

const ROOT = process.platform === "win32" ? "C:\\repo" : "/repo"
const join = (...parts: string[]) => parts.join(process.platform === "win32" ? "\\" : "/")

function lister(overrides: Partial<WorkspaceLister> = {}): WorkspaceLister {
	return {
		roots: () => [ROOT],
		readDirectory: async () => [],
		findFiles: async () => [],
		...overrides,
	}
}

async function run(input: unknown, overrides: Partial<WorkspaceLister> = {}) {
	const tool = createListFilesTool({ cwd: ROOT, createLister: () => lister(overrides) })
	return (await tool.execute(input, {} as never)) as {
		query: string
		result: string
		error?: string
		success: boolean
	}
}

describe("isWithin", () => {
	it("accepts the root itself and anything under it", () => {
		expect(isWithin(ROOT, ROOT)).toBe(true)
		expect(isWithin(ROOT, join(ROOT, "src", "app.ts"))).toBe(true)
	})

	it("rejects a sibling whose name merely starts the same way", () => {
		// The bug a plain prefix check has: `/repo-other` is not inside `/repo`.
		expect(isWithin(ROOT, `${ROOT}-other`)).toBe(false)
	})

	it("rejects a parent and an unrelated path", () => {
		expect(isWithin(join(ROOT, "src"), ROOT)).toBe(false)
		expect(isWithin(ROOT, process.platform === "win32" ? "D:\\elsewhere" : "/elsewhere")).toBe(false)
	})
})

describe("normalizeMaxResults", () => {
	it("falls back for anything that is not a usable number", () => {
		expect(normalizeMaxResults(undefined)).toBe(200)
		expect(normalizeMaxResults("40")).toBe(200)
		expect(normalizeMaxResults(0)).toBe(200)
		expect(normalizeMaxResults(-5)).toBe(200)
		expect(normalizeMaxResults(Number.NaN)).toBe(200)
	})

	it("honours a sensible request and caps an unreasonable one", () => {
		expect(normalizeMaxResults(40)).toBe(40)
		expect(normalizeMaxResults(99_999)).toBe(1000)
	})
})

describe("renderDirectory", () => {
	const entries: DirectoryEntry[] = [
		{ name: "readme.md", kind: "file", size: 2048 },
		{ name: "src", kind: "directory" },
		{ name: "app.ts", kind: "file", size: 120 },
		{ name: "assets", kind: "directory" },
	]

	it("puts directories first and marks them", () => {
		const lines = renderDirectory(ROOT, entries, 10).split("\n")
		expect(lines[1]).toBe("  assets/")
		expect(lines[2]).toBe("  src/")
	})

	it("gives each file a size, so reading it whole can be judged", () => {
		expect(renderDirectory(ROOT, entries, 10)).toContain("  readme.md  2 KB")
		expect(renderDirectory(ROOT, entries, 10)).toContain("  app.ts  120 B")
	})

	it("says how many were held back when it truncates", () => {
		const report = renderDirectory(ROOT, entries, 2)
		expect(report).toContain("4 entries, first 2 shown")
	})

	it("says so plainly when there is nothing there", () => {
		expect(renderDirectory(ROOT, [], 10)).toBe(`${ROOT} is empty.`)
	})
})

describe("renderMatches", () => {
	it("reports paths relative to the root they were found under", () => {
		const report = renderMatches("**/*.ts", [join(ROOT, "src", "app.ts")], [ROOT], 10)
		expect(report).toContain(join("src", "app.ts"))
		expect(report).not.toContain(ROOT)
	})

	it("treats no matches as an answer rather than a failure", () => {
		// The distinction that stops a retry loop: a search that found nothing
		// will find nothing again. It now says so by naming the ground it
		// covered, which is both the same claim and a checkable one.
		const report = renderMatches("**/*.rs", [], [ROOT], 10)
		expect(report).toContain("Re-running it will not change that")
		expect(report).toContain(ROOT)
	})

	it("names files read outside the workspace instead of denying they exist", () => {
		// Measured: a file under `repos/test` edited successfully from a
		// workspace of `repos/osync`, then four consecutive searches reporting
		// that no such file existed. The model had just edited it, so it did the
		// only sensible thing with an answer it knew to be false — it asked
		// again. Reading and editing are not scoped to the workspace; only the
		// search is, and it has to say so.
		const outside = join("c:", "elsewhere", "manic_miner.html")
		const report = renderMatches("manic*", [], [ROOT], 10, [outside])

		expect(report).toContain(outside)
		expect(report).toContain("read_files")
	})

	it("does not volunteer unrelated files it has read", () => {
		// The note answers the search that was made. A model looking for one
		// thing does not need the rest of its reading listed back at it.
		const outside = join("c:", "elsewhere", "notes.md")
		const report = renderMatches("manic*", [], [ROOT], 10, [outside])

		expect(report).not.toContain(outside)
	})

	it("says nothing extra when everything read is inside the workspace", () => {
		const report = renderMatches("**/*.rs", [], [ROOT], 10, [join(ROOT, "src", "app.ts")])

		expect(report).not.toContain("outside it")
	})
})

describe("list_files", () => {
	it("lists the workspace root when given nothing", async () => {
		const result = await run({}, { readDirectory: async () => [{ name: "src", kind: "directory" } as DirectoryEntry] })

		expect(result.success).toBe(true)
		expect(result.query).toBe("list:.")
		expect(result.result).toContain("  src/")
	})

	it("refuses a path outside the workspace and names what is allowed", async () => {
		// The whole reason this exists rather than `dir /s`: the boundary is
		// enforced here, not requested in a prompt.
		const outside = process.platform === "win32" ? "D:\\elsewhere" : "/elsewhere"
		const result = await run({ path: outside })

		expect(result.success).toBe(false)
		expect(result.error).toContain("outside this workspace")
		expect(result.error).toContain(ROOT)
	})

	it("resolves a relative path against the workspace root", async () => {
		let asked = ""
		const result = await run(
			{ path: "src" },
			{
				readDirectory: async (absolutePath) => {
					asked = absolutePath
					return []
				},
			},
		)

		expect(asked).toBe(join(ROOT, "src"))
		expect(result.success).toBe(true)
	})

	it("searches a glob instead of listing when given a pattern", async () => {
		let asked = ""
		const result = await run(
			{ path: "ignored", pattern: "**/*.html" },
			{
				findFiles: async (pattern) => {
					asked = pattern
					return [join(ROOT, "game.html")]
				},
			},
		)

		expect(asked).toBe("**/*.html")
		expect(result.query).toBe("find:**/*.html")
		expect(result.result).toContain("game.html")
	})

	it("reports a host failure as a failed operation rather than throwing", async () => {
		const result = await run(
			{ path: "src" },
			{
				readDirectory: async () => {
					throw new Error("EACCES")
				},
			},
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain("EACCES")
	})
})

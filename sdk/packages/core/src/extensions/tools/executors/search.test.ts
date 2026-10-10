import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { MAX_SEARCH_OUTPUT_CHARS } from "./output-limits";
import { createSearchExecutor } from "./search";

const ctx: AgentToolContext = {
	agentId: "agent-1",
	conversationId: "conv-1",
	iteration: 1,
};

describe("createSearchExecutor", () => {
	it("middle-truncates oversized search output with recovery guidance", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-search-"));
		const filePath = path.join(dir, "large.ts");
		// Many matching lines so the joined output exceeds the cap even though
		// each line stays under the per-line truncation limit.
		const rows = Array.from(
			{ length: 200 },
			(_, i) => `needle ${"x".repeat(380)} row-${i}`,
		);
		await fs.writeFile(filePath, rows.join("\n"), "utf-8");

		try {
			// A line of context either side: three lines a match, each under
			// the cut a long line gets, so it is the count that overflows.
			const search = createSearchExecutor({ contextLines: 1 });
			// Lookahead is unsupported by ripgrep, forcing the fallback scan.
			const result = await search("(?=needle)", dir, ctx);

			expect(result.length).toBeGreaterThan(MAX_SEARCH_OUTPUT_CHARS);
			expect(result.length).toBeLessThanOrEqual(50_000);
			expect(result).toContain("Found 100 results for pattern");
			expect(result).toContain("search output truncated");
			expect(result).toContain("Narrow the pattern or scope");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	// Pandorum, 2026-10-10: one search of a scraped site's minified script
	// returned 49,782 characters, the match not among them.
	it("shows a long matching line around its match", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-search-"));
		await fs.writeFile(
			path.join(dir, "min.js"),
			`${"a=1;".repeat(20_000)}{question:"Why?"}${"b=2;".repeat(20_000)}`,
			"utf-8",
		);
		try {
			const search = createSearchExecutor();
			const result = await search("question", dir, ctx);
			expect(result).toContain('{question:"Why?"}');
			expect(result).toContain("a line of 160,017 characters");
			expect(result.length).toBeLessThan(1500);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps the lines before a match with that match's file", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-search-"));
		await fs.writeFile(path.join(dir, "a.js"), "needle one\n", "utf-8");
		await fs.writeFile(
			path.join(dir, "b.js"),
			"lead-in of b\nneedle two\n",
			"utf-8",
		);
		try {
			const search = createSearchExecutor();
			const result = await search("needle", dir, ctx);
			const blocks = result.split("\n\n");
			const ofA = blocks.find((block) => block.includes("a.js:1:1")) ?? "";
			const ofB = blocks.find((block) => block.includes("b.js:2:1")) ?? "";
			expect(ofA).toContain("> 1: needle one");
			expect(ofA).not.toContain("lead-in of b");
			expect(ofB).toContain("  1: lead-in of b\n> 2: needle two");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("returns bounded output when a match lands in a giant single-line file", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-search-"));
		// Simulates a serialized trace dump. Buffering ripgrep's --json events
		// for such files unbounded previously crashed the host process once
		// accumulated stdout passed the engine's max string length.
		await fs.writeFile(
			path.join(dir, "trace.json"),
			`{"trace": "${"x".repeat(20 * 1024 * 1024)}"}`,
			"utf-8",
		);
		await fs.writeFile(
			path.join(dir, "small.ts"),
			"const trace = 1;\n",
			"utf-8",
		);

		try {
			const search = createSearchExecutor();
			const result = await search("trace", dir, ctx);

			expect(result.length).toBeLessThanOrEqual(50_000);
			expect(result).toContain("small.ts");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditorExecutor } from "./editor";
import { createFileReadExecutor } from "./file-read";
import { createReadReceipts } from "./read-receipts";

const ctx = { agentId: "a", conversationId: "c", iteration: 1 } as never;

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "csf-editor-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/** A file read through `read_files`, and an editor sharing its receipts. */
async function opened(name: string, text: string) {
	const file = join(dir, name);
	await fs.writeFile(file, text, "utf8");
	const receipts = createReadReceipts();
	const read = createFileReadExecutor({ receipts, cwd: dir });
	const shown = String(await read({ path: name }, ctx));
	const editor = createEditorExecutor({ receipts });
	const edit = (input: Record<string, unknown>) =>
		editor({ path: file, ...input } as never, dir, ctx);
	return { file, shown, edit };
}

// csf-5: columns count UTF-16 units, and a cut between the two halves of an
// emoji wrote a lone surrogate on each side: "ab😀cd" with column 3 replaced
// by "X" became "abX�cd".
describe("csf-5: a column edit never splits a character", () => {
	it("refuses a range that ends inside a two-unit character", async () => {
		const { file, edit } = await opened("e.txt", "ab😀cd\n");
		await expect(
			edit({ start_line: 1, start_column: 3, end_column: 3, new_text: "X" }),
		).rejects.toThrow(/falls inside "😀".*Use 2 or 4/);
		expect(await fs.readFile(file, "utf8")).toBe("ab😀cd\n");
	});

	it("refuses an insert between the two halves", async () => {
		const { file, edit } = await opened("e.txt", "ab😀cd\n");
		await expect(
			edit({ insert_line: 1, insert_column: 4, new_text: "X" }),
		).rejects.toThrow(/falls inside "😀"/);
		expect(await fs.readFile(file, "utf8")).toBe("ab😀cd\n");
	});

	it("replaces the whole character when the range covers it", async () => {
		const { file, edit } = await opened("e.txt", "ab😀cd\n");
		await edit({
			start_line: 1,
			start_column: 3,
			end_column: 4,
			new_text: "X",
		});
		expect(await fs.readFile(file, "utf8")).toBe("abXcd\n");
	});
});

describe("a multi-line column insert takes the file's line ending", () => {
	it("writes CRLF into a CRLF file", async () => {
		const { file, edit } = await opened("c.txt", "ab\r\ncd\r\n");
		await edit({ insert_line: 1, insert_column: 2, new_text: "X\nY" });
		expect(await fs.readFile(file, "utf8")).toBe("aX\r\nYb\r\ncd\r\n");
	});
});

// csf-16: read_files cuts a line at 2,000 characters but receipted the whole
// line, so an edit past the cut landed on characters the model never saw.
describe("csf-16: an edit cannot reach past where a read cut the line", () => {
	const long = `${"a".repeat(2_300)}TAIL${"b".repeat(100)}\nshort\n`;

	it("refuses a column edit past the cut", async () => {
		const { file, shown, edit } = await opened("m.js", long);
		expect(shown).toContain("[line truncated]");
		await expect(
			edit({
				start_line: 1,
				start_column: 2_301,
				end_column: 2_304,
				new_text: "X",
			}),
		).rejects.toThrow(/showed you only the first 2,000/);
		expect(await fs.readFile(file, "utf8")).toBe(long);
	});

	it("refuses replacing the whole cut line", async () => {
		const { file, edit } = await opened("m.js", long);
		await expect(
			edit({ start_line: 1, end_line: 1, new_text: "x" }),
		).rejects.toThrow(/reaches the whole line/);
		expect(await fs.readFile(file, "utf8")).toBe(long);
	});

	it("refuses rewriting the whole file over a cut line", async () => {
		const { file, edit } = await opened("m.js", long);
		await expect(edit({ new_text: "x\n" })).rejects.toThrow(
			/showed you only the first 2,000/,
		);
		expect(await fs.readFile(file, "utf8")).toBe(long);
	});

	it("allows a column edit inside the part shown", async () => {
		const { file, edit } = await opened("m.js", long);
		await edit({
			start_line: 1,
			start_column: 1,
			end_column: 1,
			new_text: "Z",
		});
		expect((await fs.readFile(file, "utf8")).startsWith("Za")).toBe(true);
	});

	it("allows an old_text edit of text past the cut", async () => {
		const { file, edit } = await opened("m.js", long);
		await edit({ old_text: "TAIL", new_text: "HEAD" });
		expect(await fs.readFile(file, "utf8")).toContain("aHEADb");
	});
});

// csf-20: an empty file captured no lines, so its read recorded no receipt
// and every edit of it was refused as unread however often it was read.
describe("csf-20: an empty file that was read can be edited", () => {
	it("inserts at line 1", async () => {
		const { file, edit } = await opened("empty.js", "");
		await edit({ insert_line: 1, new_text: "const a = 1;\n" });
		expect(await fs.readFile(file, "utf8")).toBe("const a = 1;\n");
	});

	it("is written whole from new_text", async () => {
		const { file, edit } = await opened("empty.js", "");
		await edit({ new_text: "const a = 1;\n" });
		// The whole-file replace keeps the file's trailing-newline state, and
		// an empty file has none; what matters here is that it was not refused.
		expect(await fs.readFile(file, "utf8")).toBe("const a = 1;");
	});
});

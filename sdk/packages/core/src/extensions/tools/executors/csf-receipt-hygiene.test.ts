import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApplyPatchExecutor } from "./apply-patch";
import { createEditorExecutor } from "./editor";
import { createGrepExecutor } from "./grep";
import { createReadReceipts, readFileStamp } from "./read-receipts";

const ctx = { agentId: "a", conversationId: "c", iteration: 1 } as never;

function updatePatch(file: string, ...body: string[]): string {
	return [
		"*** Begin Patch",
		`*** Update File: ${file}`,
		"@@",
		...body,
		"*** End Patch",
	].join("\n");
}

function addPatch(file: string, ...lines: string[]): string {
	return [
		"*** Begin Patch",
		`*** Add File: ${file}`,
		...lines.map((line) => `+${line}`),
		"*** End Patch",
	].join("\n");
}

function movePatch(file: string, destination: string, ...body: string[]) {
	return [
		"*** Begin Patch",
		`*** Update File: ${file}`,
		`*** Move to: ${destination}`,
		"@@",
		...body,
		"*** End Patch",
	].join("\n");
}

// A file the tools create takes the platform's line ending, so on Windows it
// is CRLF. These tests are about whether an edit is refused, not about EOLs.
async function readLf(file: string): Promise<string> {
	return (await fs.readFile(file, "utf8")).replace(/\r\n/g, "\n");
}

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "csf-receipts-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

// csf-1: grep credited a full-file read and stamped the file without ever
// asking whether it had moved since the session last saw it. After an
// outside write, the next editor call passed requireCurrent against content
// nobody in this session had looked at.
describe("csf-1: grep does not launder an outside write", () => {
	it("does not credit a read of a file that changed since it was read", async () => {
		const file = join(dir, "sample.txt");
		await fs.writeFile(file, "a\nb\nc\n", "utf8");
		const receipts = createReadReceipts();
		receipts.noteRead(file, 1, 3);
		receipts.noteStamp(file, await readFileStamp(file));
		// Something outside the session rewrites the file.
		await fs.writeFile(file, "a\nOUTSIDE\nc\nd\n", "utf8");

		const grep = createGrepExecutor({ cwd: dir, receipts });
		const output = await grep({ pattern: "c", paths: ["sample.txt"] });

		expect(output).toContain("changed since you last read it");
		// The stale read is retired: an edit aimed at lines grep showed must
		// not pass the read-before-edit guard on the strength of it.
		expect(receipts.hasEverRead(file)).toBe(false);
	});

	it("still credits the read when nothing has moved", async () => {
		const file = join(dir, "sample.txt");
		await fs.writeFile(file, "a\nb\nc\n", "utf8");
		const receipts = createReadReceipts();
		receipts.noteRead(file, 1, 3);
		receipts.noteStamp(file, await readFileStamp(file));

		const grep = createGrepExecutor({ cwd: dir, receipts });
		const output = await grep({ pattern: "b", paths: ["sample.txt"] });

		expect(output).toContain("sample.txt:2:b");
		expect(output).not.toContain("changed since you last read it");
		expect(receipts.hasEverRead(file)).toBe(true);
	});
});

// csf-2: apply_patch computed its UPDATE against the file as it stood, and
// wrote the result without ever asking whether the file had moved since the
// session last read it — the same outside-write laundering grep did, but
// with a write attached.
describe("csf-2: apply_patch UPDATE vs an outside write", () => {
	it("refuses the patch and changes nothing", async () => {
		const file = join(dir, "game.js");
		await fs.writeFile(file, "a\nb\nc\n", "utf8");
		const receipts = createReadReceipts();
		receipts.noteRead(file, 1, 3);
		receipts.noteStamp(file, await readFileStamp(file));
		// Outside write that still satisfies the patch's context lines.
		await fs.writeFile(file, "a\nb\nc\nd\n", "utf8");

		const ap = createApplyPatchExecutor({ receipts });
		await expect(
			ap({ input: updatePatch("game.js", " b", "+X", " c") }, dir, ctx),
		).rejects.toThrow(/changed since you last read it/);
		expect(await fs.readFile(file, "utf8")).toBe("a\nb\nc\nd\n");
	});

	it("applies when the file is what the session last saw", async () => {
		const file = join(dir, "game.js");
		await fs.writeFile(file, "a\nb\nc\n", "utf8");
		const receipts = createReadReceipts();
		receipts.noteRead(file, 1, 3);
		receipts.noteStamp(file, await readFileStamp(file));

		const ap = createApplyPatchExecutor({ receipts });
		const result = await ap(
			{ input: updatePatch("game.js", " b", "+X", " c") },
			dir,
			ctx,
		);
		expect(result).toContain("Successfully applied patch");
		expect(await fs.readFile(file, "utf8")).toContain("X");
	});
});

// csf-7 (and its MOVE twin): apply_patch ADD wrote the file and recorded the
// stamp, but no read receipt — so the very next editor call on a file the
// model had just authored was refused with "has not been read in this
// session".
describe("csf-7: a file a patch creates or moves has been read", () => {
	it("a created file can be edited without a refused read", async () => {
		const receipts = createReadReceipts();
		const ap = createApplyPatchExecutor({ receipts });
		const editor = createEditorExecutor({ receipts });
		const made = join(dir, "made.js");

		await ap({ input: addPatch("made.js", "one", "two") }, dir, ctx);

		expect(receipts.hasEverRead(made)).toBe(true);
		await editor(
			{ path: made, start_line: 2, end_line: 2, new_text: "TWO" } as never,
			dir,
			ctx,
		);
		// The patch body carried no trailing newline, so the file has none.
		expect(await readLf(made)).toBe("one\nTWO");
	});

	it("a moved file's destination can be edited without a refused read", async () => {
		const source = join(dir, "src.txt");
		await fs.writeFile(source, "x\ny\n", "utf8");
		const receipts = createReadReceipts();
		receipts.noteRead(source, 1, 2);
		receipts.noteStamp(source, await readFileStamp(source));
		const ap = createApplyPatchExecutor({ receipts });
		const editor = createEditorExecutor({ receipts });
		const destination = join(dir, "dst.txt");

		await ap(
			{ input: movePatch("src.txt", "dst.txt", " x", "-y", "+Y") },
			dir,
			ctx,
		);

		expect(receipts.hasEverRead(destination)).toBe(true);
		await editor(
			{
				path: destination,
				start_line: 2,
				end_line: 2,
				new_text: "WHY",
			} as never,
			dir,
			ctx,
		);
		expect(await fs.readFile(destination, "utf8")).toBe("x\nWHY\n");
	});
});

// csf-8: a move onto a file the model had read kept that file's read spans.
// The destination now held the source's lines, so with the same line count
// the old spans licensed edits on lines the model never saw.
describe("csf-8: a move onto a read file carries the source's reads, not the destination's", () => {
	it("refuses an edit of moved-in lines the model never read", async () => {
		const source = join(dir, "src.txt");
		const destination = join(dir, "dst.txt");
		await fs.writeFile(source, "s1\ns2\n", "utf8");
		await fs.writeFile(destination, "d1\nd2\n", "utf8");
		const receipts = createReadReceipts();
		// The model read the destination, never the source.
		receipts.noteRead(destination, 1, 2);
		receipts.noteStamp(destination, await readFileStamp(destination));
		const ap = createApplyPatchExecutor({ receipts });
		const editor = createEditorExecutor({ receipts });

		await ap(
			{ input: movePatch("src.txt", "dst.txt", " s1", "-s2", "+S2") },
			dir,
			ctx,
		);

		await expect(
			editor(
				{
					path: destination,
					start_line: 1,
					end_line: 1,
					new_text: "x",
				} as never,
				dir,
				ctx,
			),
		).rejects.toThrow(/has not been read/);
		expect(await fs.readFile(destination, "utf8")).toBe("s1\nS2\n");
	});

	it("credits nothing when only part of the source was read", async () => {
		const source = join(dir, "src.txt");
		await fs.writeFile(source, "a\nb\nc\nd\n", "utf8");
		const receipts = createReadReceipts();
		receipts.noteRead(source, 1, 2);
		receipts.noteStamp(source, await readFileStamp(source));
		const ap = createApplyPatchExecutor({ receipts });

		await ap(
			{ input: movePatch("src.txt", "dst.txt", " a", "-b", "+B") },
			dir,
			ctx,
		);

		expect(receipts.hasEverRead(join(dir, "dst.txt"))).toBe(false);
	});
});

describe("csf-2: apply_patch refuses before it writes anything", () => {
	it("refuses a move whose source changed outside the session", async () => {
		const source = join(dir, "src.txt");
		await fs.writeFile(source, "a\nb\nc\n", "utf8");
		const receipts = createReadReceipts();
		receipts.noteRead(source, 1, 3);
		receipts.noteStamp(source, await readFileStamp(source));
		await fs.writeFile(source, "a\nb\nc\nd\n", "utf8");

		const ap = createApplyPatchExecutor({ receipts });
		await expect(
			ap(
				{ input: movePatch("src.txt", "dst.txt", " b", "+X", " c") },
				dir,
				ctx,
			),
		).rejects.toThrow(/changed since you last read it/);
		await expect(fs.stat(join(dir, "dst.txt"))).rejects.toThrow();
		expect(await fs.readFile(source, "utf8")).toBe("a\nb\nc\nd\n");
	});

	it("leaves every file as it was when a later file in the patch is stale", async () => {
		const first = join(dir, "one.js");
		const second = join(dir, "two.js");
		await fs.writeFile(first, "a\nb\n", "utf8");
		await fs.writeFile(second, "c\nd\n", "utf8");
		const receipts = createReadReceipts();
		for (const file of [first, second]) {
			receipts.noteRead(file, 1, 2);
			receipts.noteStamp(file, await readFileStamp(file));
		}
		await fs.writeFile(second, "c\nd\ne\n", "utf8");

		const ap = createApplyPatchExecutor({ receipts });
		const patch = [
			"*** Begin Patch",
			"*** Update File: one.js",
			"@@",
			" a",
			"-b",
			"+B",
			"*** Update File: two.js",
			"@@",
			" c",
			"-d",
			"+D",
			"*** End Patch",
		].join("\n");
		await expect(ap({ input: patch }, dir, ctx)).rejects.toThrow(
			/two\.js changed since you last read it/,
		);
		expect(await fs.readFile(first, "utf8")).toBe("a\nb\n");
	});
});

// csf-9: the editor's create path recorded a read but no stamp, so
// changedSince had nothing to compare against and an outside write to a file
// this session created was invisible to requireCurrent.
describe("csf-9: a file the editor creates carries a stamp", () => {
	it("an outside write to a created file is caught by requireCurrent", async () => {
		const receipts = createReadReceipts();
		const editor = createEditorExecutor({ receipts });
		const file = join(dir, "made.txt");

		await editor({ path: file, new_text: "one\ntwo\n" } as never, dir, ctx);
		// Something outside the session rewrites the created file.
		await fs.writeFile(file, "one\nTAMPERED\n", "utf8");

		await expect(
			editor(
				{ path: file, start_line: 2, end_line: 2, new_text: "x" } as never,
				dir,
				ctx,
			),
		).rejects.toThrow(/changed since you last read it/);
		expect(await fs.readFile(file, "utf8")).toBe("one\nTAMPERED\n");
	});

	it("the session's own follow-up edit is not refused", async () => {
		const receipts = createReadReceipts();
		const editor = createEditorExecutor({ receipts });
		const file = join(dir, "made.txt");

		await editor({ path: file, new_text: "one\ntwo\n" } as never, dir, ctx);
		await editor(
			{ path: file, start_line: 2, end_line: 2, new_text: "TWO" } as never,
			dir,
			ctx,
		);
		expect(await readLf(file)).toBe("one\nTWO\n");
	});
});

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeDelimiterBalance } from "../delimiter-balance";
import { BOM } from "./bom";
import { createGrepExecutor } from "./grep";
import { createDefaultExecutors } from "./index";
import { createReadReceipts } from "./read-receipts";
import { createSedExecutor } from "./sed";

const ctx = { agentId: "a", conversationId: "c", iteration: 1 } as never;

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function workspace(content: string) {
	const dir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "bom-")),
	);
	dirs.push(dir);
	const file = path.join(dir, "game.js");
	await fs.writeFile(file, content, "utf8");
	return { dir, file, executors: createDefaultExecutors() };
}

/**
 * A file saved with a byte-order mark starts with U+FEFF. VS Code and the
 * language servers leave it out of line 1's columns; the tools counted it,
 * so every column on line 1 was one past where the editor put it, and an
 * edit at the column a diagnostic named landed one character early.
 */
describe("a file that starts with a byte-order mark", () => {
	it("is read without it", async () => {
		const { file, executors } = await workspace(`${BOM}ab(c\nd\n`);
		const shown = String(await executors.readFile?.({ path: file }, ctx));

		expect(shown).not.toContain(BOM);
		expect(shown).toContain("ab(c");
	});

	it("takes line 1's columns as the editor numbers them, and keeps it", async () => {
		const { dir, file, executors } = await workspace(`${BOM}ab(c\nd\n`);
		await executors.readFile?.({ path: file }, ctx);

		await executors.editor?.(
			{ path: file, start_line: 1, start_column: 3, new_text: "" } as never,
			dir,
			ctx,
		);

		expect(await fs.readFile(file, "utf8")).toBe(`${BOM}abc\nd\n`);
	});

	it("keeps it first through a whole-line replace and an insert at line 1", async () => {
		const { dir, file, executors } = await workspace(`${BOM}a\nb\n`);
		await executors.readFile?.({ path: file }, ctx);

		await executors.editor?.(
			{ path: file, start_line: 1, end_line: 1, new_text: "A" } as never,
			dir,
			ctx,
		);
		await executors.readFile?.({ path: file }, ctx);
		await executors.editor?.(
			{ path: file, insert_line: 1, new_text: "top\n" } as never,
			dir,
			ctx,
		);
		await executors.readFile?.({ path: file }, ctx);
		await executors.editor?.(
			{ path: file, insert_line: 1, insert_column: 1, new_text: "(" } as never,
			dir,
			ctx,
		);

		expect(await fs.readFile(file, "utf8")).toBe(`${BOM}(top\nA\nb\n`);
	});

	it("matches a patch's context on line 1, and keeps it", async () => {
		const { dir, file, executors } = await workspace(`${BOM}a\nb\n`);
		await executors.readFile?.({ path: file }, ctx);

		await executors.applyPatch?.(
			{
				input: [
					"*** Begin Patch",
					"*** Update File: game.js",
					"@@",
					"-a",
					"+A",
					" b",
					"*** End Patch",
				].join("\n"),
			},
			dir,
			ctx,
		);

		expect(await fs.readFile(file, "utf8")).toBe(`${BOM}A\nb\n`);
	});

	it("is not counted in the delimiter scan's columns", () => {
		const scan = describeDelimiterBalance("game.js", `${BOM}a();)`);

		expect(scan).toContain("column 5");
		expect(scan).not.toContain("column 6");
	});

	it("is not shown by grep", async () => {
		const { dir } = await workspace(`${BOM}alpha\n`);
		const grep = createGrepExecutor({
			cwd: dir,
			receipts: createReadReceipts(),
		});

		const output = String(await grep({ pattern: "alpha", paths: ["game.js"] }));

		expect(output).toContain("game.js:1:alpha");
		expect(output).not.toContain(BOM);
	});

	it("survives sed -i", async () => {
		const { dir, file } = await workspace(`${BOM}alpha\n`);
		const receipts = createReadReceipts();
		receipts.noteRead(file, 1, Number.POSITIVE_INFINITY);
		const sed = createSedExecutor({ cwd: dir, receipts });

		const [outcome] = await sed({
			script: "1s/^a/A/",
			files: [file],
			in_place: true,
		});

		expect(outcome.ok).toBe(true);
		expect(await fs.readFile(file, "utf8")).toBe(`${BOM}Alpha\n`);
	});
});

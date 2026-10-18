import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditorExecutor } from "./editor";
import { createFileReadExecutor } from "./file-read";
import { createGrepExecutor } from "./grep";
import { createReadReceipts } from "./read-receipts";

const ctx = { agentId: "a", conversationId: "c", iteration: 1 } as never;

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "grep-cut-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

// A 1,206-character line with its match at column 601: grep prints
// characters 468-867 of it.
const line = `${"a".repeat(600)}NEEDLE${"b".repeat(600)}`;
const text = `short\n${line}\nend\n`;

async function workspace() {
	const file = join(dir, "game.js");
	await fs.writeFile(file, text, "utf8");
	const receipts = createReadReceipts();
	const grep = createGrepExecutor({ cwd: dir, receipts });
	const read = createFileReadExecutor({ receipts, cwd: dir });
	const editor = createEditorExecutor({ receipts });
	const edit = (input: Record<string, unknown>) =>
		editor({ path: file, ...input } as never, dir, ctx);
	return {
		file,
		grep: (pattern: string) => grep({ pattern, paths: ["game.js"] }),
		read: () => read({ path: "game.js" }, ctx),
		edit,
	};
}

// grep credits the whole file as read (csf-12, by design), but a line it cut
// to a 400-character window was credited whole too: an edit at column 1,200
// landed 333 characters past anything the model was shown.
describe("an edit cannot reach past where grep cut the line", () => {
	it("refuses a column edit past the window", async () => {
		const { file, grep, edit } = await workspace();
		expect(await grep("NEEDLE")).toContain("characters 468-867 shown");
		await expect(
			edit({
				start_line: 2,
				start_column: 1_200,
				end_column: 1_200,
				new_text: "X",
			}),
		).rejects.toThrow(/showed you only characters 468-867/);
		expect(await fs.readFile(file, "utf8")).toBe(text);
	});

	it("refuses a column edit before the window", async () => {
		const { file, grep, edit } = await workspace();
		await grep("NEEDLE");
		await expect(
			edit({ start_line: 2, start_column: 10, end_column: 10, new_text: "X" }),
		).rejects.toThrow(/starts at column 10, before what you have seen/);
		expect(await fs.readFile(file, "utf8")).toBe(text);
	});

	it("refuses replacing the whole line", async () => {
		const { grep, edit } = await workspace();
		await grep("NEEDLE");
		await expect(
			edit({ start_line: 2, end_line: 2, new_text: "x" }),
		).rejects.toThrow(/reaches the whole line/);
	});

	it("allows a column edit inside the window", async () => {
		const { file, grep, edit } = await workspace();
		await grep("NEEDLE");
		await edit({
			start_line: 2,
			start_column: 601,
			end_column: 606,
			new_text: "PIN",
		});
		expect(await fs.readFile(file, "utf8")).toContain("aPINb");
	});

	it("allows an old_text edit", async () => {
		const { file, grep, edit } = await workspace();
		await grep("NEEDLE");
		await edit({ old_text: "NEEDLE", new_text: "PIN" });
		expect(await fs.readFile(file, "utf8")).toContain("aPINb");
	});

	it("does not cut a line read_files showed whole before", async () => {
		const { file, read, grep, edit } = await workspace();
		await read();
		await grep("NEEDLE");
		await edit({
			start_line: 2,
			start_column: 1_200,
			end_column: 1_200,
			new_text: "X",
		});
		expect((await fs.readFile(file, "utf8")).split("\n")[1]?.[1_199]).toBe("X");
	});

	it("is lifted by read_files showing the line whole", async () => {
		const { grep, read, edit } = await workspace();
		await grep("NEEDLE");
		await read();
		await edit({ start_line: 2, end_line: 2, new_text: "whole" });
	});

	it("moves the window with an edit before it", async () => {
		const { grep, edit } = await workspace();
		await grep("NEEDLE");
		// Ten characters out of the window's start pull it ten columns back.
		await edit({
			start_line: 2,
			start_column: 468,
			end_column: 477,
			new_text: "",
		});
		await edit({
			start_line: 2,
			start_column: 857,
			end_column: 857,
			new_text: "X",
		});
		await expect(
			edit({
				start_line: 2,
				start_column: 858,
				end_column: 858,
				new_text: "X",
			}),
		).rejects.toThrow(/showed you only characters 468-857/);
	});

	it("leaves a line grep printed whole alone", async () => {
		const { grep, edit } = await workspace();
		await grep("short");
		await edit({ start_line: 1, end_line: 1, new_text: "long" });
	});
});

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createReadFilesTool } from "../../extensions/tools/definitions";
import { createFileReadExecutor } from "../../extensions/tools/executors/file-read";
import { createReadReceipts } from "../../extensions/tools/executors/read-receipts";
import type { ToolOperationResult } from "../../extensions/tools/types";
import { withBaseRevisionReads } from "./base-revision-reads";
import { type Snapshot, takeSnapshot } from "./snapshot";

const context = {} as never;

/**
 * Call a decorated tool with a shape its declared input type predates.
 *
 * The decoration widens what `read_files` accepts — a `revision` alongside
 * everything it took before — while keeping the tool's declared type, so a
 * host's existing call sites are unaffected. These tests exercise the wider
 * runtime contract, which is the one the model actually calls through.
 */
async function call(
	tool: { execute: (input: never, context: never) => unknown },
	input: unknown,
): Promise<ToolOperationResult[]> {
	return (await (tool.execute as (i: unknown, c: unknown) => unknown)(
		input,
		context,
	)) as ToolOperationResult[];
}

async function withWorkspace(
	files: Record<string, string>,
	run: (root: string) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-baseread-"));
	try {
		for (const [name, body] of Object.entries(files)) {
			await fs.writeFile(path.join(root, name), body, "utf8");
		}
		await run(await fs.realpath(root));
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

function readTool(receipts = createReadReceipts(), cwd?: string) {
	return createReadFilesTool(createFileReadExecutor({ receipts, cwd }));
}

describe("reading the version this transaction started from", () => {
	it("shows the base, while the file on disk is the one that changed", async () => {
		await withWorkspace({ "game.html": "original\n" }, async (root) => {
			const snapshot: Snapshot = await takeSnapshot(root);
			await fs.writeFile(path.join(root, "game.html"), "wrecked\n", "utf8");
			const [tool] = withBaseRevisionReads(
				[readTool(createReadReceipts(), root)],
				{ pending: snapshot, transaction: 1 },
			);

			const results = await call(tool, {
				files: [{ path: "game.html" }],
				revision: "base",
			});

			expect(results[0]?.success).toBe(true);
			expect(results[0]?.result).toContain("original");
			expect(results[0]?.result).not.toContain("wrecked");
			// Labelled, so it is never mistaken for the file as it stands.
			expect(results[0]?.result).toContain("not the file as it stands");
		});
	});

	it("does not count as having read the file it is a revision of", async () => {
		// The guard between a line rebuilt from memory and the file on disk:
		// the base revision's line numbers are the ones from before the edits,
		// so crediting this read would let the model edit lines it never saw.
		await withWorkspace({ "game.html": "a\nb\nc\n" }, async (root) => {
			const snapshot = await takeSnapshot(root);
			const receipts = createReadReceipts();
			const [tool] = withBaseRevisionReads([readTool(receipts, root)], {
				pending: snapshot,
				transaction: 1,
			});

			await call(tool, { files: [{ path: "game.html" }], revision: "base" });

			expect(receipts.paths()).toEqual([]);
		});
	});

	it("reads the working file, and records it, when no revision is asked for", async () => {
		await withWorkspace({ "game.html": "original\n" }, async (root) => {
			const snapshot = await takeSnapshot(root);
			await fs.writeFile(path.join(root, "game.html"), "wrecked\n", "utf8");
			const receipts = createReadReceipts();
			const [tool] = withBaseRevisionReads([readTool(receipts, root)], {
				pending: snapshot,
				transaction: 1,
			});

			const results = await call(tool, { files: [{ path: "game.html" }] });

			expect(results[0]?.result).toContain("wrecked");
			expect(receipts.paths()).toHaveLength(1);
		});
	});

	it("treats any other revision as the working tree rather than refusing it", async () => {
		// A model that writes `revision: "current"` wants the file, not a lecture.
		await withWorkspace({ "game.html": "original\n" }, async (root) => {
			const snapshot = await takeSnapshot(root);
			await fs.writeFile(path.join(root, "game.html"), "wrecked\n", "utf8");
			const [tool] = withBaseRevisionReads(
				[readTool(createReadReceipts(), root)],
				{ pending: snapshot, transaction: 1 },
			);

			const results = await call(tool, {
				files: [{ path: "game.html" }],
				revision: "current",
			});

			expect(results[0]?.result).toContain("wrecked");
		});
	});

	it("honours a line range on the base exactly as it does on the file", async () => {
		await withWorkspace({ "game.html": "a\nb\nc\nd\n" }, async (root) => {
			const snapshot = await takeSnapshot(root);
			await fs.writeFile(path.join(root, "game.html"), "gone\n", "utf8");
			const [tool] = withBaseRevisionReads(
				[readTool(createReadReceipts(), root)],
				{ pending: snapshot, transaction: 1 },
			);

			const results = await call(tool, {
				files: [{ path: "game.html", start_line: 2, end_line: 3 }],
				revision: "base",
			});

			expect(results[0]?.result).toContain("2 | b");
			expect(results[0]?.result).toContain("3 | c");
			expect(results[0]?.result).not.toContain("| a");
		});
	});

	it("takes the revision on the single-file shape as well as the list", async () => {
		await withWorkspace({ "game.html": "original\n" }, async (root) => {
			const snapshot = await takeSnapshot(root);
			await fs.writeFile(path.join(root, "game.html"), "wrecked\n", "utf8");
			const [tool] = withBaseRevisionReads(
				[readTool(createReadReceipts(), root)],
				{ pending: snapshot, transaction: 1 },
			);

			const results = await call(tool, { path: "game.html", revision: "base" });

			expect(results[0]?.result).toContain("original");
		});
	});

	it("passes the shapes that cannot carry a revision straight through", async () => {
		// `read_files` accepts a bare path and a bare array. Neither has anywhere
		// to put a revision, and neither must be mangled on the way past.
		await withWorkspace({ "game.html": "on disk\n" }, async (root) => {
			const snapshot = await takeSnapshot(root);
			const [tool] = withBaseRevisionReads(
				[readTool(createReadReceipts(), root)],
				{ pending: snapshot, transaction: 1 },
			);

			const fromString = await call(tool, "game.html");
			const fromArray = await call(tool, ["game.html"]);

			expect(fromString[0]?.result).toContain("on disk");
			expect(fromArray[0]?.result).toContain("on disk");
		});
	});

	it("says there is nothing to show when no transaction is open", async () => {
		const [tool] = withBaseRevisionReads([readTool()], {
			pending: undefined,
			transaction: 0,
		});

		const results = await call(tool, {
			files: [{ path: "game.html" }],
			revision: "base",
		});

		expect(results[0]?.success).toBe(false);
		expect(results[0]?.error).toContain("No transaction is open");
	});
});

describe("what a host without the protocol sees", () => {
	it("leaves every other tool untouched", async () => {
		const other = readTool();
		const decorated = withBaseRevisionReads(
			[{ ...other, name: "search_codebase" }],
			{ pending: undefined, transaction: 0 },
		);

		expect(decorated[0]?.name).toBe("search_codebase");
		expect(decorated[0]?.inputSchema).toBe(other.inputSchema);
	});

	it("only advertises a revision on the decorated tool", () => {
		// The gate the whole design turns on: without an open transaction there
		// is no base revision, and a schema that offers one anyway teaches a
		// call that can only ever be refused.
		const plain = readTool();
		const [decorated] = withBaseRevisionReads([plain], {
			pending: undefined,
			transaction: 0,
		});

		expect(
			(plain.inputSchema.properties as Record<string, unknown>).revision,
		).toBeUndefined();
		expect(
			(decorated.inputSchema.properties as Record<string, unknown>).revision,
		).toBeDefined();
		expect(decorated.description).toContain('revision: "base"');
	});
});

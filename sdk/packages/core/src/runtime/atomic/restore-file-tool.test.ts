import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createRestoreFileTool,
	MAX_RESTORES_PER_TRANSACTION,
} from "./restore-file-tool";
import { type Snapshot, takeSnapshot } from "./snapshot";

const context = {} as never;

async function withWorkspace(
	files: Record<string, string>,
	run: (root: string) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-restore-"));
	try {
		for (const [name, body] of Object.entries(files)) {
			await fs.writeFile(path.join(root, name), body, "utf8");
		}
		await run(await fs.realpath(root));
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

class FakeController {
	pending: Snapshot | undefined;
	transaction = 1;
}

describe("putting one file back", () => {
	let controller: FakeController;

	beforeEach(() => {
		controller = new FakeController();
	});

	it("restores the file and leaves the transaction's other work alone", async () => {
		await withWorkspace(
			{ "game.html": "line one\nline two\n", "other.js": "kept" },
			async (root) => {
				controller.pending = await takeSnapshot(root);
				await fs.writeFile(path.join(root, "game.html"), "wrecked", "utf8");
				await fs.writeFile(path.join(root, "other.js"), "also edited", "utf8");

				const tool = createRestoreFileTool({ controller });
				const said = await tool.execute({ path: "game.html" }, context);

				await expect(
					fs.readFile(path.join(root, "game.html"), "utf8"),
				).resolves.toBe("line one\nline two\n");
				// The point of a per-file restore: the rest of the transaction
				// survives it. A whole-transaction rollback would take this too.
				await expect(
					fs.readFile(path.join(root, "other.js"), "utf8"),
				).resolves.toBe("also edited");
				expect(said).toContain("back as it was");
			},
		);
	});

	it("counts the file's lines the way read_files does", async () => {
		// The model reads these two numbers side by side. A trailing newline
		// ends the last line rather than starting an empty one, and a restore
		// that called a three-line file four lines would send it looking for a
		// line that is not there.
		await withWorkspace({ "game.html": "a\nb\nc\n" }, async (root) => {
			controller.pending = await takeSnapshot(root);
			await fs.writeFile(path.join(root, "game.html"), "wrecked\n", "utf8");

			const tool = createRestoreFileTool({ controller });
			const said = await tool.execute({ path: "game.html" }, context);

			expect(said).toContain("3 lines");
			expect(said).toContain("2 lines fewer");
		});
	});

	it("tells the model its line numbers have moved", async () => {
		// The whole file was rewritten, so every read taken before this one
		// describes code that is no longer at those numbers.
		await withWorkspace({ "game.html": "a\nb\nc\n" }, async (root) => {
			controller.pending = await takeSnapshot(root);
			await fs.writeFile(path.join(root, "game.html"), "a\n", "utf8");

			const tool = createRestoreFileTool({ controller });
			const said = await tool.execute({ path: "game.html" }, context);

			expect(said).toContain("read the file again");
		});
	});

	it("retires the reads for the file it put back", async () => {
		// Without this the editor's read-before-edit guard accepts an edit aimed
		// at a line number that no longer holds what the model read there.
		await withWorkspace({ "game.html": "a\nb\n" }, async (root) => {
			controller.pending = await takeSnapshot(root);
			await fs.writeFile(path.join(root, "game.html"), "wrecked", "utf8");
			const forgetReads = vi.fn();

			const tool = createRestoreFileTool({ controller, forgetReads });
			await tool.execute({ path: "game.html" }, context);

			expect(forgetReads).toHaveBeenCalledWith(path.join(root, "game.html"));
		});
	});

	it("deletes a file the transaction created, because that is what it was", async () => {
		await withWorkspace({}, async (root) => {
			controller.pending = await takeSnapshot(root);
			await fs.writeFile(path.join(root, "scratch.js"), "invented", "utf8");

			const tool = createRestoreFileTool({ controller });
			const said = await tool.execute({ path: "scratch.js" }, context);

			await expect(fs.stat(path.join(root, "scratch.js"))).rejects.toThrow();
			expect(said).toContain("did not exist");
		});
	});

	it("does not spend the budget on a path that never existed", async () => {
		await withWorkspace({}, async (root) => {
			controller.pending = await takeSnapshot(root);

			const tool = createRestoreFileTool({ controller });
			const said = await tool.execute({ path: "typo.js" }, context);

			expect(said).toContain("does not exist and did not exist");
			// Still has its full budget: nothing was undone.
			await fs.writeFile(path.join(root, "made.js"), "invented", "utf8");
			for (let i = 0; i < MAX_RESTORES_PER_TRANSACTION; i += 1) {
				await fs.writeFile(path.join(root, "made.js"), `try ${i}`, "utf8");
				expect(await tool.execute({ path: "made.js" }, context)).not.toContain(
					"no more will be made",
				);
			}
		});
	});

	it("refuses a file that already matches the base, and says what that means", async () => {
		// Not thrash — a model that has lost track of what it changed. Being
		// told the file is already the original is the answer it was after.
		await withWorkspace({ "game.html": "original" }, async (root) => {
			controller.pending = await takeSnapshot(root);

			const tool = createRestoreFileTool({ controller });
			const said = await tool.execute({ path: "game.html" }, context);

			expect(said).toContain("already exactly as it was");
			expect(said).toContain("wrong before you touched it");
		});
	});

	it("counts a repeated no-op back to the model rather than answering it the same way twice", async () => {
		await withWorkspace({ "game.html": "original" }, async (root) => {
			controller.pending = await takeSnapshot(root);
			const tool = createRestoreFileTool({ controller });

			await tool.execute({ path: "game.html" }, context);
			const second = await tool.execute({ path: "game.html" }, context);

			expect(second).toContain("2 times");
		});
	});

	it("stops after its budget, because undoing repeatedly is the loop and not the fix", async () => {
		await withWorkspace({ "game.html": "original" }, async (root) => {
			controller.pending = await takeSnapshot(root);
			const tool = createRestoreFileTool({ controller });

			for (let i = 0; i < MAX_RESTORES_PER_TRANSACTION; i += 1) {
				await fs.writeFile(path.join(root, "game.html"), `try ${i}`, "utf8");
				await tool.execute({ path: "game.html" }, context);
			}
			await fs.writeFile(path.join(root, "game.html"), "again", "utf8");
			const said = await tool.execute({ path: "game.html" }, context);

			expect(said).toContain("no more will be made");
			// Refused, not silently ignored: the file still holds the model's mess.
			await expect(
				fs.readFile(path.join(root, "game.html"), "utf8"),
			).resolves.toBe("again");
		});
	});

	it("gives a new transaction a fresh budget", async () => {
		// A model that recovered in TX-01 should not open TX-02 a strike down,
		// exactly as the empty-attempt budget resets on a transaction with work.
		await withWorkspace({ "game.html": "original" }, async (root) => {
			controller.pending = await takeSnapshot(root);
			const tool = createRestoreFileTool({ controller });
			for (let i = 0; i < MAX_RESTORES_PER_TRANSACTION; i += 1) {
				await fs.writeFile(path.join(root, "game.html"), `try ${i}`, "utf8");
				await tool.execute({ path: "game.html" }, context);
			}

			controller.transaction = 2;
			controller.pending = await takeSnapshot(root);
			await fs.writeFile(path.join(root, "game.html"), "new mess", "utf8");
			const said = await tool.execute({ path: "game.html" }, context);

			expect(said).toContain("back as it was");
		});
	});

	it("says so plainly when no transaction is open", async () => {
		const tool = createRestoreFileTool({ controller });

		await expect(
			tool.execute({ path: "game.html" }, context),
		).resolves.toContain("No transaction is open");
	});

	it("will not restore a path the transaction never covered", async () => {
		await withWorkspace({ "game.html": "original" }, async (root) => {
			controller.pending = await takeSnapshot(root);

			const tool = createRestoreFileTool({ controller });
			const said = await tool.execute(
				{ path: path.join(root, "..", "outside.js") },
				context,
			);

			expect(said).toContain("outside the directory");
		});
	});
});

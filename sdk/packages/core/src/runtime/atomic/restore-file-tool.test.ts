import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createRestoreFileTool,
	MAX_NOOP_RESTORES_PER_TRANSACTION,
	MAX_RESTORES_PER_TRANSACTION,
	RESTORE_HABIT_AFTER,
	RESTORE_HABIT_INSISTS_AFTER,
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

	it("stops answering a no-op that keeps being asked, and says why the edits are not landing", async () => {
		// Measured on pandorum session 1789117848964_zhbk5: 108 restore calls in
		// one transaction, 102 of them no-ops against a cap of 9 that was
		// therefore never reached. A no-op changes nothing on disk, so it never
		// spent the budget and never refused -- it was free, and the friendly
		// reply is what kept the loop fed.
		await withWorkspace({ "game.html": "original" }, async (root) => {
			controller.pending = await takeSnapshot(root);
			const tool = createRestoreFileTool({ controller });

			for (let i = 0; i < MAX_NOOP_RESTORES_PER_TRANSACTION; i += 1) {
				expect(await tool.execute({ path: "game.html" }, context)).toContain(
					"already exactly as it was",
				);
			}
			const said = await tool.execute({ path: "game.html" }, context);

			expect(said).toContain("will not answer again");
			// The diagnosis, not just the refusal: the file being untouched is
			// evidence about the model's edits, and naming it is the whole value.
			expect(said).toContain("your edits are not landing");
			// Never an invitation to stop — that was the failure mode of the
			// empty-transaction message this replaces the shape of.
			expect(said).not.toContain("say so");
		});
	});

	it("does not spend the no-op budget on restores that actually did something", async () => {
		await withWorkspace({ "game.html": "original" }, async (root) => {
			controller.pending = await takeSnapshot(root);
			const tool = createRestoreFileTool({ controller });

			for (let i = 0; i < MAX_NOOP_RESTORES_PER_TRANSACTION + 2; i += 1) {
				await fs.writeFile(path.join(root, "game.html"), `mess ${i}`, "utf8");
				expect(await tool.execute({ path: "game.html" }, context)).toContain(
					"back as it was",
				);
			}
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

describe("what a run of restores is told it means", () => {
	// 13.6 restores per run on the JackOD4-AC 9B arm against 0.23 on qwen3.6
	// 27B, and within the arm near-monotonic with wall time: the three runs that
	// restored nothing were the three fastest successes, the three highest
	// counts were the three timeouts. The sentence is aimed at the reading
	// behind the edits, not at the restoring, which is the part that is working.
	async function restoring(
		run: (
			restore: () => Promise<string>,
			reopen: () => Promise<void>,
		) => Promise<void>,
	): Promise<void> {
		await withWorkspace(
			{ "game.html": "line one\nline two\n" },
			async (root) => {
				const controller = new FakeController();
				controller.pending = await takeSnapshot(root);
				const tool = createRestoreFileTool({ controller });
				let wrecks = 0;
				const restore = async () => {
					wrecks += 1;
					await fs.writeFile(
						path.join(root, "game.html"),
						`wrecked ${wrecks}`,
						"utf8",
					);
					return String(await tool.execute({ path: "game.html" }, context));
				};
				const reopen = async () => {
					controller.transaction += 1;
					controller.pending = await takeSnapshot(root);
				};
				await run(restore, reopen);
			},
		);
	}

	it("says nothing about the habit for the first two", async () => {
		await restoring(async (restore) => {
			expect(RESTORE_HABIT_AFTER).toBe(3);
			expect(await restore()).not.toContain("changes undone");
			expect(await restore()).not.toContain("changes undone");
		});
	});

	it("names it from the third", async () => {
		await restoring(async (restore) => {
			await restore();
			await restore();
			const third = await restore();

			expect(third).toContain("3 changes undone");
			expect(third).toContain("the reading behind it is wrong");
			// The half these runs behaved as though they did not know.
			expect(third).toContain("put back in full");
		});
	});

	it("stops nudging and answers from the sixth", async () => {
		await restoring(async (restore) => {
			let said = "";
			for (let call = 0; call < RESTORE_HABIT_INSISTS_AFTER; call += 1) {
				said = await restore();
			}

			expect(said).toContain("no longer recovery");
			expect(said).toContain("end the transaction");
			expect(said).not.toContain("the reading behind it is wrong");
		});
	});

	// `spentIn` and `noOps` are separate counters and must stay that way: a
	// model asking about a file it never changed has lost track of what it
	// changed, which the no-op budget answers. It is not a run of undone work.
	it("does not count a restore that undid nothing", async () => {
		await withWorkspace({ "game.html": "line one\n" }, async (root) => {
			const controller = new FakeController();
			controller.pending = await takeSnapshot(root);
			const tool = createRestoreFileTool({ controller });

			await fs.writeFile(path.join(root, "game.html"), "wrecked", "utf8");
			await tool.execute({ path: "game.html" }, context);
			// Two no-ops: the file already matches the base.
			await tool.execute({ path: "game.html" }, context);
			await tool.execute({ path: "game.html" }, context);

			await fs.writeFile(path.join(root, "game.html"), "wrecked again", "utf8");
			const second = String(await tool.execute({ path: "game.html" }, context));

			expect(second).not.toContain("changes undone");
		});
	});

	// A model that recovered in TX-01 does not begin TX-02 already two strikes
	// down, exactly as the restore budget itself is reset by a new transaction.
	it("starts again in the next transaction", async () => {
		await restoring(async (restore, reopen) => {
			await restore();
			await restore();
			await reopen();

			expect(await restore()).not.toContain("changes undone");
			expect(await restore()).not.toContain("changes undone");
			expect(await restore()).toContain("3 changes undone");
		});
	});
});

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { restoreSnapshot, snapshotIsClean, takeSnapshot } from "./snapshot";

async function withWorkspace(
	files: Record<string, string>,
	run: (root: string) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-snapshot-"));
	try {
		for (const [name, body] of Object.entries(files)) {
			const full = path.join(root, name);
			await fs.mkdir(path.dirname(full), { recursive: true });
			await fs.writeFile(full, body, "utf8");
		}
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("the undo a transaction is built on", () => {
	it("puts an edited file back exactly as it was", async () => {
		await withWorkspace({ "game.html": "original" }, async (root) => {
			const snapshot = await takeSnapshot(root);

			await fs.writeFile(path.join(root, "game.html"), "edited", "utf8");
			const report = await restoreSnapshot(snapshot);

			expect(report.restored).toEqual([path.join(root, "game.html")]);
			await expect(
				fs.readFile(path.join(root, "game.html"), "utf8"),
			).resolves.toBe("original");
		});
	});

	// Measured: a model deleted the file under test twelve times in one
	// transaction to get a clean slate for a whole-file write, and the twelfth
	// deletion outlived the transaction.
	it("brings back a file the transaction deleted", async () => {
		await withWorkspace({ "game.html": "original" }, async (root) => {
			const snapshot = await takeSnapshot(root);

			await fs.rm(path.join(root, "game.html"));
			const report = await restoreSnapshot(snapshot);

			expect(report.recreated).toEqual([path.join(root, "game.html")]);
			await expect(
				fs.readFile(path.join(root, "game.html"), "utf8"),
			).resolves.toBe("original");
		});
	});

	it("removes a file the transaction created", async () => {
		await withWorkspace({ "game.html": "original" }, async (root) => {
			const snapshot = await takeSnapshot(root);

			await fs.writeFile(path.join(root, "scratch.js"), "junk", "utf8");
			const report = await restoreSnapshot(snapshot);

			expect(report.removed).toEqual([path.join(root, "scratch.js")]);
			await expect(fs.access(path.join(root, "scratch.js"))).rejects.toThrow();
		});
	});

	it("leaves a file nothing touched alone", async () => {
		await withWorkspace(
			{ "game.html": "original", "notes.md": "keep" },
			async (root) => {
				const snapshot = await takeSnapshot(root);

				await fs.writeFile(path.join(root, "game.html"), "edited", "utf8");
				const report = await restoreSnapshot(snapshot);

				expect(report.restored).not.toContain(path.join(root, "notes.md"));
			},
		);
	});

	it("restores files in nested directories", async () => {
		await withWorkspace({ "src/deep/app.ts": "before" }, async (root) => {
			const snapshot = await takeSnapshot(root);

			await fs.writeFile(path.join(root, "src/deep/app.ts"), "after", "utf8");
			await restoreSnapshot(snapshot);

			await expect(
				fs.readFile(path.join(root, "src/deep/app.ts"), "utf8"),
			).resolves.toBe("before");
		});
	});

	// A snapshot that walks node_modules on a real project reads hundreds of
	// thousands of files, and the protocol costs more than the change it guards.
	it("does not descend into node_modules or .git", async () => {
		await withWorkspace(
			{
				"app.ts": "code",
				"node_modules/left-pad/index.js": "junk",
				".git/HEAD": "ref: refs/heads/main",
			},
			async (root) => {
				const snapshot = await takeSnapshot(root);

				expect([...snapshot.files.keys()]).toEqual([path.join(root, "app.ts")]);
			},
		);
	});

	// Degrade to "some files are not covered, and it says so" rather than to
	// reading a 400 MB asset directory into memory.
	it("names what it could not hold instead of holding it", async () => {
		await withWorkspace({ "big.bin": "x".repeat(4096) }, async (root) => {
			const snapshot = await takeSnapshot(root, { maxFileBytes: 128 });

			expect(snapshot.files.size).toBe(0);
			expect(snapshot.skipped).toEqual([path.join(root, "big.bin")]);
		});
	});

	it("reports a tree that still matches the snapshot", async () => {
		await withWorkspace({ "game.html": "original" }, async (root) => {
			const snapshot = await takeSnapshot(root);

			await expect(snapshotIsClean(snapshot)).resolves.toBe(true);
			await fs.writeFile(path.join(root, "game.html"), "edited", "utf8");
			await expect(snapshotIsClean(snapshot)).resolves.toBe(false);
		});
	});

	// A kept transaction becomes the base the next one rolls back to, which is
	// what makes a sequence of them additive rather than one undo point.
	it("takes a new base after a transaction is kept", async () => {
		await withWorkspace({ "game.html": "v1" }, async (root) => {
			await takeSnapshot(root);
			await fs.writeFile(path.join(root, "game.html"), "v2", "utf8");

			const kept = await takeSnapshot(root);
			await fs.writeFile(path.join(root, "game.html"), "v3", "utf8");
			await restoreSnapshot(kept);

			await expect(
				fs.readFile(path.join(root, "game.html"), "utf8"),
			).resolves.toBe("v2");
		});
	});
});

describe("files the snapshot could not hold", () => {
	// The rollback took any file it did not hold for one the transaction had
	// created, and deleted it: here a file over the size limit that the
	// transaction shrank under it. The file existed before the transaction.
	it("never deletes a file that existed when the transaction opened", async () => {
		await withWorkspace(
			{ "big.dat": "x".repeat(2000), "a.txt": "a" },
			async (root) => {
				const limits = { maxFileBytes: 1000 };
				const snapshot = await takeSnapshot(root, limits);
				expect(snapshot.skipped).toEqual([path.join(root, "big.dat")]);

				await fs.writeFile(path.join(root, "big.dat"), "small now", "utf8");
				const report = await restoreSnapshot(snapshot, limits);

				expect(report.removed).toEqual([]);
				expect(report.unrestored).toEqual([path.join(root, "big.dat")]);
				await expect(
					fs.readFile(path.join(root, "big.dat"), "utf8"),
				).resolves.toBe("small now");
			},
		);
	});

	// The same through the file-count cap: deleting one held file lets a file
	// the open walked past fit, and it was removed as if new.
	it("keeps a file past the file cap when the transaction deleted another", async () => {
		await withWorkspace(
			{ "a.txt": "a", "b.txt": "b", "c.txt": "c" },
			async (root) => {
				const limits = { maxFiles: 2 };
				const snapshot = await takeSnapshot(root, limits);
				const [past] = snapshot.skipped;
				expect(past).toBeDefined();
				const held = [...snapshot.files.keys()][0];

				await fs.rm(held);
				const report = await restoreSnapshot(snapshot, limits);

				expect(report.removed).toEqual([]);
				expect(report.unrestored).toEqual([]);
				await expect(fs.readFile(past, "utf8")).resolves.toBeDefined();
				await expect(fs.readFile(held, "utf8")).resolves.toBeDefined();
			},
		);
	});

	it("does not call a skipped file the transaction left alone unrestored", async () => {
		await withWorkspace({ "big.dat": "x".repeat(2000) }, async (root) => {
			const limits = { maxFileBytes: 1000 };
			const snapshot = await takeSnapshot(root, limits);

			const report = await restoreSnapshot(snapshot, limits);

			expect(report.unrestored).toEqual([]);
			expect(await snapshotIsClean(snapshot, limits)).toBe(true);
		});
	});
});

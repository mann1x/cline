import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createReadReceipts,
	readFileStamp,
} from "../../extensions/tools/executors/read-receipts";
import { TransactionController } from "./transaction-controller";

// csf-6: the transaction rollback rewrote files with plain fs.writeFile and
// touched nothing else, so the read receipts still held the stamp from
// before the transaction. The next read said the file "changed since you
// last looked at it … something outside this session wrote to it" — about a
// restore the session's own protocol had just performed. Bug a6c03ad7d0
// fixed exactly this for restore_file; the rollback boundary was still
// missing the same hook.
describe("csf-6: a rollback retires the reads of the files it puts back", () => {
	it("settle() hands every restored file to forgetReads", async () => {
		const root = await fs.mkdtemp(join(tmpdir(), "csf6-settle-"));
		try {
			const file = join(root, "game.js");
			await fs.writeFile(file, "A\n", "utf8");
			const receipts = createReadReceipts();
			const forgotten: string[] = [];
			const controller = new TransactionController({
				workspaceRoot: root,
				maxChanges: 3,
				maxTransactions: 3,
				// What the VS Code host wires it to.
				forgetReads: (absolutePath) => {
					forgotten.push(absolutePath);
					receipts.noteRewrite(absolutePath);
				},
			});

			await controller.open();
			// The model reads the file, then edits it.
			receipts.noteRead(file, 1, 1);
			receipts.noteStamp(file, await readFileStamp(file));
			await fs.writeFile(file, "BB\n", "utf8");
			// Let the clock move, so the rollback's rewrite cannot land in the
			// same mtime tick the recorded stamp was taken in.
			await new Promise((resolve) => setTimeout(resolve, 25));

			const settlement = await controller.settle({ selfReport: "failure" });
			expect(settlement.kept).toBe(false);
			expect(forgotten).toContain(file);
			// With the stamp dropped, the restored file reads as unchanged —
			// not as somebody else's write.
			expect(receipts.changedSince(file, await readFileStamp(file))).toBe(
				false,
			);
			// And the model is still one that read it: its line numbers are
			// stale, the read is not.
			expect(receipts.covers(file, 1, 1)).toBe(false);
			expect(receipts.hasEverRead(file)).toBe(true);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("discard() hands every restored file to forgetReads", async () => {
		const root = await fs.mkdtemp(join(tmpdir(), "csf6-discard-"));
		try {
			const file = join(root, "game.js");
			await fs.writeFile(file, "A\n", "utf8");
			const forgotten: string[] = [];
			const controller = new TransactionController({
				workspaceRoot: root,
				maxChanges: 3,
				maxTransactions: 3,
				forgetReads: (absolutePath) => {
					forgotten.push(absolutePath);
				},
			});

			await controller.open();
			await fs.writeFile(file, "BB\n", "utf8");
			const restore = await controller.discard();
			expect(restore?.restored).toContain(file);
			expect(forgotten).toContain(file);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

// A proposed check is tried against the unmodified files: the base goes back
// for the run and the edits are written again after it. The content ends as
// it was, but every rewrite moves the mtime, so the stamp the session held
// went stale and its next edit was refused as "changed since you last read
// it" — about the protocol's own round trip.
describe("a check tried against the base keeps the session's stamps", () => {
	const passes = (root: string) => ({
		label: "passes",
		command: process.execPath,
		args: ["-e", ""],
		cwd: root,
		reason: "test",
	});

	async function roundTrip(
		setup: (
			root: string,
			receipts: ReturnType<typeof createReadReceipts>,
		) => Promise<string>,
	) {
		const root = await fs.mkdtemp(join(tmpdir(), "csf-judge-"));
		const receipts = createReadReceipts();
		const controller = new TransactionController({
			workspaceRoot: root,
			maxChanges: 3,
			maxTransactions: 3,
			carryReadStamp: (absolutePath, from, to) =>
				receipts.carryStamp?.(absolutePath, from, to),
		});
		await fs.writeFile(join(root, "game.js"), "A\n", "utf8");
		await controller.open();
		const file = await setup(root, receipts);
		await new Promise((resolve) => setTimeout(resolve, 25));
		await controller.judgeAgainstBase(passes(root));
		return { root, file, receipts };
	}

	it("an edited file the session saw last still reads as current", async () => {
		const { root, file, receipts } = await roundTrip(async (root, r) => {
			const file = join(root, "game.js");
			await fs.writeFile(file, "BB\n", "utf8");
			r.noteRead(file, 1, 1);
			r.noteStamp(file, await readFileStamp(file));
			return file;
		});
		try {
			expect(await fs.readFile(file, "utf8")).toBe("BB\n");
			expect(receipts.changedSince(file, await readFileStamp(file))).toBe(
				false,
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("a file the transaction created still reads as current", async () => {
		const { root, file, receipts } = await roundTrip(async (root, r) => {
			const file = join(root, "made.js");
			await fs.writeFile(file, "new\n", "utf8");
			r.noteRead(file, 1, 1);
			r.noteStamp(file, await readFileStamp(file));
			return file;
		});
		try {
			expect(receipts.changedSince(file, await readFileStamp(file))).toBe(
				false,
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("does not clear a change the session had not seen", async () => {
		const { root, file, receipts } = await roundTrip(async (root, r) => {
			const file = join(root, "game.js");
			await fs.writeFile(file, "BB\n", "utf8");
			r.noteRead(file, 1, 1);
			r.noteStamp(file, await readFileStamp(file));
			await new Promise((resolve) => setTimeout(resolve, 25));
			// Something outside the session writes after the read.
			await fs.writeFile(file, "OUTSIDE\n", "utf8");
			return file;
		});
		try {
			expect(receipts.changedSince(file, await readFileStamp(file))).toBe(true);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

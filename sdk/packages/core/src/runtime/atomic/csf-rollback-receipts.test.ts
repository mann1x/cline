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
				forgetReads: (absolutePath) => {
					forgotten.push(absolutePath);
					receipts.forget(absolutePath);
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
			// With the receipts forgotten, the restored file reads as
			// unchanged — not as somebody else's write.
			expect(receipts.changedSince(file, await readFileStamp(file))).toBe(
				false,
			);
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

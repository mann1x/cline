import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createReadReceipts, readFileStamp } from "./read-receipts";

const FILE = "/repo/game.html";

describe("createReadReceipts", () => {
	it("knows nothing about a file that was never read", () => {
		const receipts = createReadReceipts();

		expect(receipts.hasAny(FILE)).toBe(false);
		expect(receipts.covers(FILE, 1, 1)).toBe(false);
	});

	it("covers only the span that was actually read", () => {
		const receipts = createReadReceipts();
		receipts.noteRead(FILE, 80, 120);

		expect(receipts.covers(FILE, 84, 98)).toBe(true);
		expect(receipts.covers(FILE, 80, 120)).toBe(true);
		// Straddling either edge is not covered — the point is the range being
		// edited, not the file having been visited.
		expect(receipts.covers(FILE, 79, 98)).toBe(false);
		expect(receipts.covers(FILE, 100, 121)).toBe(false);
	});

	it("does not stitch two disjoint reads into one span", () => {
		// Reading the top and the bottom is not the same as having seen the
		// middle, and an edit that spans the gap is aimed at unread lines.
		const receipts = createReadReceipts();
		receipts.noteRead(FILE, 1, 50);
		receipts.noteRead(FILE, 100, 150);

		expect(receipts.covers(FILE, 1, 50)).toBe(true);
		expect(receipts.covers(FILE, 100, 150)).toBe(true);
		expect(receipts.covers(FILE, 40, 110)).toBe(false);
	});

	it("treats an unbounded read as covering the rest of the file", () => {
		const receipts = createReadReceipts();
		receipts.noteRead(FILE, 1, Number.POSITIVE_INFINITY);

		expect(receipts.covers(FILE, 400, 440)).toBe(true);
	});

	it("retires receipts when a write changes the file's length", () => {
		// The measured failure: eight edits addressed lines 84-98 while the
		// model's own edits grew the file from ~120 lines to 440, so the range
		// stopped naming the code it had read.
		const receipts = createReadReceipts();
		receipts.noteRead(FILE, 1, 120);
		expect(receipts.covers(FILE, 84, 98)).toBe(true);

		receipts.noteWrite(FILE, 120, 259);

		expect(receipts.covers(FILE, 84, 98)).toBe(false);
		expect(receipts.hasAny(FILE)).toBe(false);
		// Told apart from never-read, because the advice differs: this model
		// looked and had the ground move under it.
		expect(receipts.wasRetired(FILE)).toBe(true);
	});

	it("does not call a file retired when it was simply never read", () => {
		const receipts = createReadReceipts();
		receipts.noteWrite(FILE, 10, 20);

		expect(receipts.wasRetired(FILE)).toBe(false);
	});

	it("clears the retired mark once the file is read again", () => {
		const receipts = createReadReceipts();
		receipts.noteRead(FILE, 1, 120);
		receipts.noteWrite(FILE, 120, 259);
		receipts.noteRead(FILE, 1, 259);

		expect(receipts.wasRetired(FILE)).toBe(false);
		expect(receipts.covers(FILE, 84, 98)).toBe(true);
	});

	it("keeps receipts when a write leaves the line count alone", () => {
		// An in-place edit shifts nothing, so what was read is still where it
		// was read. Forcing a re-read here would cost a turn to learn nothing.
		const receipts = createReadReceipts();
		receipts.noteRead(FILE, 1, 120);

		receipts.noteWrite(FILE, 120, 120);

		expect(receipts.covers(FILE, 84, 98)).toBe(true);
	});

	it("keeps files apart", () => {
		const receipts = createReadReceipts();
		receipts.noteRead(FILE, 1, 120);

		expect(receipts.covers("/repo/other.html", 1, 10)).toBe(false);
	});

	it("retires a file the session itself rewrote, without forgetting the read", () => {
		// pandorum g5tmt: `restore_file` erased the receipts, and the next
		// text-matched edit was refused as "has not been read in this session".
		const receipts = createReadReceipts();
		receipts.noteRead(FILE, 1, 137);
		receipts.noteStamp(FILE, "9000:1");

		receipts.noteRewrite(FILE);

		expect(receipts.covers(FILE, 90, 93)).toBe(false);
		expect(receipts.wasRetired(FILE)).toBe(true);
		expect(receipts.hasEverRead(FILE)).toBe(true);
		// The rewrite is the session's own, not an outside change.
		expect(receipts.changedSince(FILE, "9003:2")).toBe(false);
	});
});

describe("a file put back to bytes the model read", () => {
	const FILE = "/w/game.html";

	it("gets back the reads that were live at those bytes", () => {
		const receipts = createReadReceipts();
		receipts.noteRead(FILE, 150, Number.POSITIVE_INFINITY);
		receipts.noteStamp(FILE, "336#aaaa");
		receipts.noteWrite(FILE, 336, 340);
		receipts.noteStamp(FILE, "340#bbbb");
		receipts.noteRewrite(FILE);

		expect(receipts.covers(FILE, 159, 166)).toBe(false);
		expect(receipts.reinstate?.(FILE, "340#bbbb")).toBe(false);
		expect(receipts.reinstate?.(FILE, "336#aaaa")).toBe(true);
		expect(receipts.covers(FILE, 159, 166)).toBe(true);
		expect(receipts.covers(FILE, 1, 10)).toBe(false);
		expect(receipts.wasRetired(FILE)).toBe(false);
		expect(receipts.changedSince(FILE, "336#aaaa")).toBe(false);
	});

	it("never matches a size-and-mtime stamp, which proves nothing about the bytes", () => {
		const receipts = createReadReceipts();
		receipts.noteRead(FILE, 1, 40);
		receipts.noteStamp(FILE, "9000:1");
		receipts.noteRewrite(FILE);

		expect(receipts.reinstate?.(FILE, "9000:1")).toBe(false);
		expect(receipts.covers(FILE, 1, 10)).toBe(false);
	});

	it("brings the cut lines back with the spans", () => {
		const receipts = createReadReceipts();
		receipts.noteRead(FILE, 1, 5);
		receipts.noteCut?.(FILE, 3, 2000, 5000);
		receipts.noteStamp(FILE, "6000#cccc");
		receipts.noteRewrite(FILE);

		expect(receipts.reinstate?.(FILE, "6000#cccc")).toBe(true);
		expect(receipts.cutAt?.(FILE, 3)).toEqual({ shown: 2000, length: 5000 });
	});

	it("forgets them with the file", () => {
		const receipts = createReadReceipts();
		receipts.noteRead(FILE, 1, 5);
		receipts.noteStamp(FILE, "10#dddd");
		receipts.forget(FILE);

		expect(receipts.reinstate?.(FILE, "10#dddd")).toBe(false);
	});
});

describe("a registry handed to the next task", () => {
	it("has read nothing once cleared", () => {
		const receipts = createReadReceipts();
		receipts.noteRead("/w/game.html", 1, 40);
		receipts.noteStamp("/w/game.html", "stamp-a");

		receipts.clear();

		// The file was put back between runs: a new stamp, and a task that has
		// never looked at it. Not "changed since you last looked".
		expect(receipts.changedSince("/w/game.html", "stamp-b")).toBe(false);
		expect(receipts.hasEverRead("/w/game.html")).toBe(false);
		expect(receipts.covers("/w/game.html", 1, 10)).toBe(false);
		expect(receipts.paths()).toEqual([]);
	});
});

// automaticum audit 2026-11-08, M4: a file past the read cap could never be
// covered, because one read had to span all of it.
describe("reads that join up", () => {
	const FILE = "/ws/big.txt";

	it("cover a range together when they touch or overlap", () => {
		const receipts = createReadReceipts();
		receipts.noteRead(FILE, 1, 2000);
		receipts.noteRead(FILE, 2001, 2500);
		expect(receipts.covers(FILE, 1, 2500)).toBe(true);
		receipts.noteRead(FILE, 2400, 3000);
		expect(receipts.covers(FILE, 1, 3000)).toBe(true);
	});

	it("still refuse a range with a line nobody read", () => {
		const receipts = createReadReceipts();
		receipts.noteRead(FILE, 1, 10);
		receipts.noteRead(FILE, 12, 20);
		expect(receipts.covers(FILE, 1, 20)).toBe(false);
		expect(receipts.covers(FILE, 12, 20)).toBe(true);
	});
});

// A touch moved mtime and nothing else, and the next read said the file had
// "changed since you last looked" (automaticum audit 2026-11-08, readers 18).
describe("readFileStamp", () => {
	it("does not change when only the modification time does", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stamp-"));
		try {
			const file = path.join(dir, "f.txt");
			await fs.writeFile(file, "same text\n");
			const before = await readFileStamp(file);
			const later = new Date(Date.now() + 60_000);
			await fs.utimes(file, later, later);
			expect(await readFileStamp(file)).toBe(before);
			// And a same-length rewrite is a change.
			await fs.writeFile(file, "SAME TEXT\n");
			expect(await readFileStamp(file)).not.toBe(before);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("tells an absent file from a present one", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stamp-"));
		try {
			expect(await readFileStamp(path.join(dir, "nope"))).toBe("absent");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

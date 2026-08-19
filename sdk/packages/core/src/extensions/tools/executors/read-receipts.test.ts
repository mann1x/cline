import { describe, expect, it } from "vitest";
import { createReadReceipts } from "./read-receipts";

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
});

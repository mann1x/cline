import { describe, expect, it } from "vitest";
import { createReadLedger, REFRESH_EVERY } from "./unchanged-reads";

const FILE = "c:\\Users\\manni\\source\\repos\\test\\manic_miner.html";

const whole = (path = FILE) => ({
	path,
	firstLine: 1,
	lastLine: 134,
	withLineNumbers: true,
});

describe("createReadLedger", () => {
	it("returns the content the first time", () => {
		const ledger = createReadLedger();

		expect(ledger.noticeFor(whole(), "the file")).toBeUndefined();
	});

	it("answers an unchanged re-read with a notice instead of the copy", () => {
		const ledger = createReadLedger();
		ledger.noticeFor(whole(), "the file");

		const notice = ledger.noticeFor(whole(), "the file") ?? "";

		expect(notice).toContain("has not changed");
		expect(notice).not.toContain("the file");
		expect(notice).toContain("134 lines");
	});

	// The whole point: a read after a real edit is how work gets done, and it
	// must never be suppressed.
	it("returns the content whenever the file has changed", () => {
		const ledger = createReadLedger();
		ledger.noticeFor(whole(), "before");

		expect(ledger.noticeFor(whole(), "after")).toBeUndefined();
		// ...and the new content is what later reads are compared against.
		expect(ledger.noticeFor(whole(), "after")).toContain("has not changed");
	});

	// Edit, read, edit, read is exactly the shape that defeats the adjacency
	// guard, so it is the shape this has to survive.
	it("suppresses nothing when reads alternate with real changes", () => {
		const ledger = createReadLedger();

		for (const text of ["v1", "v2", "v3", "v4", "v5", "v6"]) {
			expect(ledger.noticeFor(whole(), text)).toBeUndefined();
		}
	});

	it("keys on the window, so a different range is a different read", () => {
		const ledger = createReadLedger();
		ledger.noticeFor(whole(), "the file");

		expect(
			ledger.noticeFor(
				{ path: FILE, firstLine: 90, lastLine: 96, withLineNumbers: true },
				"the file",
			),
		).toBeUndefined();
	});

	it("keys on the path", () => {
		const ledger = createReadLedger();
		ledger.noticeFor(whole(), "same bytes");

		expect(ledger.noticeFor(whole("other.html"), "same bytes")).toBeUndefined();
	});

	// Compaction insurance: the earlier copy may have been summarised away, so
	// the content has to come back round on its own.
	it("serves the real content again every REFRESH_EVERY repeats", () => {
		const ledger = createReadLedger();
		const served: number[] = [];

		for (let call = 0; call < 13; call += 1) {
			if (ledger.noticeFor(whole(), "the file") === undefined) {
				served.push(call);
			}
		}

		// Call 0 is the first sight; then every 4th repeat.
		expect(served).toEqual([
			0,
			REFRESH_EVERY,
			REFRESH_EVERY * 2,
			REFRESH_EVERY * 3,
		]);
	});

	// A loop must not buy a fresh budget by waiting through the valve.
	it("keeps counting through a refresh", () => {
		const ledger = createReadLedger();
		for (let call = 0; call < REFRESH_EVERY + 1; call += 1) {
			ledger.noticeFor(whole(), "the file");
		}

		const notice = ledger.noticeFor(whole(), "the file") ?? "";

		// Six, not two: the refresh served the content but did not forgive the
		// repeats that came before it.
		expect(notice).toContain(`This is read ${REFRESH_EVERY + 2}`);
		expect(notice).not.toContain("This is read 2 ");
	});

	// The measured run: 31 identical reads of one file.
	it("cuts the measured session's repeated reads to a quarter", () => {
		const ledger = createReadLedger();
		const body = "x".repeat(14_000);
		let servedChars = 0;

		for (let call = 0; call < 31; call += 1) {
			if (ledger.noticeFor(whole(), body) === undefined) {
				servedChars += body.length;
			}
		}

		expect(servedChars).toBe(8 * body.length);
		expect(servedChars).toBeLessThan(31 * body.length * 0.3);
	});
});

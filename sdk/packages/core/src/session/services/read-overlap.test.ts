import { describe, expect, it } from "vitest";
import { parseNumberedLines, readOverlapUnchanged } from "./read-overlap";

describe("parseNumberedLines", () => {
	it("reads the source text out from behind the line number", () => {
		expect(parseNumberedLines(" 80 | const x = 1\n 81 | const y = 2")).toEqual(
			new Map([
				[80, "const x = 1"],
				[81, "const y = 2"],
			]),
		);
	});

	it("skips lines that carry no number", () => {
		const parsed = parseNumberedLines(
			"manic_miner.html (lines 80-81)\n 80 | <div>\n...[truncated 12 chars]...",
		);
		expect(parsed).toEqual(new Map([[80, "<div>"]]));
	});

	it("keeps text that itself contains a pipe", () => {
		expect(parseNumberedLines(" 12 | a || b").get(12)).toBe("a || b");
	});

	it("keeps leading indentation of the source", () => {
		expect(parseNumberedLines(" 12 |     indented()").get(12)).toBe(
			"    indented()",
		);
	});
});

describe("readOverlapUnchanged", () => {
	// The number is padded to the widest line number *in that read*, so the same
	// source line renders differently in a 3-digit range read and a 4-digit
	// whole-file read. Comparing rendered text would call these two unequal and
	// the witness would never fire.
	it("ignores line-number padding differences between reads", () => {
		const narrow = " 94 | const a = 1\n 95 | const b = 2";
		const wide = "  94 | const a = 1\n  95 | const b = 2";

		expect(readOverlapUnchanged(wide, narrow, 94, 95)).toBe(true);
	});

	it("sees a changed line in the overlap", () => {
		const earlier = " 94 | const a = 1\n 95 | const b = 2";
		const later = " 94 | const a = 1\n 95 | const b = 99";

		expect(readOverlapUnchanged(earlier, later, 94, 95)).toBe(false);
	});

	it("only compares the overlapping range", () => {
		const earlier = " 80 | outside\n 94 | same\n 95 | same too";
		const later = " 94 | same\n 95 | same too";

		expect(readOverlapUnchanged(earlier, later, 94, 95)).toBe(true);
	});

	// "Cannot prove equal" must read as changed. Collapsing on a guess is the
	// failure that feeds the model source which no longer exists.
	it("refuses when a line is missing from either side", () => {
		const earlier = " 94 | same";
		const later = " 94 | same\n 95 | extra";

		expect(readOverlapUnchanged(earlier, later, 94, 95)).toBe(false);
		expect(readOverlapUnchanged(later, earlier, 94, 95)).toBe(false);
	});

	it("refuses an empty overlap", () => {
		expect(readOverlapUnchanged(" 1 | a", " 1 | a", 5, 4)).toBe(false);
	});

	it("refuses when a read was truncated across the overlap", () => {
		const earlier = " 94 | same\n...[truncated 300 chars]...\n 99 | tail";
		const later = " 94 | same\n 95 | middle\n 99 | tail";

		expect(readOverlapUnchanged(earlier, later, 94, 99)).toBe(false);
	});
});

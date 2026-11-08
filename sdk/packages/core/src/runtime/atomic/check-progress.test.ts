import { describe, expect, it } from "vitest";
import { compareCheckProgress } from "./check-progress";

// automaticum audit 2026-11-08, B22: a new answer is not always a better one.
describe("compareCheckProgress", () => {
	it("reads more frames as better and fewer as worse", () => {
		expect(
			compareCheckProgress(
				"g.html: frame 3: TypeError (after 3 frame(s))",
				"g.html: frame 40: TypeError (after 40 frame(s))",
			),
		).toBe("better");
		expect(
			compareCheckProgress(
				"g.html: frame 40: x (after 40 frame(s))",
				"g.html: frame 2: x (after 2 frame(s))",
			),
		).toBe("worse");
	});

	it("reads fewer failures as better and more as worse", () => {
		expect(
			compareCheckProgress("3 failed, 9 passed", "1 failed, 11 passed"),
		).toBe("better");
		expect(compareCheckProgress("Found 2 errors.", "Found 5 errors.")).toBe(
			"worse",
		);
	});

	it("reads a later first error in the same file as better", () => {
		expect(
			compareCheckProgress(
				"game.js:40 SyntaxError: Unexpected token",
				"game.js:97 SyntaxError: Unexpected token",
			),
		).toBe("better");
		expect(
			compareCheckProgress("game.js:97 SyntaxError", "game.js:12 SyntaxError"),
		).toBe("worse");
	});

	it("says unknown where nothing compares", () => {
		expect(compareCheckProgress("FAIL", "FAIL: something else")).toBe(
			"unknown",
		);
		expect(compareCheckProgress("a.js:10 x", "b.js:3 y")).toBe("unknown");
	});
});

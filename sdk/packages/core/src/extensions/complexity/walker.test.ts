/**
 * Cognitive complexity, and the bound that has to travel with it.
 *
 * Run against the real JavaScript grammar rather than a hand-built tree: the
 * node-type sets are the whole implementation, and a fake tree would be me
 * asserting that my own names match my own names.
 */

import { describe, expect, it } from "vitest";
import { grammarFor } from "./grammars";
import { describeComplexity, scoreComplexity } from "./walker";

describe("which files can be measured at all", () => {
	it("knows the languages it ships a grammar for", () => {
		expect(grammarFor("src/game.js")).toBe("javascript");
		expect(grammarFor("src/app.tsx")).toBe("tsx");
		expect(grammarFor("main.py")).toBe("python");
	});

	// Silence, never a zero. A language nothing parses is not simple code.
	it("says nothing about a language it has no grammar for", async () => {
		expect(grammarFor("notes.txt")).toBeUndefined();
		await expect(
			scoreComplexity("notes.txt", "if if if"),
		).resolves.toBeUndefined();
	});
});

describe("what the number charges for", () => {
	it("scores flat code at nothing", async () => {
		const score = await scoreComplexity(
			"f.js",
			"function f(a){ return a + 1; }\n",
		);

		expect(score?.score).toBe(0);
	});

	// The reason this is not cyclomatic complexity: depth is what makes code
	// expensive to follow, and a path count cannot see it.
	it("charges nesting, so the same branches cost more the deeper they are", async () => {
		const flat = await scoreComplexity(
			"f.js",
			"function f(a,b,c){ if(a){x();} if(b){y();} if(c){z();} }\n",
		);
		const nested = await scoreComplexity(
			"f.js",
			"function f(a,b,c){ if(a){ if(b){ if(c){ z(); } } } }\n",
		);

		expect(flat?.score).toBe(3);
		expect(nested?.score).toBeGreaterThan(flat?.score ?? 0);
		expect(nested?.score).toBe(6);
	});

	// One decision per branch, and the chain does not deepen. Scoring the
	// `else if` as a fresh nested conditional would make the clearest shape of
	// a four-way choice the most expensive one.
	it("reads an else-if chain as one decision per branch, without deepening", async () => {
		const chain = await scoreComplexity(
			"f.js",
			"function f(a,b){ if(a){x();} else if(b){y();} else {z();} }\n",
		);
		const nested = await scoreComplexity(
			"f.js",
			"function f(a,b){ if(a){x();} else { if(b){y();} else {z();} } }\n",
		);

		expect(chain?.score).toBe(3);
		expect(nested?.score).toBeGreaterThan(chain?.score ?? 0);
	});

	it("charges a run of the same operator once", async () => {
		const one = await scoreComplexity(
			"f.js",
			"function f(a,b,c){ if(a && b && c){x();} }\n",
		);
		const two = await scoreComplexity(
			"f.js",
			"function f(a,b,c){ if(a && b || c){x();} }\n",
		);

		expect(one?.score).toBe(2);
		expect(two?.score).toBe(3);
	});
});

describe("the function around a line", () => {
	const source = [
		"function easy(a){ return a; }",
		"function hard(a,b){",
		"  if (a) {",
		"    if (b) {",
		"      run();",
		"    }",
		"  }",
		"}",
	].join("\n");

	it("narrows to the function the line is in, and names it", async () => {
		const score = await scoreComplexity("f.js", source, { line: 5 });

		expect(score?.name).toBe("hard");
		expect(score?.score).toBe(3);
	});

	it("reads a different function for a different line", async () => {
		const score = await scoreComplexity("f.js", source, { line: 1 });

		expect(score?.name).toBe("easy");
		expect(score?.score).toBe(0);
	});
});

describe("the bound the number travels with", () => {
	// A measurement handed over without its bound gets used as the thing it is
	// not. `check_file` states its own the same way.
	it("says what it measures and what it does not", () => {
		const said = describeComplexity(
			{ score: 14, startLine: 2, endLine: 8, name: "hard" },
			"src/game.js",
		);

		expect(said).toContain("`hard`");
		expect(said).toContain("src/game.js:2-8");
		expect(said).toContain("14");
		expect(said).toContain("not how likely");
	});
});

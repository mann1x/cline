/**
 * Cognitive complexity, and the bound that has to travel with it.
 *
 * Run against the real JavaScript grammar rather than a hand-built tree: the
 * node-type sets are the whole implementation, and a fake tree would be me
 * asserting that my own names match my own names.
 */

import { describe, expect, it } from "vitest";
import { grammarFor } from "./grammars";
import {
	bandFor,
	COMPLEXITY_SCALE,
	describeComplexity,
	fileParses,
	isHighComplexity,
	scoreComplexity,
} from "./walker";

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

/**
 * HTML, which is where the number was wrong rather than absent.
 *
 * `tree-sitter-html` hands a `<script>` body over as one unparsed `raw_text`
 * node, so a single-file game scored a *defined* 0 -- the reading the rest of
 * this module exists to prevent. Measured on the manic_miner harness source
 * before this: 137 lines, score 0.
 */
describe("code inside an HTML document", () => {
	const page = (body: string, attrs = "") =>
		`<!doctype html>\n<html>\n<body>\n<script${attrs}>\n${body}\n</script>\n</body>\n</html>\n`;

	it("scores the script instead of seeing an empty document", async () => {
		const source = page(
			[
				"function tick(items, x) {",
				"  items.forEach((d) => {",
				"    if (d.on) {",
				"      for (const p of d.parts) {",
				"        if (p.hit) { p.y += 1; }",
				"      }",
				"    }",
				"  });",
				"}",
			].join("\n"),
		);
		const score = await scoreComplexity("game.html", source);
		expect(score?.score).toBeGreaterThan(0);
	});

	// Not the sum across scripts. A page with six small scripts is six small
	// problems, and adding them up reports one large one that nobody has to
	// read. The hardest function in the document is the one worth naming.
	it("reports the hardest script in the document, not their total", async () => {
		const easy = "function e(){ if (a) { b(); } }";
		const hard =
			"function h(xs){ for (const x of xs) { if (x) { while (x.n) { x.n--; } } } }";
		const alone = await scoreComplexity("a.html", page(hard));
		const both = await scoreComplexity("b.html", `${page(easy)}${page(hard)}`);

		expect(alone?.score).toBe(6);
		expect(both?.score).toBe(6);
		expect(both?.name).toBe("h");
	});

	// The span has to be openable: the line numbers a reader is given must be
	// the HTML file's, not the script's own.
	it("reports the span in the document's line numbers", async () => {
		const score = await scoreComplexity("game.html", page("if (a) { b(); }"));
		// The script body starts on line 5 of the page above.
		expect(score?.startLine).toBeGreaterThanOrEqual(5);
	});

	// A `type` that is not JavaScript means the body is data. Scoring an import
	// map as code would be inventing a number.
	it("leaves a non-JavaScript script alone", async () => {
		const data = page('{"imports": {"a": "./a.js"}}', ' type="importmap"');
		expect((await scoreComplexity("x.html", data))?.score).toBe(0);
		const module = page("if (a) { b(); }", ' type="module"');
		expect((await scoreComplexity("y.html", module))?.score).toBe(1);
	});

	// `<script src=...>` is a real script this file does not contain.
	it("says nothing about a script it does not hold", async () => {
		const linked =
			'<!doctype html>\n<html><body><script src="g.js"></script></body></html>\n';
		expect((await scoreComplexity("z.html", linked))?.score).toBe(0);
	});

	it("narrows to the function around a line given in the document", async () => {
		const source = page(
			[
				"function small() { return 1; }",
				"function big(xs) {",
				"  for (const x of xs) {",
				"    if (x) { while (x.n) { x.n -= 1; } }",
				"  }",
				"}",
			].join("\n"),
		);
		// `big` opens on line 6 of the page: 4 lines of preamble, then `small`.
		const narrowed = await scoreComplexity("game.html", source, { line: 6 });
		expect(narrowed?.name).toBe("big");
		expect(narrowed?.startLine).toBe(6);
	});
});

/**
 * The scale, which is the difference between a number and information.
 *
 * "This function scores 474" cannot be acted on: the metric has no ceiling, so
 * the reader's first question is what 474 is out of, and there is no answer
 * unless one travels with it. A reader who has to score a dozen other
 * functions before knowing what they have been told will not do it.
 */
describe("saying what the number means", () => {
	it("puts SonarSource's flag point at the bottom of `high`", () => {
		expect(bandFor(14)).toBe("moderate");
		expect(bandFor(15)).toBe("high");
	});

	it("bands the whole range, with nothing falling through", () => {
		expect(bandFor(0)).toBe("simple");
		expect(bandFor(4)).toBe("simple");
		expect(bandFor(5)).toBe("moderate");
		expect(bandFor(24)).toBe("high");
		expect(bandFor(25)).toBe("very high");
		expect(bandFor(59)).toBe("very high");
		expect(bandFor(60)).toBe("extreme");
		expect(bandFor(452)).toBe("extreme");
	});

	// Whatever else changes, a reader must never be handed a bare integer.
	it("carries the band and the whole ladder in the sentence", async () => {
		const source = [
			"function big(xs) {",
			"  for (const x of xs) {",
			"    if (x) { while (x.n) { x.n -= 1; } }",
			"  }",
			"}",
		].join("\n");
		const score = await scoreComplexity("game.js", source);
		const said = describeComplexity(score as never, "game.js");

		expect(said).toContain("`big`");
		expect(said).toContain(COMPLEXITY_SCALE);
		expect(said).toMatch(/simple|moderate|high|very high|extreme/);
		expect(said).toContain("not how likely this change is to work");
	});

	it("calls a file high only when its worst function is extreme", async () => {
		const ordinary = await scoreComplexity(
			"a.js",
			"function f(){ if (a) { b(); } }",
		);
		expect(isHighComplexity(ordinary)).toBe(false);
		expect(isHighComplexity(undefined)).toBe(false);
	});
});

/**
 * Why a function and not the file.
 *
 * A whole-file sum is dominated by size: it ranked a 4,002-line file above a
 * 137-line minified game, which inverts what the number is for. A function is
 * also the unit SonarSource's 15 refers to, so it is the only unit the scale
 * can honestly be quoted against.
 */
describe("which part of the file the score describes", () => {
	it("reports the hardest function, not the sum of all of them", async () => {
		const source = [
			"function small() { if (a) { b(); } }",
			"function big(xs) {",
			"  for (const x of xs) {",
			"    if (x) { while (x.n) { x.n -= 1; } }",
			"  }",
			"}",
			"function alsoSmall() { if (c) { d(); } }",
		].join("\n");

		const score = await scoreComplexity("game.js", source);

		// The sum would be 8. The hardest function is 6, and it has a name.
		expect(score?.score).toBe(6);
		expect(score?.name).toBe("big");
		expect(score?.startLine).toBe(2);
	});

	// A page or a script can be all top-level statements, and that is code.
	it("falls back to the whole file when it holds no functions", async () => {
		const score = await scoreComplexity(
			"top.js",
			"if (a) { b(); }\nfor (const x of xs) { if (x) { f(); } }",
		);

		expect(score?.score).toBe(4);
		expect(score?.name).toBeUndefined();
	});
});

/**
 * The yes/no next to the score.
 *
 * It exists because "your edits are being refused" and "the file no longer
 * parses" are different facts: a refused edit changes nothing, so a file that
 * is broken while the refusals pile up was broken by the edits that landed.
 */
describe("whether a file still parses", () => {
	it("says yes to code the grammar can read end to end", async () => {
		expect(
			await fileParses("game.js", "function f() { if (a) { b(); } }"),
		).toBe(true);
	});

	it("says no to a file the grammar gives up on", async () => {
		// An unclosed brace at the top of a file, which is what half an edit
		// leaves behind.
		const broken = `function f() { if (a) { b(); }\n${"const x = ) ( } ;\n".repeat(40)}`;
		expect(await fileParses("game.js", broken)).toBe(false);
	});

	// Never `false`: nothing was measured, and reading silence as a verdict is
	// the mistake the whole module is written against.
	it("says nothing about a language it has no grammar for", async () => {
		expect(await fileParses("notes.txt", "!!! not code !!!")).toBeUndefined();
	});
});

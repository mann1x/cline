import { describe, expect, it } from "vitest";
import {
	describeDelimiterBalance,
	findScriptSyntaxError,
	scanDelimiters,
} from "./delimiter-balance";

describe("scanDelimiters", () => {
	it("says nothing about balanced code", () => {
		expect(scanDelimiters("function f(a){ return [a, {b: 1}] }")).toEqual([]);
	});

	it("names the opener a crossed closer belongs to", () => {
		// `{` opened at column 14 is closed by `)`.
		const [finding] = scanDelimiters("function f(){ if (a) { b(); ) }");
		expect(finding).toMatchObject({
			kind: "mismatch",
			opener: "{",
			openColumn: 22,
			found: ")",
			column: 29,
		});
	});

	it("reports a closer with nothing open", () => {
		expect(scanDelimiters("a();)")).toEqual([
			{ kind: "unmatched-close", line: 1, column: 5, found: ")" },
		]);
	});

	it("records what was still open around a crossing, innermost first", () => {
		const [finding] = scanDelimiters(
			"class A {\n  m(){ this.each(d=>{ if(d){ go(); ) } }) }\n}\n",
		);
		expect(finding?.enclosing).toEqual([
			{ opener: "{", line: 2, column: 21 },
			{ opener: "(", line: 2, column: 17 },
			{ opener: "{", line: 2, column: 6 },
			{ opener: "{", line: 1, column: 9 },
		]);
	});

	it("reports an opener that is never closed", () => {
		const [finding] = scanDelimiters("function f(){\n  if (a) {\n}\n");
		expect(finding).toMatchObject({
			kind: "unclosed",
			opener: "{",
			openLine: 1,
			openColumn: 13,
		});
	});

	it("ignores brackets inside strings, comments and regexes", () => {
		const source = [
			'const a = "}}}"',
			"const b = '((('",
			"// ]]] not code",
			"/* {{{ still not code */",
			"const c = /[{(]/.test(x)",
		].join("\n");
		expect(scanDelimiters(source)).toEqual([]);
	});

	it("follows a template literal back out of its substitution", () => {
		// The tail after `}` is prose, not code: a lone quote or brace there
		// must not flip the scanner into a string. This is the case that made
		// the scanner disagree with `node --check` on a real file.
		const source = [
			"const s = `count ${n} isn't ${m} done`",
			"function f(){ return 1 }",
		].join("\n");
		expect(scanDelimiters(source)).toEqual([]);
	});

	it("handles nested substitutions and braces inside them", () => {
		expect(scanDelimiters("const s = `${ {a: `${b}`}.a }`")).toEqual([]);
	});

	it("counts lines and columns from an origin", () => {
		const [finding] = scanDelimiters("a(]", { line: 30, column: 5 });
		expect(finding).toMatchObject({ line: 30, column: 7, found: "]" });
	});
});

describe("describeDelimiterBalance", () => {
	it("returns nothing for a language it does not understand", () => {
		expect(describeDelimiterBalance("notes.md", "# heading ) ) )")).toBeNull();
	});

	it("returns nothing for JSX, which it cannot parse", () => {
		// A false report sends a model to edit a line that was correct, so
		// .tsx is excluded outright rather than guessed at.
		expect(
			describeDelimiterBalance(
				"View.tsx",
				"const V = () => <div a={1}>{x}</div>",
			),
		).toBeNull();
	});

	it("returns nothing when a file balances", () => {
		expect(
			describeDelimiterBalance(
				"app.ts",
				"export function f(){ return {a: [1]} }",
			),
		).toBeNull();
	});

	it("reports the crossing in a .ts file", () => {
		const report = describeDelimiterBalance(
			"app.ts",
			"function f(){ if (a) { b(); ) }",
		);
		expect(report).toContain("Delimiter scan");
		// The line the edit goes on leads; the crossing that found it follows.
		expect(report).toContain("line 1: ");
		expect(report).toContain("`{` at column 22 is closed by `)` at column 29");
	});

	it("names every line that does not balance, not just the first", () => {
		// Measured: a real file had five separately broken lines, each a
		// minified one-liner ending `}})` where it should end `});`. Reporting
		// two of them sent the model round the loop — edit, reload, read, edit —
		// once per line, and it fixed a line the report had not named.
		const source = [
			"<script>",
			"a.forEach(p=>{if(p){x();}})}",
			"b.forEach(p=>{if(p){y();}})}",
			"c.forEach(p=>{if(p){z();}})}",
			"</script>",
		].join("\n");

		const report = describeDelimiterBalance("game.html", source);

		expect(report).toContain("line(s) do not balance");
		expect(report).toContain("line 2");
		expect(report).toContain("line 3");
		expect(report).toContain("line 4");
	});

	it("reports one line once, however many crossings it holds", () => {
		const report = describeDelimiterBalance(
			"app.ts",
			"function f(){ if (a) { b(); ) } ) }",
		);
		const named = (report ?? "")
			.split("\n")
			.filter((line) => line.startsWith("  line "));
		expect(named).toHaveLength(1);
	});

	it("keeps the singular heading when only one line is at fault", () => {
		const report = describeDelimiterBalance(
			"app.ts",
			"function f(){ if (a) { b(); ) }",
		);
		expect(report).toContain("Delimiter scan:");
		expect(report).toContain("edit the line named above");
	});

	it("leads with the line and the tally, not with the crossing", () => {
		// Measured, and the reason this order exists. Led by the crossing, the
		// report read "the `(` opened at line 90, column 30 is closed by `}` at
		// line 90, column 382; counting only code, this line has 1 more `}`
		// than `{`". The model quoted that first clause and spent six turns —
		// four of them ending at the thinking budget — trying to work out how a
		// `(` could be closed by a `}`, while the half that told it what to
		// change sat behind a semicolon.
		const report = describeDelimiterBalance(
			"app.js",
			"dDec(c,x){this.dc.forEach(d=>{if(d){c.fill();}}});}\n",
		);
		const named = (report ?? "")
			.split("\n")
			.find((line) => line.startsWith("  line "));
		expect(named).toBe(
			"  line 1: counting only code, this line has 1 more `}` than `{` — that is the edit (the `(` at column 26 is closed by `}` at column 48)",
		);
	});

	it("scans script bodies in HTML at their real line numbers", () => {
		const html = [
			"<!DOCTYPE html>",
			"<body>",
			"<script>",
			"function f(){ g(); ) }",
			"</script>",
			"</body>",
		].join("\n");
		const report = describeDelimiterBalance("game.html", html);
		expect(report).toContain("line 4");
	});

	it("skips a script element that only references a source file", () => {
		const html = ['<script src="game.js"></script>', "<p>)))</p>"].join("\n");
		expect(describeDelimiterBalance("game.html", html)).toBeNull();
	});

	/**
	 * The counts are what make the report an instruction rather than a
	 * description. A model told only that two brackets cross sent back the line
	 * it already had, twelve times; the line held one `}` more than it opened.
	 */
	describe("surplus counts", () => {
		it("names the surplus when a crossing starts and ends on one line", () => {
			// `dPw(){...}}` — one closing brace too many, all on line 1.
			const report = describeDelimiterBalance(
				"app.js",
				"function dPw(c){ if (c) { c(); }}}\n",
			);
			expect(report).toContain("1 more `}` than `{`");
			expect(report).toContain("that is the edit");
		});

		it("says a crossed line that balances is out of order, not short", () => {
			const report = describeDelimiterBalance("app.js", "const x = ({)};\n");
			expect(report).toContain("do balance");
			expect(report).toContain("wrong place");
		});

		it("says nothing about counts for a block left open across lines", () => {
			// Ordinary code: line 1 opens a brace it does not close. That is not
			// a surplus, and calling it one would send an edit to a correct line.
			const report = describeDelimiterBalance(
				"app.js",
				"function f() {\n  g();\n)\n",
			);
			expect(report).not.toContain("that is the edit");
		});

		it("counts only code, not brackets inside strings", () => {
			const report = describeDelimiterBalance(
				"app.js",
				'function f(){ s = "}}}}"; }}\n',
			);
			expect(report).toContain("1 more `}` than `{`");
		});
	});

	/**
	 * Which brackets cross is the easy half. Whether to delete one, add one or
	 * move one is the half the model pays for: one measured turn spent 33,350
	 * tokens deciding between a swap and a deletion on a 500-column line, hit
	 * the thinking budget mid-sentence, and had picked the wrong one anyway —
	 * the run that fixed that file deleted a brace. A scan is microseconds, so
	 * the edit is tried and re-scanned rather than reasoned about.
	 */
	describe("a checked repair", () => {
		it("names the edit that clears the line", () => {
			// The shape from the file this was measured on, reduced. The run that
			// fixed it made exactly this edit.
			const report = describeDelimiterBalance(
				"app.js",
				"dDec(c,x){this.dc.forEach(d=>{if(d){c.fill();}}});}\n",
			);
			expect(report).toContain("delete the `}` at column 48 — checked");
			expect(report).toContain("nothing else in this file crosses after that");
		});

		it("gives the edit as arguments the editor takes, not as text to match", () => {
			// Measured: told to delete the `}` at column 382, the model restated
			// that correctly and then composed an `old_text` for a 500-column
			// minified line, which came back "No replacement performed: text not
			// found". The editor addresses a character directly; so does this.
			const report = describeDelimiterBalance(
				"app.js",
				"dDec(c,x){this.dc.forEach(d=>{if(d){c.fill();}}});}\n",
			);
			expect(report).toContain(
				'`editor` with start_line: 1, start_column: 48, new_text: ""',
			);
			expect(report).toContain("there is no text to match on");
		});

		it("orders a move so the deletion accounts for the insert's shift", () => {
			// Insert first at column 12, which pushes the `)` from 13 to 14.
			const report = describeDelimiterBalance("app.js", "const x = ({)};\n");
			expect(report).toContain(
				'insert_line: 1, insert_column: 12, new_text: ")"',
			);
			expect(report).toContain('start_line: 1, start_column: 14, new_text: ""');
		});

		it("proposes a move when the line balances and a closer is misplaced", () => {
			const report = describeDelimiterBalance("app.js", "const x = ({)};\n");
			expect(report).toContain(
				"move the `)` at column 13 to column 12 — checked",
			);
		});

		it("says what is left over when the file has more than one fault", () => {
			const report = describeDelimiterBalance(
				"app.js",
				"function f(){ if (a) { b(); ) } ) }\n",
			);
			expect(report).toContain("replace the `)` at column 29 with `}`");
			expect(report).toContain(
				"leaves 2 of the 3 crossings, all further down the file",
			);
		});

		it("gives the enclosing chain when no single edit clears it", () => {
			const report = describeDelimiterBalance(
				"app.js",
				"function f(){\n  if (a) {\n    b();\n)\n",
			);
			expect(report).toContain("a `}` is what belongs at column 1");
			expect(report).toContain(
				"no single-character edit clears it, and still open there, innermost first: `{` 1:13",
			);
		});

		it("does not claim a search it never ran on a file too big to search", () => {
			const big = `function f(){ if (a) { b(); ) }\n${"// filler\n".repeat(20_000)}`;
			const report = describeDelimiterBalance("big.js", big);
			expect(report).not.toContain("no single-character edit clears it");
			expect(report).toContain("Still open there, innermost first");
		});

		it("says it about the first line only, whatever else is broken", () => {
			const report = describeDelimiterBalance(
				"app.js",
				"f(){ a(); ) }\ng(){ b(); ) }\nh(){ c(); ) }\n",
			);
			const checked = (report ?? "")
				.split("\n")
				.filter((line) => line.includes("— checked"));
			expect(checked).toHaveLength(1);
		});
	});
});

describe("findScriptSyntaxError", () => {
	// The exact shape a run left on disk: a `;` where the argument list wanted
	// its `)`. The browser said nothing about it, so a parser has to.
	it("finds a broken script inside a page", () => {
		const html =
			"<body><script>\nfoo.forEach(e=>{if(e){bar();}};\n});\n</script></body>";

		expect(findScriptSyntaxError("game.html", html)).toContain("SyntaxError");
	});

	it("says nothing about a page whose scripts parse", () => {
		const html =
			"<body><script>\nfoo.forEach(e=>{if(e){bar();}});\n</script></body>";

		expect(findScriptSyntaxError("game.html", html)).toBeUndefined();
	});

	it("says nothing about a page with no script at all", () => {
		expect(
			findScriptSyntaxError("page.html", "<body><p>hi</p></body>"),
		).toBeUndefined();
	});

	// A module body is parsed under different rules -- `import` is a syntax
	// error in a function body -- so reporting on one would be reporting the
	// checker's own limitation as the page's fault.
	it("leaves module scripts to the browser", () => {
		const html =
			'<body><script type="module">\nimport x from "./x.js";\n</script></body>';

		expect(findScriptSyntaxError("page.html", html)).toBeUndefined();
	});

	it("checks a plain script file directly", () => {
		expect(
			findScriptSyntaxError("app.js", "function f(){ return 1; }"),
		).toBeUndefined();
		expect(
			findScriptSyntaxError("app.js", "function f({ return 1; }"),
		).toContain("SyntaxError");
	});

	// Only where a classic-script parse is the right question. A .ts file is
	// not JavaScript, and a report on one would be noise.
	it("declines a language it does not parse", () => {
		expect(
			findScriptSyntaxError("app.ts", "const x: number = ;"),
		).toBeUndefined();
		expect(findScriptSyntaxError("styles.css", "a { color")).toBeUndefined();
	});
});

import { describe, expect, it } from "vitest"
import { describeDelimiterBalance, scanDelimiters } from "./delimiter-balance"

describe("scanDelimiters", () => {
	it("says nothing about balanced code", () => {
		expect(scanDelimiters("function f(a){ return [a, {b: 1}] }")).toEqual([])
	})

	it("names the opener a crossed closer belongs to", () => {
		// `{` opened at column 14 is closed by `)`.
		const [finding] = scanDelimiters("function f(){ if (a) { b(); ) }")
		expect(finding).toMatchObject({
			kind: "mismatch",
			opener: "{",
			openColumn: 22,
			found: ")",
			column: 29,
		})
	})

	it("reports a closer with nothing open", () => {
		expect(scanDelimiters("a();)")).toEqual([{ kind: "unmatched-close", line: 1, column: 5, found: ")" }])
	})

	it("reports an opener that is never closed", () => {
		const [finding] = scanDelimiters("function f(){\n  if (a) {\n}\n")
		expect(finding).toMatchObject({ kind: "unclosed", opener: "{", openLine: 1, openColumn: 13 })
	})

	it("ignores brackets inside strings, comments and regexes", () => {
		const source = [
			'const a = "}}}"',
			"const b = '((('",
			"// ]]] not code",
			"/* {{{ still not code */",
			"const c = /[{(]/.test(x)",
		].join("\n")
		expect(scanDelimiters(source)).toEqual([])
	})

	it("follows a template literal back out of its substitution", () => {
		// The tail after `}` is prose, not code: a lone quote or brace there
		// must not flip the scanner into a string. This is the case that made
		// the scanner disagree with `node --check` on a real file.
		const source = ["const s = `count ${n} isn't ${m} done`", "function f(){ return 1 }"].join("\n")
		expect(scanDelimiters(source)).toEqual([])
	})

	it("handles nested substitutions and braces inside them", () => {
		expect(scanDelimiters("const s = `${ {a: `${b}`}.a }`")).toEqual([])
	})

	it("counts lines and columns from an origin", () => {
		const [finding] = scanDelimiters("a(]", { line: 30, column: 5 })
		expect(finding).toMatchObject({ line: 30, column: 7, found: "]" })
	})
})

describe("describeDelimiterBalance", () => {
	it("returns nothing for a language it does not understand", () => {
		expect(describeDelimiterBalance("notes.md", "# heading ) ) )")).toBeNull()
	})

	it("returns nothing for JSX, which it cannot parse", () => {
		// A false report sends a model to edit a line that was correct, so
		// .tsx is excluded outright rather than guessed at.
		expect(describeDelimiterBalance("View.tsx", "const V = () => <div a={1}>{x}</div>")).toBeNull()
	})

	it("returns nothing when a file balances", () => {
		expect(describeDelimiterBalance("app.ts", "export function f(){ return {a: [1]} }")).toBeNull()
	})

	it("reports the crossing in a .ts file", () => {
		const report = describeDelimiterBalance("app.ts", "function f(){ if (a) { b(); ) }")
		expect(report).toContain("Delimiter scan")
		expect(report).toContain("`{` opened at line 1, column 22 is closed by `)` at line 1, column 29")
	})

	it("scans script bodies in HTML at their real line numbers", () => {
		const html = ["<!DOCTYPE html>", "<body>", "<script>", "function f(){ g(); ) }", "</script>", "</body>"].join("\n")
		const report = describeDelimiterBalance("game.html", html)
		expect(report).toContain("line 4")
	})

	it("skips a script element that only references a source file", () => {
		const html = ['<script src="game.js"></script>', "<p>)))</p>"].join("\n")
		expect(describeDelimiterBalance("game.html", html)).toBeNull()
	})
})

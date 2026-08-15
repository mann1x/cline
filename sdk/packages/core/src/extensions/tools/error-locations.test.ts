import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findErrorLocations, looksLikeFailure } from "./error-locations";

/** A workspace with the named files in it, so resolution has something real. */
function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "cline-errloc-"));
	for (const [name, body] of Object.entries(files)) {
		const full = path.join(root, name);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, body);
	}
	return root;
}

describe("what counts as a failure worth checking", () => {
	it("takes a non-zero exit at its word", () => {
		expect(looksLikeFailure("some output", true)).toBe(true);
	});

	it("catches the tools that fail while exiting zero", () => {
		expect(looksLikeFailure("SyntaxError: Unexpected token )", false)).toBe(
			true,
		);
		expect(looksLikeFailure("Traceback (most recent call last):", false)).toBe(
			true,
		);
		expect(looksLikeFailure("panic: runtime error", false)).toBe(true);
	});

	it("leaves a passing run alone", () => {
		// A green test run names files too, and checking them would cost the
		// model context for nothing.
		expect(looksLikeFailure("12 passed in src/app.test.ts (1.2s)", false)).toBe(
			false,
		);
	});
});

describe("the file an error names, whatever printed it", () => {
	it("reads a python traceback", () => {
		const root = workspace({ "app/main.py": "print(\n" });
		const output = [
			"Traceback (most recent call last):",
			`  File "app/main.py", line 42, in <module>`,
			"SyntaxError: unexpected EOF while parsing",
		].join("\n");
		expect(findErrorLocations(output, root)).toEqual([
			{ path: path.join(root, "app/main.py"), line: 42 },
		]);
	});

	it("reads a rust pointer", () => {
		const root = workspace({ "src/main.rs": "fn main() {\n" });
		const output = [
			"error: this file has an unclosed delimiter",
			" --> src/main.rs:12:5",
		].join("\n");
		expect(findErrorLocations(output, root)).toEqual([
			{ path: path.join(root, "src/main.rs"), line: 12 },
		]);
	});

	it("reads the path:line:column shape gcc, tsc, eslint and go all use", () => {
		const root = workspace({ "src/app.ts": "const a = (1;\n" });
		expect(
			findErrorLocations("src/app.ts:12:5 - error TS1005: ')' expected.", root),
		).toEqual([{ path: path.join(root, "src/app.ts"), line: 12 }]);
	});

	it("reads the parenthesised shape msvc and older tsc use", () => {
		const root = workspace({ "src/app.cs": "class A {\n" });
		expect(
			findErrorLocations("src/app.cs(12,5): error CS1513: } expected", root),
		).toEqual([{ path: path.join(root, "src/app.cs"), line: 12 }]);
	});

	it("reads a node stack frame", () => {
		const root = workspace({ "game.js": "f(\n" });
		const output = [
			"SyntaxError: missing ) after argument list",
			`    at ${path.join(root, "game.js")}:90:382`,
		].join("\n");
		expect(findErrorLocations(output, root)).toEqual([
			{ path: path.join(root, "game.js"), line: 90 },
		]);
	});

	it("names a file it has no checker for, because the host might", () => {
		// Nothing here is language-aware, and it must not become so: whether
		// `.go` can be checked is the checker's question, not this one's.
		const root = workspace({ "cmd/serve.go": "package main\n" });
		expect(
			findErrorLocations("cmd/serve.go:8:2: undefined: foo", root),
		).toEqual([{ path: path.join(root, "cmd/serve.go"), line: 8 }]);
	});

	it("ignores a path that does not exist", () => {
		const root = workspace({ "real.js": "1\n" });
		expect(findErrorLocations("at imagined.js:4:1", root)).toEqual([]);
	});

	it("ignores a file outside the workspace", () => {
		// The toolchain's own sources are in every stack trace and are never
		// the thing to edit.
		const root = workspace({ "real.js": "1\n" });
		const output = "at /usr/lib/node_modules/npm/index.js:1:1";
		expect(findErrorLocations(output, root)).toEqual([]);
	});

	it("ignores a directory that happens to look like a path", () => {
		const root = workspace({ "src/app.ts": "1\n" });
		expect(findErrorLocations("failed in src:1:1", root)).toEqual([]);
	});

	it("does not mistake a url or a version for a file", () => {
		const root = workspace({ "app.js": "1\n" });
		expect(
			findErrorLocations(
				"error: fetch https://example.com:8080/a failed, need node:18.2",
				root,
			),
		).toEqual([]);
	});

	it("names each file once, however often the trace repeats it", () => {
		const root = workspace({ "a.js": "1\n" });
		const output = Array.from(
			{ length: 40 },
			(_, index) => `    at a.js:${index + 1}:1`,
		).join("\n");
		expect(findErrorLocations(output, root)).toEqual([
			{ path: path.join(root, "a.js"), line: 1 },
		]);
	});

	it("stops at two, so a build log does not become a checking spree", () => {
		const root = workspace({
			"a.js": "1\n",
			"b.js": "1\n",
			"c.js": "1\n",
			"d.js": "1\n",
		});
		const output = ["a.js:1:1", "b.js:2:1", "c.js:3:1", "d.js:4:1"]
			.map((at) => `error at ${at}`)
			.join("\n");
		expect(findErrorLocations(output, root)).toHaveLength(2);
	});

	it("survives being called twice with the same patterns", () => {
		// The patterns are module-level and carry `g`; a leftover lastIndex
		// would make the second call of a session find less than the first.
		const root = workspace({ "a.js": "1\n" });
		const output = "error at a.js:7:1";
		expect(findErrorLocations(output, root)).toEqual(
			findErrorLocations(output, root),
		);
	});
});

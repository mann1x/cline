/**
 * Where a grammar is looked for, and in what order.
 *
 * This is the half of the complexity feature that decides whether it works at
 * all in the shipped extension: the VSIX has no `node_modules`, so the build
 * copies the wasm files next to the bundle and the only thing that finds them
 * is the middle branch below. Getting the order wrong does not fail a build or
 * throw at runtime -- it makes the measurement silent, which reads as "this
 * code is simple".
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grammarFor, resolveGrammarPath } from "./grammars";

function bundleDirWith(grammar: string): string {
	const dir = mkdtempSync(join(tmpdir(), "grammars-"));
	mkdirSync(join(dir, "grammars"));
	writeFileSync(join(dir, "grammars", `tree-sitter-${grammar}.wasm`), "stub");
	return dir;
}

describe("grammarFor", () => {
	it("maps the extensions the walker claims to handle", () => {
		expect(grammarFor("a.tsx")).toBe("tsx");
		expect(grammarFor("a.mjs")).toBe("javascript");
		expect(grammarFor("Main.JAVA")).toBe("java");
		expect(grammarFor("page.html")).toBe("html");
	});

	it("answers nothing for a language nothing ships a grammar for", () => {
		expect(grammarFor("notes.txt")).toBeUndefined();
		expect(grammarFor("Makefile")).toBeUndefined();
	});
});

describe("resolveGrammarPath", () => {
	it("takes an explicit directory over everything else", () => {
		const beside = bundleDirWith("javascript");
		expect(resolveGrammarPath("javascript", "/elsewhere", beside)).toBe(
			join("/elsewhere", "tree-sitter-javascript.wasm"),
		);
	});

	it("finds the grammars the build copied next to the bundle", () => {
		// The VSIX case: no node_modules, so this branch is the only one that
		// can answer, and it has to win without being told.
		const beside = bundleDirWith("javascript");
		expect(resolveGrammarPath("javascript", undefined, beside)).toBe(
			join(beside, "grammars", "tree-sitter-javascript.wasm"),
		);
	});

	it("falls back to the package when nothing sits beside the bundle", () => {
		const empty = mkdtempSync(join(tmpdir(), "grammars-empty-"));
		const resolved = resolveGrammarPath("javascript", undefined, empty);
		expect(resolved).toContain("tree-sitter-javascript.wasm");
		expect(resolved).not.toContain(empty);
	});

	it("answers nothing rather than throwing when there is no package either", () => {
		const empty = mkdtempSync(join(tmpdir(), "grammars-empty-"));
		expect(
			resolveGrammarPath("nosuchlanguage", undefined, empty),
		).toBeUndefined();
	});
});

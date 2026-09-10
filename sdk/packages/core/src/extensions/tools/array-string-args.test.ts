import { validateWithZod } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { normalizeRunCommandsInput } from "./helpers";
import {
	parseArrayString,
	SearchCodebaseUnionInputSchema,
	TRUNCATED_ARRAY_MESSAGE,
} from "./schemas";

/** The same entry point `search_codebase` uses in definitions.ts. */
const searchInput = (input: unknown) =>
	validateWithZod(SearchCodebaseUnionInputSchema, input);

/**
 * The arguments a jackdelta-9b session actually sent, verbatim from its
 * transcript. Six searches and one command, all of them a serialised array
 * that had lost its closing bracket.
 */
const TRUNCATED_QUERIES =
	'["Math.random()<", "Math.random()>", "~~(Math.random()", "new (window.AudioContext"';
const TRUNCATED_COMMANDS =
	"[\"powershell -Command \\\"(Get-Content 'c:\\\\test\\\\manic_miner.html') -join '\\\\n'\"";

describe("parseArrayString", () => {
	it("reads a list that was sent as text", () => {
		expect(parseArrayString('["a", "b"]')).toEqual({ list: ["a", "b"] });
	});

	it("calls an unclosed array truncated rather than guessing at it", () => {
		expect(parseArrayString(TRUNCATED_QUERIES)).toEqual({ truncated: true });
	});

	// A pattern may contain anything, and most patterns are not lists. The
	// bracket alone is not enough: `[a-z]+` is a character class and
	// `[ -f x ] && y` is a shell test, and an earlier version of this refused
	// both.
	it("leaves an ordinary string alone", () => {
		expect(parseArrayString("Math.random()<")).toBeUndefined();
		expect(parseArrayString("[a-z]+")).toBeUndefined();
		expect(parseArrayString("[ -f package.json ] && echo yes")).toBeUndefined();
		expect(parseArrayString('["a", 3]')).toBeUndefined();
	});
});

describe("search_codebase with a list sent as text", () => {
	it("splits a well-formed one into its entries", () => {
		expect(searchInput({ queries: '["alpha", "beta"]' }).queries).toEqual([
			"alpha",
			"beta",
		]);
	});

	// What actually happened: the whole literal became one regex, `[` opened a
	// character class, and the tool reported "Unterminated character class" —
	// which reads as an escaping problem and is not one.
	it("names a truncated one instead of searching for its text", () => {
		expect(() => searchInput({ queries: TRUNCATED_QUERIES })).toThrow(
			/JSON array/,
		);
	});

	it("still takes a single pattern as a single pattern", () => {
		expect(searchInput({ queries: "Math.random()<" }).queries).toEqual([
			"Math.random()<",
		]);
		expect(searchInput({ query: "startPlayerDrag" }).queries).toEqual([
			"startPlayerDrag",
		]);
	});
});

describe("run_commands with a list sent as text", () => {
	it("splits a well-formed one into its entries", () => {
		expect(
			normalizeRunCommandsInput({ commands: '["echo one", "echo two"]' }),
		).toEqual(["echo one", "echo two"]);
	});

	// Worse here than in search: a shell will happily start something out of
	// the first token of a malformed literal.
	it("refuses a truncated one rather than running its text", () => {
		expect(() =>
			normalizeRunCommandsInput({ commands: TRUNCATED_COMMANDS }),
		).toThrow(/JSON array/);
	});

	it("leaves a command that merely starts with a bracket alone", () => {
		expect(
			normalizeRunCommandsInput({
				commands: "[ -f package.json ] && echo yes",
			}),
		).toEqual(["[ -f package.json ] && echo yes"]);
		expect(
			normalizeRunCommandsInput("[ -f package.json ] && echo yes"),
		).toEqual(["[ -f package.json ] && echo yes"]);
	});

	it("still takes the shapes it always did", () => {
		expect(normalizeRunCommandsInput({ commands: ["echo one"] })).toEqual([
			"echo one",
		]);
		expect(normalizeRunCommandsInput("echo one")).toEqual(["echo one"]);
	});
});

describe("the message", () => {
	it("says what to send instead", () => {
		expect(TRUNCATED_ARRAY_MESSAGE).toContain("actual array of strings");
	});
});

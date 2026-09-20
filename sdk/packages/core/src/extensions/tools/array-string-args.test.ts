import { validateWithZod } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { normalizeRunCommandsInput } from "./helpers";
import {
	AwkInputUnionSchema,
	GrepInputUnionSchema,
	MALFORMED_ARRAY_MESSAGE,
	parseArrayString,
	SearchCodebaseUnionInputSchema,
	SedInputUnionSchema,
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
		expect(parseArrayString(TRUNCATED_QUERIES)).toMatchObject({
			refused: expect.any(String),
		});
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
		expect(MALFORMED_ARRAY_MESSAGE).toContain("actual array of strings");
	});
});

/**
 * The 69 payloads that reached this guard across eight runs of the 2026-09-17
 * compaction-tail A/B, classified by why `JSON.parse` refused them.
 *
 * The filed reading was that these were truncated, and for 20 of the 69 it is:
 * no closing bracket, cut mid-argument. The other 49 arrive **closed** and are
 * a different fault -- the model wrote a shell command, full of quotes,
 * backslashes and regexes, into a JSON array inside a JSON string, and escaped
 * it once instead of twice. Refusing those as "truncated" told the model to do
 * the thing it believed it had already done, and the same run made the same
 * mistake 56 times.
 *
 * Two of those classes have exactly one reading and are taken; the rest are
 * refused with the reason, because a shell command guessed at is a shell
 * command run.
 */
describe("a list sent as text that will not parse", () => {
	// A lone backslash cannot be valid JSON, so it can only ever have been a
	// literal one -- which is what `\s` in a regex is.
	const REGEX_BACKSLASH = String.raw`["grep -v '^\s*<script' manic_miner.html"]`;

	// No separator anywhere, so there is one entry and no way to split it
	// wrongly: every quote inside it is part of the command.
	const BARE_QUOTES = String.raw`["awk '/^class /{print NR": "$0}' manic.html"]`;

	// The same shape, but the quotes were escaped properly -- they have to come
	// back as quotes, not as backslash-quote.
	const ESCAPED_QUOTES = String.raw`["sed -n '82p' f.html | grep \"ffaa00\""]`;

	// The same command with its last two characters lost. It still ends `]`,
	// so only the trailing lone backslash says it was cut.
	const CUT_MID_ESCAPE = String.raw`["sed -n '82p' f.html | grep \"ffaa00\]`;

	// Two entries and bare quotes inside them: where one ends and the next
	// begins is a guess, and guessing wrong runs a command nobody wrote.
	const AMBIGUOUS = String.raw`["echo "one"","echo "two""]`;

	it("takes a backslash that could only have been literal", () => {
		expect(parseArrayString(REGEX_BACKSLASH)).toEqual({
			list: [String.raw`grep -v '^\s*<script' manic_miner.html`],
		});
	});

	it("takes a newline that was written into the string raw", () => {
		expect(parseArrayString('["echo one\necho two"]')).toEqual({
			list: ["echo one\necho two"],
		});
	});

	it("takes a single entry whose quotes were never escaped", () => {
		expect(parseArrayString(BARE_QUOTES)).toEqual({
			list: [String.raw`awk '/^class /{print NR": "$0}' manic.html`],
		});
	});

	it("still decodes the escapes in a single entry", () => {
		expect(parseArrayString(ESCAPED_QUOTES)).toEqual({
			list: [`sed -n '82p' f.html | grep "ffaa00"`],
		});
	});

	it("refuses a single entry that ends on a lone backslash", () => {
		const reading = parseArrayString(CUT_MID_ESCAPE);
		expect(reading).toMatchObject({ refused: expect.any(String) });
	});

	it("refuses a list it would have to guess the boundaries of", () => {
		expect(parseArrayString(AMBIGUOUS)).toMatchObject({
			refused: expect.any(String),
		});
	});

	it("refuses an unclosed array, as it always did", () => {
		expect(parseArrayString(TRUNCATED_QUERIES)).toMatchObject({
			refused: expect.any(String),
		});
	});

	// The old message named a cause that was wrong seven times in ten and gave
	// the model nothing to act on -- it already believed it had sent an array.
	it("says where it broke, not just that it did", () => {
		const reading = parseArrayString(AMBIGUOUS);
		const refused = (reading as { refused: string }).refused;
		expect(refused).toContain("actual array of strings");
		expect(refused).toMatch(/position \d+/);
		expect(refused).toContain("echo");
	});
});

/**
 * The shapes measured across 240 pandorum plugin sessions and 365 harness runs
 * (2026-09-17). Each one is a real payload that reached a tool and was refused
 * for its container rather than its content: the pattern, the path and the
 * program were all fine.
 */
describe("list arguments sent as a bare string", () => {
	it("takes a single path for grep, which advertises an array", () => {
		expect(
			validateWithZod(GrepInputUnionSchema, {
				pattern: "collide",
				paths: "src/game.js",
			}),
		).toMatchObject({ pattern: "collide", paths: ["src/game.js"] });
	});

	it("still refuses a truncated array of paths by name", () => {
		expect(() =>
			validateWithZod(GrepInputUnionSchema, {
				pattern: "collide",
				paths: '["src/game.js", "src/level.js"',
			}),
		).toThrow(MALFORMED_ARRAY_MESSAGE);
	});

	it("takes a single file for sed", () => {
		expect(
			validateWithZod(SedInputUnionSchema, {
				script: "s/foo/bar/g",
				files: "manic_miner.html",
			}),
		).toMatchObject({ files: ["manic_miner.html"] });
	});

	it("takes a single file for awk", () => {
		expect(
			validateWithZod(AwkInputUnionSchema, {
				program: "{print $1}",
				files: "manic_miner.html",
			}),
		).toMatchObject({ files: ["manic_miner.html"] });
	});
});

/**
 * `{"queries":[{"query":"..."}]}` — the one search_codebase shape the six-way
 * union did not cover. Measured in both corpora: the model wraps each query in
 * an object because the field is named `queries`, gets `✖ Invalid input`, and
 * has nothing in the message to correct against.
 */
describe("search_codebase queries as an array of objects", () => {
	it("unwraps {query} entries", () => {
		expect(
			searchInput({ queries: [{ query: "collide" }, { query: "jump" }] }),
		).toMatchObject({ queries: ["collide", "jump"] });
	});

	it("unwraps {pattern} entries, the other name models reach for", () => {
		expect(searchInput({ queries: [{ pattern: "collide" }] })).toMatchObject({
			queries: ["collide"],
		});
	});

	it("keeps the option fields riding alongside", () => {
		expect(
			searchInput({ queries: [{ query: "collide" }], max_per_file: 10 }),
		).toMatchObject({ queries: ["collide"], max_per_file: 10 });
	});
});

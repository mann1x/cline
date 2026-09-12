import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runAwkProgram } from "./awk";
import { parseAwk } from "./awk-parser";

const run = (
	program: string,
	input: string,
	options: { fieldSeparator?: string; variables?: Record<string, string> } = {},
) => runAwkProgram(parseAwk(program), input, options).output;

const TABLE = "alice 30 engineer\nbob 25 designer\ncarol 41 engineer\n";

describe("the programs a model actually writes", () => {
	it("prints a field", () => {
		expect(run("{print $1}", TABLE)).toBe("alice\nbob\ncarol\n");
	});

	it("prints the whole record with a bare print", () => {
		expect(run("{print}", "one\ntwo\n")).toBe("one\ntwo\n");
	});

	it("prints the record for a bare pattern", () => {
		expect(run("/bob/", TABLE)).toBe("bob 25 designer\n");
	});

	it("filters numerically on a field", () => {
		expect(run("$2 > 28 {print $1}", TABLE)).toBe("alice\ncarol\n");
	});

	it("sums a column and prints it in END", () => {
		expect(run("{sum += $2} END {print sum}", TABLE)).toBe("96\n");
	});

	it("skips a header with NR", () => {
		expect(run("NR > 1 {print $1}", TABLE)).toBe("bob\ncarol\n");
	});

	it("prints the line number and the line", () => {
		expect(run('/engineer/ {print NR": "$0}', TABLE)).toBe(
			"1: alice 30 engineer\n3: carol 41 engineer\n",
		);
	});

	it("uses a field separator", () => {
		expect(run("{print $2}", "a,b,c\nd,e,f\n", { fieldSeparator: "," })).toBe(
			"b\ne\n",
		);
	});

	it("counts with NF", () => {
		expect(run("{print NF}", TABLE)).toBe("3\n3\n3\n");
	});

	it("takes a variable from -v", () => {
		expect(run("{print x, $1}", "a\n", { variables: { x: "7" } })).toBe(
			"7 a\n",
		);
	});

	it("runs a BEGIN-only program with no input", () => {
		expect(run("BEGIN {print 1 + 1}", "")).toBe("2\n");
	});
});

describe("awk's typing, where getting it wrong is silent", () => {
	// The failure being prevented: a lexical comparison that returns the wrong
	// rows and looks like a working filter.
	it("compares numeric-looking fields as numbers", () => {
		expect(run("$1 > 9 {print $1}", "10\n9\n100\n")).toBe("10\n100\n");
	});

	it("compares non-numeric strings as strings", () => {
		expect(run('$1 > "b" {print $1}', "a\nc\n")).toBe("c\n");
	});

	it("treats an empty field as false and '0' as false", () => {
		expect(run('$1 {print "yes"}', "0\n1\n\n")).toBe("yes\n");
	});

	it("takes the numeric prefix of a string in arithmetic", () => {
		expect(run('BEGIN {print "12abc" + 0}', "")).toBe("12\n");
		expect(run('BEGIN {print "abc" + 0}', "")).toBe("0\n");
	});
});

describe("expressions", () => {
	it("concatenates by juxtaposition", () => {
		expect(run('BEGIN {print "a" "b" 1 + 1}', "")).toBe("ab2\n");
	});

	it("does arithmetic with the right precedence", () => {
		expect(run("BEGIN {print 2 + 3 * 4}", "")).toBe("14\n");
		expect(run("BEGIN {print 2 ^ 3 ^ 2}", "")).toBe("512\n");
	});

	it("supports ++, -- and compound assignment", () => {
		expect(run("BEGIN {x = 5; x += 3; print x++; print x}", "")).toBe("8\n9\n");
	});

	it("supports the ternary", () => {
		expect(run('BEGIN {print 1 ? "y" : "n"}', "")).toBe("y\n");
	});

	it("matches with ~ and !~", () => {
		expect(run("$0 ~ /eng/ {print $1}", TABLE)).toBe("alice\ncarol\n");
		expect(run("$0 !~ /eng/ {print $1}", TABLE)).toBe("bob\n");
	});

	it("reads a slash as division after a value", () => {
		// The classic lexer trap: `a / b / c` is arithmetic, not a regex.
		expect(run("BEGIN {a = 12; b = 2; c = 3; print a / b / c}", "")).toBe(
			"2\n",
		);
	});
});

describe("control flow", () => {
	it("runs if/else", () => {
		expect(run('{if ($2 > 28) print "old"; else print "young"}', TABLE)).toBe(
			"old\nyoung\nold\n",
		);
	});

	it("runs a counted for loop", () => {
		expect(run("BEGIN {for (i = 1; i <= 3; i++) print i}", "")).toBe(
			"1\n2\n3\n",
		);
	});

	it("runs while with break and continue", () => {
		expect(
			run(
				"BEGIN {i = 0; while (i < 5) {i++; if (i == 2) continue; if (i == 4) break; print i}}",
				"",
			),
		).toBe("1\n3\n");
	});

	it("skips a record with next", () => {
		expect(run("/bob/ {next} {print $1}", TABLE)).toBe("alice\ncarol\n");
	});

	it("stops with exit but still runs END", () => {
		expect(run('{print $1; exit} END {print "done"}', TABLE)).toBe(
			"alice\ndone\n",
		);
	});
});

describe("arrays", () => {
	it("counts by key and iterates with for-in", () => {
		const output = run(
			"{count[$3]++} END {for (k in count) print k, count[k]}",
			TABLE,
		);
		expect(output).toContain("engineer 2");
		expect(output).toContain("designer 1");
	});

	it("tests membership with in", () => {
		expect(run('BEGIN {a["x"] = 1; if ("x" in a) print "yes"}', "")).toBe(
			"yes\n",
		);
	});

	it("deletes an element", () => {
		expect(
			run(
				'BEGIN {a["x"] = 1; delete a["x"]; print ("x" in a) ? "still" : "gone"}',
				"",
			),
		).toBe("gone\n");
	});
});

describe("built-in functions", () => {
	it("length, toupper and tolower", () => {
		expect(
			run('BEGIN {print length("hello"), toupper("ab"), tolower("CD")}', ""),
		).toBe("5 AB cd\n");
	});

	it("substr is 1-based and clamps", () => {
		expect(run('BEGIN {print substr("hello", 2, 3)}', "")).toBe("ell\n");
		expect(run('BEGIN {print substr("hello", 2)}', "")).toBe("ello\n");
	});

	it("index is 1-based and 0 when absent", () => {
		expect(
			run('BEGIN {print index("hello", "ll"), index("hello", "z")}', ""),
		).toBe("3 0\n");
	});

	it("split fills an array and returns the count", () => {
		expect(
			run('BEGIN {n = split("a:b:c", parts, ":"); print n, parts[2]}', ""),
		).toBe("3 b\n");
	});

	it("gsub replaces and returns the count", () => {
		expect(
			run('BEGIN {s = "aaa"; n = gsub(/a/, "b", s); print n, s}', ""),
		).toBe("3 bbb\n");
	});

	it("sub replaces only the first", () => {
		expect(run('BEGIN {s = "aaa"; sub(/a/, "b", s); print s}', "")).toBe(
			"baa\n",
		);
	});

	it("& in a replacement is the matched text", () => {
		expect(run('BEGIN {s = "cat"; sub(/cat/, "[&]", s); print s}', "")).toBe(
			"[cat]\n",
		);
	});

	it("match sets RSTART and RLENGTH", () => {
		expect(run('BEGIN {match("hello", /ll/); print RSTART, RLENGTH}', "")).toBe(
			"3 2\n",
		);
	});

	it("printf formats", () => {
		expect(
			run('BEGIN {printf "%5.2f|%-4s|%03d\\n", 3.14159, "ab", 7}', ""),
		).toBe(" 3.14|ab  |007\n");
	});
});

describe("refusing rather than pretending", () => {
	it("refuses user-defined functions by name", () => {
		expect(() => parseAwk("function f(x) {return x}")).toThrow(
			/User-defined functions/,
		);
	});

	it("refuses getline", () => {
		expect(() => parseAwk("{getline line}")).toThrow(/getline/);
	});

	it("refuses output redirection and says what to use instead", () => {
		expect(() => parseAwk('{print $1 > "out.txt"}')).toThrow(/not supported/);
	});

	it("refuses a pipe to a command", () => {
		expect(() => parseAwk('{print $1 | "sort"}')).toThrow(/Piping output/);
	});

	it("reports an unterminated string", () => {
		expect(() => parseAwk('BEGIN {print "abc}')).toThrow(/Unterminated string/);
	});

	it("reports an unparsable program as not valid awk", () => {
		expect(() => parseAwk("{print $}")).toThrow();
	});
});

/**
 * Differential test against the system `awk`.
 *
 * Same reasoning as the sed one: the whole claim is that this behaves like the
 * awk a model already knows, and that is only worth something if it is checked
 * against the real thing. Skipped where there is no `awk`.
 */
describe("agreeing with the system awk", () => {
	const input = "alice 30 engineer\nbob 25 designer\ncarol 41 engineer\n";
	const cases: { program: string; fs?: string }[] = [
		{ program: "{print $1}" },
		{ program: "{print}" },
		{ program: "{print $2, $1}" },
		{ program: "{print NF, NR}" },
		{ program: "$2 > 28 {print $1}" },
		{ program: "$2 >= 30 {print $1}" },
		{ program: "NR > 1 {print $1}" },
		{ program: "/engineer/ {print $1}" },
		{ program: "$0 ~ /eng/ {print $1}" },
		{ program: "$0 !~ /eng/ {print $1}" },
		{ program: "{sum += $2} END {print sum}" },
		{ program: "{count[$3]++} END {for (k in count) print k, count[k]}" },
		{ program: 'BEGIN {print "x" "y" 1 + 1}' },
		{ program: "BEGIN {print 2 + 3 * 4}" },
		{ program: 'BEGIN {print substr("hello", 2, 3)}' },
		{ program: 'BEGIN {print index("hello", "ll")}' },
		{ program: 'BEGIN {n = split("a:b:c", p, ":"); print n, p[2]}' },
		{ program: 'BEGIN {s = "aaa"; print gsub(/a/, "b", s), s}' },
		{ program: 'BEGIN {printf "%5.2f|%-4s|%03d\\n", 3.14159, "ab", 7}' },
		{ program: "BEGIN {for (i = 1; i <= 3; i++) print i}" },
		{ program: '{if ($2 > 28) print "old"; else print "young"}' },
		{ program: "/bob/ {next} {print $1}" },
		{ program: '{print $1; exit} END {print "done"}' },
		{ program: "{print toupper($1)}" },
		{ program: '{print NR": "$0}' },
		{ program: "{print $2}", fs: "," },
	];

	it("matches the system awk on a grid of programs", () => {
		const probe = spawnSync("awk", ["--version"], { encoding: "utf8" });
		// mawk answers -W version on stderr and exits non-zero; accept either.
		const available = !probe.error;
		if (!available) {
			return;
		}

		const commaInput = "a,b,c\nd,e,f\n";
		const mismatches: string[] = [];
		let compared = 0;
		for (const testCase of cases) {
			const args = testCase.fs
				? ["-F", testCase.fs, testCase.program]
				: [testCase.program];
			const text = testCase.fs ? commaInput : input;
			const real = spawnSync("awk", args, { input: text, encoding: "utf8" });
			if (real.status !== 0) {
				continue;
			}
			let ours: string;
			try {
				ours = runAwkProgram(parseAwk(testCase.program), text, {
					...(testCase.fs ? { fieldSeparator: testCase.fs } : {}),
				}).output;
			} catch (error) {
				mismatches.push(
					`${testCase.program}: ours threw ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}
			compared += 1;
			// for-in order is unspecified in awk, so compare as a set of lines.
			const normalize = (text_: string) => text_.split("\n").sort().join("\n");
			const same = testCase.program.includes("for (k in")
				? normalize(ours) === normalize(real.stdout)
				: ours === real.stdout;
			if (!same) {
				mismatches.push(
					`${JSON.stringify(testCase.program)}: awk ${JSON.stringify(real.stdout)} vs ours ${JSON.stringify(ours)}`,
				);
			}
		}
		expect(mismatches).toEqual([]);
		// A differential test that quietly compared nothing would pass forever.
		expect(compared).toBeGreaterThanOrEqual(cases.length - 3);
	});
});

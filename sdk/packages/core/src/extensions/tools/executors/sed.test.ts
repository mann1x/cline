import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadReceipts } from "./read-receipts";
import { createSedExecutor, parseSedScript, runSedScript } from "./sed";

const run = (input: string, script: string, quiet = false, extended = false) =>
	runSedScript(input, parseSedScript(script, extended), quiet).output;

describe("substitution", () => {
	it("replaces the first occurrence on each line by default", () => {
		expect(run("foo foo\nfoo\n", "s/foo/bar/")).toBe("bar foo\nbar\n");
	});

	it("replaces every occurrence with the g flag", () => {
		expect(run("foo foo\n", "s/foo/bar/g")).toBe("bar bar\n");
	});

	it("replaces only the Nth occurrence with a numeric flag", () => {
		expect(run("a a a\n", "s/a/X/2")).toBe("a X a\n");
	});

	it("honours the I flag for case", () => {
		expect(run("FOO\n", "s/foo/bar/I")).toBe("bar\n");
	});

	it("expands & as the whole match", () => {
		expect(run("cat\n", "s/cat/[&]/")).toBe("[cat]\n");
	});

	it("expands \\1 as a capture group", () => {
		expect(run("john smith\n", "s/\\(\\w*\\) \\(\\w*\\)/\\2 \\1/")).toBe(
			"smith john\n",
		);
	});

	it("does not treat $ in the replacement as a JavaScript group", () => {
		// `$&` and `$1` are JavaScript's spelling, not sed's; a replacement
		// containing them must come through literally.
		expect(run("a\n", "s/a/$1/")).toBe("$1\n");
	});

	it("accepts an alternative delimiter, which is how paths are edited", () => {
		expect(run("/usr/bin\n", "s#/usr#/opt#")).toBe("/opt/bin\n");
	});

	it("takes an escaped delimiter as a literal", () => {
		expect(run("a/b\n", "s/a\\/b/X/")).toBe("X\n");
	});
});

describe("addresses", () => {
	const text = "one\ntwo\nthree\nfour\n";

	it("applies to a single line number", () => {
		expect(run(text, "2s/.*/X/")).toBe("one\nX\nthree\nfour\n");
	});

	it("applies to $ as the last line", () => {
		expect(run(text, "$s/.*/X/")).toBe("one\ntwo\nthree\nX\n");
	});

	it("applies to a line range", () => {
		expect(run(text, "2,3d")).toBe("one\nfour\n");
	});

	it("applies to a regex address", () => {
		expect(run(text, "/two/d")).toBe("one\nthree\nfour\n");
	});

	it("applies to a regex range", () => {
		expect(run(text, "/two/,/three/d")).toBe("one\nfour\n");
	});

	it("inverts with !", () => {
		expect(run(text, "2!d")).toBe("two\n");
	});
});

describe("the -n and p combination, which is how a model prints a slice", () => {
	it("prints only what p selects", () => {
		expect(run("one\ntwo\nthree\n", "2p", true)).toBe("two\n");
	});

	it("prints a range", () => {
		expect(run("a\nb\nc\nd\n", "2,3p", true)).toBe("b\nc\n");
	});

	it("prints nothing when quiet and nothing matched", () => {
		expect(run("a\nb\n", "/zzz/p", true)).toBe("");
	});
});

describe("other commands", () => {
	it("deletes with d", () => {
		expect(run("a\nb\n", "/a/d")).toBe("b\n");
	});

	it("transliterates with y", () => {
		expect(run("abc\n", "y/abc/xyz/")).toBe("xyz\n");
	});

	it("refuses a y whose sides differ in length", () => {
		expect(() => parseSedScript("y/ab/xyz/")).toThrow(/same length/);
	});

	it("quits with q", () => {
		expect(run("a\nb\nc\n", "2q")).toBe("a\nb\n");
	});

	it("appends with a and inserts with i", () => {
		expect(run("x\n", "a after")).toBe("x\nafter\n");
		expect(run("x\n", "i before")).toBe("before\nx\n");
	});

	it("replaces the line with c", () => {
		expect(run("x\ny\n", "1c new")).toBe("new\ny\n");
	});

	it("prints the line number with =", () => {
		expect(run("a\nb\n", "2=", true)).toBe("2\n");
	});
});

describe("refusing rather than silently doing nothing", () => {
	// A script that runs and changes nothing is the worst outcome: the model
	// reads it as "the pattern did not match" and edits something else.
	it("names the hold-space commands it cannot run", () => {
		expect(() => parseSedScript("1h;2G")).toThrow(/hold space/);
	});

	it("names branching", () => {
		expect(() => parseSedScript(":a;ba")).toThrow(
			/branching|not a sed command/,
		);
	});

	it("rejects an unterminated s", () => {
		expect(() => parseSedScript("s/foo/bar")).toThrow(/Unterminated/);
	});

	it("says grouping is unsupported and what to do instead", () => {
		expect(() => parseSedScript("/x/{s/a/b/}")).toThrow(/separately/);
	});
});

describe("BRE by default, ERE with extended", () => {
	it("treats a+ as literal in BRE", () => {
		expect(run("a+\n", "s/a+/X/")).toBe("X\n");
	});

	it("treats a+ as a quantifier in ERE", () => {
		expect(run("aaa\n", "s/a+/X/", false, true)).toBe("X\n");
	});
});

describe("file handling and the read guard", () => {
	let dir: string;
	let file: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), "sed-test-"));
		file = join(dir, "sample.txt");
		await fs.writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("reads without the guard and does not modify the file", async () => {
		const sed = createSedExecutor({ cwd: dir, receipts: createReadReceipts() });
		const [outcome] = await sed({ script: "s/alpha/ALPHA/", files: [file] });

		expect(outcome.ok).toBe(true);
		expect(outcome.output).toContain("ALPHA");
		expect(await fs.readFile(file, "utf8")).toBe("alpha\nbeta\ngamma\n");
	});

	it("refuses an in-place edit of a file that has never been read", async () => {
		const sed = createSedExecutor({ cwd: dir, receipts: createReadReceipts() });
		const [outcome] = await sed({
			script: "s/alpha/ALPHA/",
			files: [file],
			in_place: true,
		});

		// The flag, not just the prose: a refusal that reports `ok` is a refusal
		// the tool layer above reports to the model as a completed edit.
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toContain("not modified");
		expect(outcome.error).toContain("has not been read in this session");
		expect(await fs.readFile(file, "utf8")).toBe("alpha\nbeta\ngamma\n");
	});

	it("allows an in-place edit once the file has been read", async () => {
		const receipts = createReadReceipts();
		receipts.noteRead(file, 1, Number.POSITIVE_INFINITY);
		const sed = createSedExecutor({ cwd: dir, receipts });

		const [outcome] = await sed({
			script: "s/alpha/ALPHA/",
			files: [file],
			in_place: true,
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.output).toContain("written");
		expect(await fs.readFile(file, "utf8")).toBe("ALPHA\nbeta\ngamma\n");
	});

	it("checks the addressed lines when the script is addressed by line", async () => {
		const receipts = createReadReceipts();
		// Read only line 1; the script edits line 3.
		receipts.noteRead(file, 1, 1);
		const sed = createSedExecutor({ cwd: dir, receipts });

		const [outcome] = await sed({
			script: "3s/gamma/GAMMA/",
			files: [file],
			in_place: true,
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.error).toContain("would change line 3");
		expect(await fs.readFile(file, "utf8")).toBe("alpha\nbeta\ngamma\n");
	});

	it("accepts an address range that runs past the end of the file", async () => {
		// Lines 4-99 do not exist, so no read can return them; the guard asks
		// only for the lines that do, as `editor` does.
		const receipts = createReadReceipts();
		receipts.noteRead(file, 2, 3);
		const sed = createSedExecutor({ cwd: dir, receipts });

		const [outcome] = await sed({
			script: "2,99d",
			files: [file],
			in_place: true,
		});

		expect(outcome.ok).toBe(true);
		expect(await fs.readFile(file, "utf8")).toBe("alpha\n");
	});

	it("retires the receipts when an edit changes the line count", async () => {
		const receipts = createReadReceipts();
		receipts.noteRead(file, 1, Number.POSITIVE_INFINITY);
		const sed = createSedExecutor({ cwd: dir, receipts });

		await sed({ script: "/beta/d", files: [file], in_place: true });

		expect(await fs.readFile(file, "utf8")).toBe("alpha\ngamma\n");
		// The line count moved, so line-anchored reads are no longer valid.
		expect(receipts.covers(file, 1, 3)).toBe(false);
	});

	it("a read-only run records the read, so a later edit is not refused", async () => {
		const receipts = createReadReceipts();
		const sed = createSedExecutor({ cwd: dir, receipts });

		await sed({ script: "s/alpha/x/", files: [file] });
		const [outcome] = await sed({
			script: "s/alpha/ALPHA/",
			files: [file],
			in_place: true,
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.output).toContain("written");
	});

	it("reports each file separately when they do not share a fate", async () => {
		const other = join(dir, "other.txt");
		await fs.writeFile(other, "alpha\n", "utf8");
		const receipts = createReadReceipts();
		// One read, one not.
		receipts.noteRead(file, 1, Number.POSITIVE_INFINITY);
		const sed = createSedExecutor({ cwd: dir, receipts });

		const outcomes = await sed({
			script: "s/alpha/ALPHA/",
			files: [file, other],
			in_place: true,
		});

		expect(outcomes).toHaveLength(2);
		expect(outcomes[0].ok).toBe(true);
		expect(outcomes[1].ok).toBe(false);
		expect(await fs.readFile(file, "utf8")).toBe("ALPHA\nbeta\ngamma\n");
		expect(await fs.readFile(other, "utf8")).toBe("alpha\n");
	});

	it("says so when the script matched nothing rather than claiming a write", async () => {
		const receipts = createReadReceipts();
		receipts.noteRead(file, 1, Number.POSITIVE_INFINITY);
		const sed = createSedExecutor({ cwd: dir, receipts });

		const [outcome] = await sed({
			script: "s/nowhere/x/",
			files: [file],
			in_place: true,
		});

		// A script that matched nothing ran correctly. Reporting it as a failure
		// invites the model to send the identical call again.
		expect(outcome.ok).toBe(true);
		expect(outcome.output).toContain("no change");
	});
});

/**
 * Differential test against the system `sed`.
 *
 * The claim this tool makes is that it behaves like the sed a model already
 * knows. That claim is only worth anything if it is checked against the real
 * thing rather than against my reading of the spec — two of the expectations
 * in this file were wrong about trailing newlines until GNU sed 4.7 settled
 * it. Skipped where there is no `sed`, which includes Windows.
 */
describe("agreeing with the system sed", () => {
	const cases: { script: string; quiet?: boolean; extended?: boolean }[] = [
		{ script: "s/foo/bar/" },
		{ script: "s/o/0/g" },
		{ script: "s/o/0/2" },
		{ script: "2d" },
		{ script: "2,3d" },
		{ script: "/foo/d" },
		{ script: "$d" },
		{ script: "2!d" },
		{ script: "2p", quiet: true },
		{ script: "1,2p", quiet: true },
		{ script: "/foo/p", quiet: true },
		{ script: "=", quiet: true },
		{ script: "y/of/OF/" },
		{ script: "2q" },
		{ script: "s/\\(f\\)oo/\\1X/" },
		{ script: "s/f+/X/" },
		{ script: "s/f+/X/", extended: true },
		{ script: "s/o*/X/" },
		{ script: "s/^/> /" },
		{ script: "s/$/!/" },
		{ script: "s/[[:alpha:]]/./g" },
	];

	const input = "foo bar\nsecond foo\nthird line\nfoo\n";

	it("matches GNU sed on a grid of scripts", async () => {
		const { spawnSync } = await import("node:child_process");
		const probe = spawnSync("sed", ["--version"], { encoding: "utf8" });
		if (probe.error || probe.status !== 0) {
			return;
		}

		const mismatches: string[] = [];
		let compared = 0;
		for (const testCase of cases) {
			// A script with a backslash cannot be compared on Windows. The `sed`
			// that answers `--version` there is the MSYS one from Git for
			// Windows, and its argv conversion eats the backslashes before sed
			// sees them: `s/\(f\)oo/\1X/` arrives as `s/(f)oo/1X/`, matches
			// nothing, and the input comes back unchanged. That is a fact about
			// the argument, not about either implementation.
			if (process.platform === "win32" && testCase.script.includes("\\")) {
				continue;
			}
			const args: string[] = [];
			if (testCase.quiet) {
				args.push("-n");
			}
			if (testCase.extended) {
				args.push("-E");
			}
			args.push(testCase.script);
			const real = spawnSync("sed", args, { input, encoding: "utf8" });
			if (real.status !== 0) {
				continue;
			}
			const ours = runSedScript(
				input,
				parseSedScript(testCase.script, testCase.extended === true),
				testCase.quiet === true,
			).output;
			compared += 1;
			if (ours !== real.stdout) {
				mismatches.push(
					`${JSON.stringify(args.join(" "))}: sed ${JSON.stringify(real.stdout)} vs ours ${JSON.stringify(ours)}`,
				);
			}
		}
		expect(mismatches).toEqual([]);
		// A differential test that quietly compared nothing would pass forever.
		expect(compared).toBeGreaterThanOrEqual(cases.length - 2);
	});
});

// Written out rather than asked of a system sed at test time: the grid above
// returns early where no sed is installed and so passes having compared
// nothing. These are GNU sed 4.7's answers, each one a case this tool got
// wrong -- the first two deleted the rest of the file in place.
const GNU_4_7: Array<[string, string]> = [
	[
		"/line5/,3d",
		"line1\nline2\nline3\nline4\nline6\nline7\nline8\nline9\nline10\n",
	],
	["7,3d", "line1\nline2\nline3\nline4\nline5\nline6\nline8\nline9\nline10\n"],
	["0,/line2/d", "line3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n"],
	["1,/line1/d", ""],
	["2,+2d", "line1\nline5\nline6\nline7\nline8\nline9\nline10\n"],
	["3,~4d", "line1\nline2\nline5\nline6\nline7\nline8\nline9\nline10\n"],
	["4,~4d", "line1\nline2\nline3\nline9\nline10\n"],
	["1~3d", "line2\nline3\nline5\nline6\nline8\nline9\n"],
	["0~4d", "line1\nline2\nline3\nline5\nline6\nline7\nline9\nline10\n"],
	[
		"s/line/\\U&/",
		"LINE1\nLINE2\nLINE3\nLINE4\nLINE5\nLINE6\nLINE7\nLINE8\nLINE9\nLINE10\n",
	],
	[
		"s/\\(l\\)\\(ine\\)/\\u\\1\\U\\2\\E!/",
		"LINE!1\nLINE!2\nLINE!3\nLINE!4\nLINE!5\nLINE!6\nLINE!7\nLINE!8\nLINE!9\nLINE!10\n",
	],
	["2,4c\\NEW", "line1\nNEW\nline5\nline6\nline7\nline8\nline9\nline10\n"],
	["2,4!c\\X", "X\nline2\nline3\nline4\nX\nX\nX\nX\nX\nX\n"],
	["5!d", "line5\n"],
	["$d", "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\n"],
	["/line3/,/line5/d", "line1\nline2\nline6\nline7\nline8\nline9\nline10\n"],
	["/line3/,/line3/d", "line1\nline2\n"],
	[
		"1a\\    indented",
		"line1\n    indented\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n",
	],
	[
		"/line2/,+1s/line/L/",
		"line1\nL2\nL3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n",
	],
	["3q", "line1\nline2\nline3\n"],
	["2,/line9/!d", "line2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\n"],
	[
		"/line8/,2p",
		"line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline8\nline9\nline10\n",
	],
];

describe("GNU sed's range and replacement rules", () => {
	const input = Array.from({ length: 10 }, (_, i) => `line${i + 1}\n`).join("");
	for (const [script, expected] of GNU_4_7) {
		it(`agrees with GNU sed on ${script}`, () => {
			expect(runSedScript(input, parseSedScript(script)).output).toBe(expected);
		});
	}

	it("refuses line 0 except as 0,/regex/", () => {
		expect(() => parseSedScript("0,5d")).toThrow(/0,\/regex\//);
		expect(() => parseSedScript("+2d")).toThrow(/after a comma/);
	});

	it("says a substitution that wrote the same text matched", () => {
		const result = runSedScript("x\n", parseSedScript("s/x/x/"));
		expect(result.changed).toBe(false);
		expect(result.matched).toBe(true);
	});
});

describe("a backward range in place", () => {
	let work: string;
	beforeEach(async () => {
		work = await fs.mkdtemp(join(tmpdir(), "sed-backward-"));
	});
	afterEach(async () => {
		await fs.rm(work, { recursive: true, force: true });
	});

	it("deletes the one line, not the rest of the file", async () => {
		const target = join(work, "f.txt");
		const text = Array.from({ length: 10 }, (_, i) => `line${i + 1}\n`).join(
			"",
		);
		await fs.writeFile(target, text, "utf8");
		const receipts = createReadReceipts();
		receipts.noteRead(target, 1, Number.POSITIVE_INFINITY);
		const sed = createSedExecutor({ cwd: work, receipts });

		const [outcome] = await sed({
			script: "/line5/,3d",
			files: [target],
			in_place: true,
		});

		expect(outcome.output).toContain("-1 line");
		expect(await fs.readFile(target, "utf8")).toBe(text.replace("line5\n", ""));
	});
});

describe("what a run credits as read", () => {
	let work: string;
	beforeEach(async () => {
		work = await fs.mkdtemp(join(tmpdir(), "sed-credit-"));
	});
	afterEach(async () => {
		await fs.rm(work, { recursive: true, force: true });
	});

	it("credits the lines -n p printed, not the whole file", async () => {
		const target = join(work, "f.txt");
		await fs.writeFile(target, "a\nb\nneedle\nd\ne\n", "utf8");
		const receipts = createReadReceipts();
		const sed = createSedExecutor({ cwd: work, receipts });

		await sed({ script: "/needle/p", files: [target], quiet: true });

		expect(receipts.covers(target, 3, 3)).toBe(true);
		expect(receipts.covers(target, 1, 5)).toBe(false);
	});

	it("checks a negated command against the whole file, not the line it names", async () => {
		const target = join(work, "f.txt");
		await fs.writeFile(target, "a\nb\nc\n", "utf8");
		const receipts = createReadReceipts();
		receipts.noteRead(target, 2, 2);
		const sed = createSedExecutor({ cwd: work, receipts });

		const [outcome] = await sed({
			script: "2!d",
			files: [target],
			in_place: true,
		});

		expect(outcome.ok).toBe(false);
		expect(await fs.readFile(target, "utf8")).toBe("a\nb\nc\n");
	});
});

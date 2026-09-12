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
		expect(outcome.error).toContain("lines 3-3");
		expect(await fs.readFile(file, "utf8")).toBe("alpha\nbeta\ngamma\n");
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

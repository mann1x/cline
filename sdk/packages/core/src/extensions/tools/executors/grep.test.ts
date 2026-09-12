import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepExecutor, type GrepInput } from "./grep";
import { createReadReceipts } from "./read-receipts";

const SAMPLE = [
	"the quick brown fox",
	"jumps over the lazy dog",
	"THE QUICK BROWN FOX",
	"nothing here",
	"the end",
].join("\n");

describe("grep", () => {
	let dir: string;
	let file: string;
	let grep: (input: GrepInput) => Promise<string>;

	beforeEach(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), "grep-test-"));
		file = join(dir, "sample.txt");
		await fs.writeFile(file, `${SAMPLE}\n`, "utf8");
		grep = createGrepExecutor({ cwd: dir, receipts: createReadReceipts() });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("finds matching lines with their numbers", async () => {
		const output = await grep({ pattern: "the", paths: ["sample.txt"] });
		expect(output).toContain("sample.txt:1:the quick brown fox");
		expect(output).toContain("sample.txt:2:jumps over the lazy dog");
		expect(output).toContain("sample.txt:5:the end");
		expect(output).not.toContain("THE QUICK");
	});

	it("ignores case when asked", async () => {
		const output = await grep({
			pattern: "the",
			paths: ["sample.txt"],
			ignore_case: true,
		});
		expect(output).toContain("THE QUICK BROWN FOX");
	});

	it("inverts the match", async () => {
		const output = await grep({
			pattern: "the",
			paths: ["sample.txt"],
			invert: true,
		});
		expect(output).toContain("nothing here");
		expect(output).not.toContain("the end");
	});

	it("counts instead of listing", async () => {
		const output = await grep({
			pattern: "the",
			paths: ["sample.txt"],
			count: true,
		});
		expect(output).toContain("sample.txt:3");
	});

	it("lists only the file names", async () => {
		const output = await grep({
			pattern: "the",
			paths: ["sample.txt"],
			files_with_matches: true,
		});
		expect(output).toContain("sample.txt");
		expect(output).not.toContain("quick");
	});

	it("stops after max_count matches", async () => {
		const output = await grep({
			pattern: "the",
			paths: ["sample.txt"],
			max_count: 1,
		});
		expect(output).toContain("sample.txt:1:");
		expect(output).not.toContain("sample.txt:5:");
	});

	it("matches whole words only", async () => {
		await fs.writeFile(join(dir, "words.txt"), "cat\nconcatenate\n", "utf8");
		const output = await grep({
			pattern: "cat",
			paths: ["words.txt"],
			word: true,
		});
		expect(output).toContain("words.txt:1:cat");
		expect(output).not.toContain("concatenate");
	});

	it("treats the pattern literally when fixed", async () => {
		await fs.writeFile(join(dir, "dots.txt"), "a.c\nabc\n", "utf8");
		const output = await grep({
			pattern: "a.c",
			paths: ["dots.txt"],
			fixed: true,
		});
		expect(output).toContain("dots.txt:1:a.c");
		expect(output).not.toContain("abc");
	});

	it("uses BRE by default and ERE when asked", async () => {
		await fs.writeFile(join(dir, "plus.txt"), "a+\naaa\n", "utf8");
		const bre = await grep({ pattern: "a+", paths: ["plus.txt"] });
		expect(bre).toContain("plus.txt:1:a+");
		expect(bre).not.toContain("aaa");

		const ere = await grep({
			pattern: "a+",
			paths: ["plus.txt"],
			extended: true,
		});
		expect(ere).toContain("aaa");
	});

	it("shows context either side", async () => {
		const output = await grep({
			pattern: "nothing",
			paths: ["sample.txt"],
			context: 1,
		});
		// A context line is separated with `-`, a match with `:`, as in grep.
		expect(output).toContain("sample.txt-3-THE QUICK BROWN FOX");
		expect(output).toContain("sample.txt:4:nothing here");
		expect(output).toContain("sample.txt-5-the end");
	});

	it("searches a directory recursively and skips node_modules", async () => {
		await fs.mkdir(join(dir, "src"), { recursive: true });
		await fs.mkdir(join(dir, "node_modules"), { recursive: true });
		await fs.writeFile(join(dir, "src", "a.ts"), "needle here\n", "utf8");
		await fs.writeFile(
			join(dir, "node_modules", "b.ts"),
			"needle here\n",
			"utf8",
		);

		const output = await grep({ pattern: "needle" });
		expect(output).toContain("a.ts");
		expect(output).not.toContain("node_modules");
	});

	it("says an empty result is an answer rather than failing", async () => {
		const output = await grep({ pattern: "zzzz", paths: ["sample.txt"] });
		expect(output).toContain("No match");
		expect(output).toContain("zzzz");
	});

	it("skips a binary file rather than printing it", async () => {
		await fs.writeFile(
			join(dir, "blob.bin"),
			Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]),
		);
		const output = await grep({ pattern: "needle", paths: ["blob.bin"] });
		expect(output).toContain("No match");
	});

	it("records the read, so a later edit is not refused", async () => {
		const receipts = createReadReceipts();
		const scoped = createGrepExecutor({ cwd: dir, receipts });
		await scoped({ pattern: "the", paths: ["sample.txt"] });
		expect(receipts.hasEverRead(file)).toBe(true);
	});

	it("reports an invalid pattern in the dialect it was read as", async () => {
		await expect(
			grep({ pattern: "a\\(b", paths: ["sample.txt"] }),
		).rejects.toThrow(/basic regular expression/);
	});
});

/**
 * Differential test against the system `grep`.
 *
 * Only the line content is compared, not grep's own prefixes: this tool always
 * prefixes the path and defaults `-n` on, which is a deliberate difference for
 * an agent reading the output. What has to agree is which lines match.
 */
describe("agreeing with the system grep on which lines match", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), "grep-diff-"));
		await fs.writeFile(join(dir, "sample.txt"), `${SAMPLE}\n`, "utf8");
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("matches on a grid of patterns and flags", async () => {
		const probe = spawnSync("grep", ["--version"], { encoding: "utf8" });
		if (probe.error || probe.status !== 0) {
			return;
		}

		const cases: { pattern: string; flags: string[]; input: GrepInput }[] = [
			{ pattern: "the", flags: [], input: {} as GrepInput },
			{
				pattern: "the",
				flags: ["-i"],
				input: { ignore_case: true } as GrepInput,
			},
			{ pattern: "the", flags: ["-v"], input: { invert: true } as GrepInput },
			{ pattern: "^the", flags: [], input: {} as GrepInput },
			{ pattern: "dog$", flags: [], input: {} as GrepInput },
			{ pattern: "qu.ck", flags: [], input: {} as GrepInput },
			{ pattern: "o\\+", flags: [], input: {} as GrepInput },
			{ pattern: "o+", flags: ["-E"], input: { extended: true } as GrepInput },
			{ pattern: "the", flags: ["-w"], input: { word: true } as GrepInput },
			{ pattern: "[[:upper:]]", flags: [], input: {} as GrepInput },
			{ pattern: "fox\\|dog", flags: [], input: {} as GrepInput },
			{
				pattern: "fox|dog",
				flags: ["-E"],
				input: { extended: true } as GrepInput,
			},
		];

		const grep = createGrepExecutor({ cwd: dir });
		const mismatches: string[] = [];
		let compared = 0;

		for (const testCase of cases) {
			const real = spawnSync(
				"grep",
				[...testCase.flags, testCase.pattern, "sample.txt"],
				{ cwd: dir, encoding: "utf8" },
			);
			// grep exits 1 for "no match", which is not an error here.
			if (real.status !== 0 && real.status !== 1) {
				continue;
			}
			const realLines = real.stdout.split("\n").filter((line) => line !== "");

			const ours = await grep({
				...testCase.input,
				pattern: testCase.pattern,
				paths: ["sample.txt"],
			});
			const ourLines = ours.startsWith("No match")
				? []
				: ours
						.split("\n")
						.slice(2)
						.filter((line) => line !== "")
						// Strip the `sample.txt:NN:` prefix this tool adds.
						.map((line) => line.replace(/^sample\.txt:\d+:/, ""));

			compared += 1;
			if (JSON.stringify(ourLines) !== JSON.stringify(realLines)) {
				mismatches.push(
					`${testCase.flags.join(" ")} ${JSON.stringify(testCase.pattern)}: grep ${JSON.stringify(realLines)} vs ours ${JSON.stringify(ourLines)}`,
				);
			}
		}

		expect(mismatches).toEqual([]);
		expect(compared).toBeGreaterThanOrEqual(cases.length - 2);
	});
});

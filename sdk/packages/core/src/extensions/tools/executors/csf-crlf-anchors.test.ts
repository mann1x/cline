import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAwkProgram } from "./awk";
import { parseAwk } from "./awk-parser";
import { createGrepExecutor } from "./grep";
import { createReadReceipts } from "./read-receipts";
import { createSedExecutor, parseSedScript, runSedScript } from "./sed";

const CRLF = "alpha\r\nbeta\r\ngamma\r\n";

// csf-19: sed, grep and awk split the file on "\n", so every line of a
// CRLF file kept its trailing "\r". A "$" anchor therefore sat after the
// "\r" and never matched: the model could see the text it was searching
// for while the tool kept answering "No match" / "no change — the script
// matched nothing". The editor is CRLF-correct; these three were not.
describe("csf-19: end-of-line anchors on CRLF files", () => {
	it("sed matches an $-anchored substitution", () => {
		const result = runSedScript(CRLF, parseSedScript("s/beta$/BETA/"));
		expect(result.changed).toBe(true);
		expect(result.output).toBe("alpha\r\nBETA\r\ngamma\r\n");
	});

	it("sed keeps the file's CRLF endings for a/i/c text", () => {
		const result = runSedScript(CRLF, parseSedScript("2a inserted"));
		expect(result.output).toBe("alpha\r\nbeta\r\ninserted\r\ngamma\r\n");
	});

	it("an in-place sed on a CRLF file matches $ and writes CRLF back", async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), "csf19-sed-"));
		try {
			const file = join(dir, "crlf.txt");
			await fs.writeFile(file, CRLF, "utf8");
			const receipts = createReadReceipts();
			receipts.noteRead(file, 1, Number.POSITIVE_INFINITY);
			const sed = createSedExecutor({ cwd: dir, receipts });
			const [outcome] = await sed({
				script: "s/gamma$/GAMMA/",
				files: [file],
				in_place: true,
			});
			expect(outcome.ok).toBe(true);
			expect(outcome.output).toContain("written");
			expect(await fs.readFile(file, "utf8")).toBe(
				"alpha\r\nbeta\r\nGAMMA\r\n",
			);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("grep matches an $-anchored pattern in a CRLF file", async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), "csf19-grep-"));
		try {
			await fs.writeFile(join(dir, "crlf.txt"), CRLF, "utf8");
			const grep = createGrepExecutor({
				cwd: dir,
				receipts: createReadReceipts(),
			});
			const output = await grep({ pattern: "beta$", paths: ["crlf.txt"] });
			expect(output).toContain("crlf.txt:2:beta");
			expect(output).not.toContain("No match");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("grep still matches an $-anchored pattern in an LF file", async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), "csf19-grep-lf-"));
		try {
			await fs.writeFile(join(dir, "lf.txt"), "alpha\nbeta\ngamma\n", "utf8");
			const grep = createGrepExecutor({
				cwd: dir,
				receipts: createReadReceipts(),
			});
			const output = await grep({ pattern: "beta$", paths: ["lf.txt"] });
			expect(output).toContain("lf.txt:2:beta");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("awk sees the last field without the carriage return", () => {
		const result = runAwkProgram(
			parseAwk('{ if ($NF == "gamma") print NR }'),
			CRLF,
		);
		expect(result.output).toBe("3\n");
	});

	it("awk measures the record without the carriage return", () => {
		const result = runAwkProgram(parseAwk("{ print length($0) }"), CRLF);
		expect(result.output).toBe("5\n4\n5\n");
	});

	it("awk is unchanged on LF input", () => {
		const result = runAwkProgram(parseAwk("{ print $1 }"), "one two\nthree\n");
		expect(result.output).toBe("one\nthree\n");
	});
});

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

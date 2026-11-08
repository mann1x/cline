import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAwkExecutor } from "./awk";
import { createGrepExecutor } from "./grep";
import { createReadReceipts } from "./read-receipts";
import { createSedExecutor } from "./sed";
import { MAX_TEXT_STREAM_BYTES, wholeFileRefusal } from "./whole-file";

// The run that found this: `sed` with `1,10p` on a task's 150,400,128-byte
// compiled test runner, and Node out of heap a second later (exit 134). The
// large file here is sparse, so it costs no disk; read whole, it would cost
// the heap exactly as that one did.
describe("whole-file reads", () => {
	let dir: string;
	let text: string;
	let binary: string;
	let large: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), "whole-file-"));
		text = join(dir, "notes.txt");
		binary = join(dir, "run_tests");
		large = join(dir, "huge.log");
		await fs.writeFile(text, "alpha\nbeta\n");
		await fs.writeFile(
			binary,
			Buffer.concat([Buffer.from("\x7fELF\x02\x01\x01"), Buffer.alloc(64)]),
		);
		await fs.writeFile(large, "");
		await fs.truncate(large, MAX_TEXT_STREAM_BYTES + 1);
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("lets a text file through", async () => {
		expect(await wholeFileRefusal(text, "sed")).toBeUndefined();
	});

	it("refuses a binary by its first bytes", async () => {
		const refusal = await wholeFileRefusal(binary, "sed");
		expect(refusal?.kind).toBe("binary");
		expect(refusal?.message).toContain("binary file");
	});

	it("refuses a file over the limit by its size", async () => {
		const refusal = await wholeFileRefusal(large, "awk");
		expect(refusal?.kind).toBe("size");
		expect(refusal?.message).toContain(`${MAX_TEXT_STREAM_BYTES + 1} bytes`);
	});

	it("leaves a missing file to the caller's own read", async () => {
		expect(await wholeFileRefusal(join(dir, "absent"), "sed")).toBeUndefined();
	});

	it("sed refuses each such file as a failed entry and runs the rest", async () => {
		const sed = createSedExecutor({ cwd: dir, receipts: createReadReceipts() });
		const outcomes = await sed({
			script: "1,10p",
			files: ["run_tests", "huge.log", "notes.txt"],
			quiet: true,
		});
		expect(outcomes.map((o) => o.ok)).toEqual([false, false, true]);
		expect(outcomes[0].error).toContain("binary file");
		expect(outcomes[1].error).toContain("bytes is over");
		expect(outcomes[2].output).toBe("alpha\nbeta\n");
	});

	it("awk refuses them by name", async () => {
		const awk = createAwkExecutor({ cwd: dir });
		expect(await awk({ program: "{print}", files: ["run_tests"] })).toContain(
			"run_tests: not read: it is a binary file",
		);
		expect(await awk({ program: "{print}", files: ["huge.log"] })).toContain(
			"huge.log: not read:",
		);
	});

	// A binary is not printed, but it holds "ELF", and "No match" said it did
	// not. GNU grep answers "Binary file … matches"; so does this.
	it("grep does not print a binary, says whether it matches, and names a large one", async () => {
		const grep = createGrepExecutor({ cwd: dir });
		const elf = await grep({ pattern: "ELF", paths: ["run_tests"] });
		expect(elf).toContain("Binary file run_tests matches");
		expect(elf).not.toContain("No match");
		expect(await grep({ pattern: "x", paths: ["huge.log"] })).toContain(
			"huge.log: not read:",
		);
		const walked = await grep({ pattern: "alpha", paths: ["."] });
		expect(walked).toContain("notes.txt");
		expect(walked).toContain("huge.log: not read:");
		expect(walked).not.toContain("run_tests:");
		expect(walked).not.toContain("Binary file run_tests matches");
	});
});

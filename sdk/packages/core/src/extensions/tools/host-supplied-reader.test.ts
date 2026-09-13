import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadReceipts } from "./executors";
import { createBuiltinTools } from "./index";
import type { ToolOperationResult } from "./types";

/**
 * A host that replaces `read_files` replaces the half of the read-before-write
 * guard that WRITES the record. `grep`, `sed` and `awk` keep reading the
 * registry core built for them -- and if the host did not hand its own over,
 * nothing ever writes to that one.
 *
 * This is not hypothetical. 4.100.105 shipped exactly that shape in the VS Code
 * extension: pandorum session 1789264258103_k7vim called `read_files` on
 * manic_miner.html six times and `sed --in-place` four times, and every `sed`
 * was refused with "has not been read in this session".
 */
describe("a host that supplies its own reader", () => {
	let dir: string;
	let file: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), "host-reader-"));
		file = join(dir, "sample.txt");
		await fs.writeFile(file, "alpha\nbravo\n", "utf8");
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	const buildSed = (receipts?: ReturnType<typeof createReadReceipts>) => {
		const tools = createBuiltinTools({
			cwd: dir,
			enableSed: true,
			...(receipts ? { executorOptions: { receipts } } : {}),
			executors: {
				// Stands in for the extension's workspace-scoped reader: it reads
				// the file and records the read, exactly as the real one does.
				readFile: (async (input: { files: { path: string }[] }) => {
					const results: ToolOperationResult[] = [];
					for (const entry of input.files) {
						const target = join(dir, entry.path);
						const content = await fs.readFile(target, "utf8");
						receipts?.noteRead(target, 1, Number.POSITIVE_INFINITY);
						results.push({ query: entry.path, result: content, success: true });
					}
					return results;
				}) as never,
			},
		});
		const sed = tools.find((tool) => tool.name === "sed");
		if (!sed) throw new Error("sed was not built");
		return sed;
	};

	it("refuses sed when the host keeps its registry to itself", async () => {
		// The shipped bug, pinned: the host read the file, but into a registry
		// core cannot see, so the guard is asked about a history of nothing.
		const sed = buildSed(undefined);
		const outcomes = (await sed.execute(
			{ files: ["sample.txt"], in_place: true, script: "s/alpha/ALPHA/" },
			{} as never,
		)) as ToolOperationResult[];
		expect(outcomes[0]?.success).toBe(false);
		expect(outcomes[0]?.error).toContain("has not been read in this session");
		// And it really did not touch the file.
		expect(await fs.readFile(file, "utf8")).toBe("alpha\nbravo\n");
	});

	it("lets sed through once the host shares the registry it writes to", async () => {
		const receipts = createReadReceipts();
		const sed = buildSed(receipts);
		// The host's reader records the read...
		receipts.noteRead(file, 1, Number.POSITIVE_INFINITY);
		const outcomes = (await sed.execute(
			{ files: ["sample.txt"], in_place: true, script: "s/alpha/ALPHA/" },
			{} as never,
		)) as ToolOperationResult[];
		expect(outcomes[0]?.success).toBe(true);
		expect(await fs.readFile(file, "utf8")).toBe("ALPHA\nbravo\n");
	});
});

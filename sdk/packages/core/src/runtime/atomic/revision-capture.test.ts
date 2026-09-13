import type { AgentTool } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { createRevisionLog } from "./file-revisions";
import { patchTargets, withRevisionCapture } from "./revision-capture";
import type { Snapshot } from "./snapshot";

const ROOT = "/w";
const FILE = "/w/manic_miner.html";

function snapshotOf(
	files: Record<string, string>,
	skipped: string[] = [],
): Snapshot {
	return {
		root: ROOT,
		skipped,
		files: new Map(
			Object.entries(files).map(([p, text]) => [
				p,
				{ hash: text, body: Buffer.from(text, "utf8") },
			]),
		),
	};
}

/** A tool that reports what it was called with and changes nothing itself. */
function tool(name: string, output = "done"): AgentTool {
	return {
		name,
		description: name,
		inputSchema: {},
		execute: async () => output,
	} as unknown as AgentTool;
}

/** A disk the fake tools write to. */
function disk(initial: Record<string, string>) {
	const state = new Map(Object.entries(initial));
	return {
		state,
		readFile: async (p: string) => {
			const text = state.get(p);
			return text === undefined ? undefined : Buffer.from(text, "utf8");
		},
	};
}

function harness(files: Record<string, string>, skipped: string[] = []) {
	const log = createRevisionLog();
	const d = disk(files);
	const source = { pending: snapshotOf(files, skipped), transaction: 1, log };
	return { log, d, source };
}

describe("withRevisionCapture", () => {
	it("seeds the base as #1 and records the write as #2", async () => {
		const { log, d, source } = harness({ [FILE]: "one\n" });
		const [editor] = withRevisionCapture([tool("editor")], {
			source,
			readFile: d.readFile,
		});
		d.state.set(FILE, "two\n");
		await editor?.execute?.({ path: FILE } as never, {} as never);
		expect(log.revisions(FILE).map((r) => r.index)).toEqual([1, 2]);
		expect(log.revisions(FILE)[0]?.body?.toString()).toBe("one\n");
		expect(log.revisions(FILE)[1]?.body?.toString()).toBe("two\n");
	});

	it("records nothing when the tool changed nothing", async () => {
		const { log, d, source } = harness({ [FILE]: "one\n" });
		const [editor] = withRevisionCapture([tool("editor")], {
			source,
			readFile: d.readFile,
		});
		await editor?.execute?.({ path: FILE } as never, {} as never);
		expect(log.revisions(FILE)).toHaveLength(1);
	});

	it("appends the new revision to the tool's own output", async () => {
		const { d, source } = harness({ [FILE]: "one\n" });
		const [editor] = withRevisionCapture([tool("editor", "Edited the file.")], {
			source,
			readFile: d.readFile,
		});
		d.state.set(FILE, "two\n");
		const out = String(
			await editor?.execute?.({ path: FILE } as never, {} as never),
		);
		expect(out).toContain("Edited the file.");
		expect(out).toContain("#2");
		expect(out).toContain("last");
	});

	it("leaves the output alone when no revision was made", async () => {
		const { d, source } = harness({ [FILE]: "one\n" });
		const [editor] = withRevisionCapture([tool("editor", "Nothing matched.")], {
			source,
			readFile: d.readFile,
		});
		const out = String(
			await editor?.execute?.({ path: FILE } as never, {} as never),
		);
		expect(out).toBe("Nothing matched.");
	});

	it("captures sed's files only when it writes them back", async () => {
		const { log, d, source } = harness({ [FILE]: "one\n" });
		const [sed] = withRevisionCapture([tool("sed")], {
			source,
			readFile: d.readFile,
		});
		d.state.set(FILE, "two\n");
		await sed?.execute?.({ files: [FILE] } as never, {} as never);
		expect(log.tracked()).toHaveLength(0);
		await sed?.execute?.(
			{ files: [FILE], in_place: true } as never,
			{} as never,
		);
		expect(log.revisions(FILE).map((r) => r.index)).toEqual([1, 2]);
	});

	it("captures the files an apply_patch payload names", async () => {
		const { log, d, source } = harness({ [FILE]: "one\n" });
		const [patch] = withRevisionCapture([tool("apply_patch")], {
			source,
			readFile: d.readFile,
		});
		d.state.set(FILE, "two\n");
		await patch?.execute?.(
			{
				input: `*** Begin Patch\n*** Update File: manic_miner.html\n@@\n-one\n+two\n*** End Patch`,
			} as never,
			{} as never,
		);
		expect(log.revisions(FILE).map((r) => r.index)).toEqual([1, 2]);
	});

	// run_commands can write anything. Re-walking the tree per call is what the
	// per-file design exists to avoid, so it re-checks only the files the model
	// has already touched -- which is where a `sed -i` or a shell redirect would
	// desync the log and make a later restore resurrect stale content.
	it("re-checks already-tracked files after run_commands, and only those", async () => {
		const { log, d, source } = harness({
			[FILE]: "one\n",
			"/w/other.js": "x\n",
		});
		const [editor, commands] = withRevisionCapture(
			[tool("editor"), tool("run_commands")],
			{ source, readFile: d.readFile },
		);
		d.state.set(FILE, "two\n");
		await editor?.execute?.({ path: FILE } as never, {} as never);
		d.state.set(FILE, "three\n");
		d.state.set("/w/other.js", "y\n");
		await commands?.execute?.({ commands: ["true"] } as never, {} as never);
		expect(log.revisions(FILE).map((r) => r.index)).toEqual([1, 2, 3]);
		expect(log.revisions("/w/other.js")).toHaveLength(0);
	});

	it("records a deletion as a revision with no body", async () => {
		const { log, d, source } = harness({ [FILE]: "one\n" });
		const [editor] = withRevisionCapture([tool("editor")], {
			source,
			readFile: d.readFile,
		});
		d.state.delete(FILE);
		await editor?.execute?.({ path: FILE } as never, {} as never);
		expect(log.revisions(FILE)[1]?.body).toBeUndefined();
	});

	it("does not track a file the snapshot could not hold", async () => {
		const { log, d, source } = harness({}, ["/w/huge.bin"]);
		const [editor] = withRevisionCapture([tool("editor")], {
			source,
			readFile: d.readFile,
		});
		d.state.set("/w/huge.bin", "x");
		await editor?.execute?.({ path: "/w/huge.bin" } as never, {} as never);
		expect(log.tracked()).toHaveLength(0);
	});

	it("does not track a path outside the transaction's root", async () => {
		const { log, d, source } = harness({ [FILE]: "one\n" });
		const [editor] = withRevisionCapture([tool("editor")], {
			source,
			readFile: d.readFile,
		});
		d.state.set("/elsewhere/x.js", "x");
		await editor?.execute?.({ path: "/elsewhere/x.js" } as never, {} as never);
		expect(log.tracked()).toHaveLength(0);
	});

	it("passes everything through untouched when no transaction is open", async () => {
		const log = createRevisionLog();
		const d = disk({ [FILE]: "one\n" });
		const [editor] = withRevisionCapture([tool("editor", "out")], {
			source: { pending: undefined, transaction: 0, log },
			readFile: d.readFile,
		});
		d.state.set(FILE, "two\n");
		expect(
			String(await editor?.execute?.({ path: FILE } as never, {} as never)),
		).toBe("out");
		expect(log.tracked()).toHaveLength(0);
	});

	it("leaves tools that cannot write a file alone", () => {
		const { source, d } = harness({});
		const plain = tool("read_files");
		const [wrapped] = withRevisionCapture([plain], {
			source,
			readFile: d.readFile,
		});
		expect(wrapped).toBe(plain);
	});
});

describe("patchTargets", () => {
	it("reads every file an apply_patch payload names", () => {
		expect(
			patchTargets(
				[
					"*** Begin Patch",
					"*** Update File: a.js",
					"*** Add File: b/c.js",
					"*** Delete File: d.js",
					"*** End Patch",
				].join("\n"),
			),
		).toEqual(["a.js", "b/c.js", "d.js"]);
	});

	it("returns nothing for a payload that names no file", () => {
		expect(patchTargets("*** Begin Patch\n*** End Patch")).toEqual([]);
	});
});

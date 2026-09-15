import { join, resolve } from "node:path";
import type { AgentTool } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { createRevisionLog } from "./file-revisions";
import { patchTargets, withRevisionCapture } from "./revision-capture";
import type { Snapshot } from "./snapshot";

/**
 * The transaction's root, and the way to name a file inside it.
 *
 * `resolveBaseFile` normalizes what the model asked for before looking it up,
 * so the snapshot's keys have to be spelled the way this platform spells them:
 * on Windows a "/w/manic_miner.html" literal normalizes to
 * `\w\manic_miner.html`, misses the map, and thirteen tests report that
 * nothing was captured.
 */
const ROOT = resolve("/w");
const FILE = join(ROOT, "manic_miner.html");
const inRoot = (name: string) => join(ROOT, name);
const OUTSIDE = join(resolve("/elsewhere"), "x.js");

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

	/**
	 * The shapes the tools actually return.
	 *
	 * Every test here used a bare string, and the guard that appends the
	 * revision line only fired on strings -- so the suite was green while the
	 * line reached the model exactly zero times in production. Measured over
	 * three harness runs: 361 write results, 0 carrying a revision number
	 * (`editor` returns `{query, result, success}`, `run_commands` and `sed`
	 * return a list of those).
	 */
	function structured(name: string, text = "done") {
		return {
			name,
			description: name,
			inputSchema: {},
			execute: async () => ({
				query: `${name}:x`,
				result: text,
				success: true,
			}),
		} as unknown as AgentTool;
	}

	function listed(name: string, text = "done") {
		return {
			name,
			description: name,
			inputSchema: {},
			execute: async () => [
				{ query: `${name}:x`, result: text, success: true },
			],
		} as unknown as AgentTool;
	}

	it("tells the model the revision number when the result is an object", async () => {
		const { d, source } = harness({ [FILE]: "one\n" });
		const [editor] = withRevisionCapture(
			[structured("editor", "Replaced line 90")],
			{
				source,
				readFile: d.readFile,
			},
		);
		d.state.set(FILE, "two\n");
		const out = (await editor?.execute?.(
			{ path: FILE } as never,
			{} as never,
		)) as {
			result: string;
		};
		expect(out.result).toContain("Replaced line 90");
		expect(out.result).toContain("#2");
		expect(out.result).toContain("last");
	});

	it("tells the model the revision number when the result is a list", async () => {
		const { d, source } = harness({ [FILE]: "one\n" });
		const [sed] = withRevisionCapture([listed("sed", "written.")], {
			source,
			readFile: d.readFile,
		});
		d.state.set(FILE, "two\n");
		const out = (await sed?.execute?.(
			{ files: [FILE], in_place: true } as never,
			{} as never,
		)) as Array<{ result: string }>;
		expect(out[0]?.result).toContain("written.");
		expect(out[0]?.result).toContain("#2");
	});

	it("uses the model's own sentence as the revision's label", async () => {
		const { log, d, source } = harness({ [FILE]: "one\n" });
		const [editor] = withRevisionCapture(
			[structured("editor", "Replaced line 90")],
			{
				source,
				readFile: d.readFile,
			},
		);
		d.state.set(FILE, "two\n");
		const out = (await editor?.execute?.(
			{ path: FILE, intent: "close the arg list on dDec" } as never,
			{} as never,
		)) as { result: string };
		expect(log.revisions(FILE)[1]?.note).toContain(
			"close the arg list on dDec",
		);
		expect(log.revisions(FILE)[1]?.noteSource).toBe("model");
		expect(out.result).toContain("close the arg list on dDec");
		// Already labelled, so there is nothing to ask for.
		expect(out.result).not.toContain("Send `intent`");
	});

	it("labels the revision itself when the model said nothing, and asks", async () => {
		const { log, d, source } = harness({ [FILE]: "one\n" });
		const [editor] = withRevisionCapture(
			[structured("editor", "Replaced line 90")],
			{
				source,
				readFile: d.readFile,
			},
		);
		d.state.set(FILE, "two\nthree\n");
		const out = (await editor?.execute?.(
			{ path: FILE } as never,
			{} as never,
		)) as {
			result: string;
		};
		const made = log.revisions(FILE)[1];
		// Never unlabelled: the harness works something out from the change.
		expect(made?.note).toBeTruthy();
		expect(made?.note).toContain("Replaced line 90");
		expect(made?.noteSource).toBe("derived");
		expect(out.result).toContain("Send `intent`");
	});

	it("falls back to the line delta when the tool reported nothing usable", async () => {
		const { log, d, source } = harness({ [FILE]: "one\n" });
		const [editor] = withRevisionCapture([structured("editor", "   ")], {
			source,
			readFile: d.readFile,
		});
		d.state.set(FILE, "a\nb\nc\n");
		await editor?.execute?.({ path: FILE } as never, {} as never);
		expect(log.revisions(FILE)[1]?.note).toContain("+2 lines");
	});

	it("appends the checker's verdict without replacing what changed", async () => {
		const { log, d, source } = harness({ [FILE]: "one\n" });
		const [editor] = withRevisionCapture(
			[structured("editor", "Replaced line 90")],
			{
				source,
				readFile: d.readFile,
				lastCheck: () => "SyntaxError: missing ) after argument list",
			},
		);
		d.state.set(FILE, "two\n");
		await editor?.execute?.({ path: FILE } as never, {} as never);
		const note = log.revisions(FILE)[1]?.note ?? "";
		expect(note).toContain("Replaced line 90");
		expect(note).toContain("check: SyntaxError");
	});

	it("offers `intent` on writers that name their file, and not on the others", async () => {
		const { d, source } = harness({ [FILE]: "one\n" });
		const [editor, commands] = withRevisionCapture(
			[tool("editor"), tool("run_commands")],
			{ source, readFile: d.readFile },
		);
		const props = (
			editor?.inputSchema as { properties?: Record<string, unknown> }
		)?.properties;
		expect(props?.intent).toBeDefined();
		const opaque = (
			commands?.inputSchema as { properties?: Record<string, unknown> }
		)?.properties;
		expect(opaque?.intent).toBeUndefined();
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
			[inRoot("other.js")]: "x\n",
		});
		const [editor, commands] = withRevisionCapture(
			[tool("editor"), tool("run_commands")],
			{ source, readFile: d.readFile },
		);
		d.state.set(FILE, "two\n");
		await editor?.execute?.({ path: FILE } as never, {} as never);
		d.state.set(FILE, "three\n");
		d.state.set(inRoot("other.js"), "y\n");
		await commands?.execute?.({ commands: ["true"] } as never, {} as never);
		expect(log.revisions(FILE).map((r) => r.index)).toEqual([1, 2, 3]);
		expect(log.revisions(inRoot("other.js"))).toHaveLength(0);
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
		const { log, d, source } = harness({}, [inRoot("huge.bin")]);
		const [editor] = withRevisionCapture([tool("editor")], {
			source,
			readFile: d.readFile,
		});
		d.state.set(inRoot("huge.bin"), "x");
		await editor?.execute?.({ path: inRoot("huge.bin") } as never, {} as never);
		expect(log.tracked()).toHaveLength(0);
	});

	it("does not track a path outside the transaction's root", async () => {
		const { log, d, source } = harness({ [FILE]: "one\n" });
		const [editor] = withRevisionCapture([tool("editor")], {
			source,
			readFile: d.readFile,
		});
		d.state.set(OUTSIDE, "x");
		await editor?.execute?.({ path: OUTSIDE } as never, {} as never);
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

import { join, resolve } from "node:path";
import type { AgentTool } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { createSessionRevisions } from "./session-revisions";

const ROOT = resolve("/w");
const FILE = join(ROOT, "manic_miner.html");

function writer(name: string, onWrite: () => void): AgentTool {
	return {
		name,
		description: name,
		inputSchema: {},
		execute: async () => {
			onWrite();
			return "done";
		},
	} as unknown as AgentTool;
}

function fakeDisk(initial: Record<string, string>) {
	const state = new Map(Object.entries(initial));
	return {
		state,
		readFile: async (p: string) =>
			state.has(p) ? Buffer.from(state.get(p) as string, "utf8") : undefined,
	};
}

describe("createSessionRevisions", () => {
	it("records a write with no change protocol anywhere", async () => {
		// The whole point. `--atomic off` used to mean no revisions at all, so
		// the ledger's file-history section was empty in exactly the arm that
		// compacts most.
		const disk = fakeDisk({ [FILE]: "one\n" });
		const revisions = createSessionRevisions({
			root: ROOT,
			readFile: disk.readFile,
		});
		const [editor] = revisions.decorate([
			writer("editor", () => disk.state.set(FILE, "two\n")),
		]);

		await editor?.execute?.({ path: FILE } as never, {} as never);

		expect(revisions.port.tracked()).toEqual([FILE]);
		expect(revisions.port.spanFor(FILE)).toBe("#1–#2");
	});

	it("says nothing about a file nothing has written", () => {
		const revisions = createSessionRevisions({ root: ROOT });
		expect(revisions.port.spanFor(FILE)).toBeUndefined();
		expect(revisions.port.tracked()).toEqual([]);
	});

	it("keeps a file the compaction summary still names", async () => {
		// The retention rule the eviction policy rests on: a file written long
		// ago survives while something the model can still read names it.
		const disk = fakeDisk({ [FILE]: "one\n" });
		const revisions = createSessionRevisions({
			root: ROOT,
			readFile: disk.readFile,
		});
		const [editor] = revisions.decorate([
			writer("editor", () => disk.state.set(FILE, "two\n")),
		]);
		await editor?.execute?.({ path: FILE } as never, {} as never);

		revisions.port.noteCompaction([FILE]);
		revisions.port.noteCompaction([FILE]);
		revisions.port.noteCompaction([FILE]);

		expect(revisions.port.spanFor(FILE)).toBe("#1–#2");
	});

	it("releases a file two compactions after its last write", async () => {
		const disk = fakeDisk({ [FILE]: "one\n" });
		const revisions = createSessionRevisions({
			root: ROOT,
			readFile: disk.readFile,
		});
		const [editor] = revisions.decorate([
			writer("editor", () => disk.state.set(FILE, "two\n")),
		]);
		await editor?.execute?.({ path: FILE } as never, {} as never);

		expect(revisions.port.noteCompaction()).toBe(0);
		expect(revisions.port.noteCompaction()).toBe(0);
		// Third span: the summary that could have named `#2` has itself been
		// folded away, so nothing the model can read addresses it.
		expect(revisions.port.noteCompaction()).toBe(1);
		expect(revisions.port.spanFor(FILE)).toBeUndefined();
	});

	it("offers restore_file, described without transactions", () => {
		// The shield itself. `restore_file` was added by the protocol's
		// `decorateTools` and by nothing else, so a session with the protocol
		// off had no way to undo anything — measured on pandorum, where a model
		// that had just overwritten a 133-line file with "test content" checked
		// for git, found none, and asked the user to paste the file back.
		const revisions = createSessionRevisions({ root: ROOT });
		const restore = revisions.tools.find((t) => t.name === "restore_file");

		expect(restore).toBeDefined();
		expect(restore?.description).not.toContain("transaction");
		expect(restore?.description).toContain("before this session first wrote");
	});

	it("lets read_files show an earlier revision, without a transaction", async () => {
		// The cheaper half of recovery, and the half the compaction ledger's
		// addresses are for: `src/parser.ts #1–#7` is only worth printing if the
		// model can go and read #4 without putting the file back.
		const revisions = createSessionRevisions({ root: ROOT });
		const file = join(ROOT, "parser.ts");
		revisions.log.seed(file, Buffer.from("before\n"), "session");
		revisions.log.record(file, Buffer.from("after\n"), "editor");

		const reader = {
			name: "read_files",
			description: "read",
			inputSchema: {},
			execute: async () => [
				{ query: "parser.ts", result: "after", success: true },
			],
		} as unknown as AgentTool;
		const [wrapped] = revisions.decorate([reader]);

		const shown = (await wrapped?.execute?.(
			{ files: [{ path: "parser.ts" }], revision: "#1" } as never,
			{} as never,
		)) as { result: string; success: boolean }[];

		expect(shown[0]?.success).toBe(true);
		expect(shown[0]?.result).toContain("before");
		// And the decoration says so in the description, or the model never
		// learns the parameter exists.
		expect(wrapped?.description).toContain("revision");
	});

	it("leaves a tool that neither reads nor writes a file alone", () => {
		// `read_files` is deliberately not the example: it is decorated too, for
		// the `revision` parameter. Everything else comes back untouched.
		const revisions = createSessionRevisions({ root: ROOT });
		const plain = {
			name: "list_files",
			description: "list",
			inputSchema: {},
			execute: async () => "x",
		} as unknown as AgentTool;
		expect(revisions.decorate([plain])[0]).toBe(plain);
	});

	it("hands the same log out for the change protocol to share", async () => {
		// One log per session, not one per transaction: the protocol is given
		// this object rather than making its own, so a session that turns the
		// protocol on mid-flight keeps the history it already had and the
		// numbering does not restart underneath the model.
		const disk = fakeDisk({ [FILE]: "one\n" });
		const revisions = createSessionRevisions({
			root: ROOT,
			readFile: disk.readFile,
		});
		const [editor] = revisions.decorate([
			writer("editor", () => disk.state.set(FILE, "two\n")),
		]);
		await editor?.execute?.({ path: FILE } as never, {} as never);

		expect(revisions.log.revisions(FILE).map((r) => r.index)).toEqual([1, 2]);
		expect(revisions.log.tracked()).toEqual([FILE]);
	});
});

import type { AgentTool } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import {
	createEditVerificationCompletionGuard,
	EditVerificationTracker,
	extractPaths,
	withEditVerificationCapture,
} from "./edit-verification";

const config = {
	editTools: ["editor", "apply_patch"],
	checkTools: ["check_file"],
};

function tracker() {
	return new EditVerificationTracker(config);
}

describe("reading the paths out of a call", () => {
	// Three tools, three shapes. Reading one would silently cover one tool,
	// which is the failure this module exists to answer.
	it("reads the shape each tool actually sends", () => {
		expect(extractPaths({ path: "src/game.ts" })).toEqual(["src/game.ts"]);
		expect(extractPaths({ paths: ["a.ts", "b.ts"] })).toEqual(["a.ts", "b.ts"]);
		expect(extractPaths({ files: [{ path: "c.ts" }, "d.ts"] })).toEqual([
			"c.ts",
			"d.ts",
		]);
	});

	it("contributes nothing for a shape it does not recognise", () => {
		expect(extractPaths({ target: "e.ts" })).toEqual([]);
		expect(extractPaths({ path: "   " })).toEqual([]);
		expect(extractPaths(undefined)).toEqual([]);
		expect(extractPaths("src/game.ts")).toEqual([]);
	});
});

describe("what counts as checked", () => {
	it("an edit marks a file, a check clears it", () => {
		const t = tracker();
		t.recordToolCall("editor", { path: "src/game.ts" });
		expect(t.getState().unchecked).toEqual(["src/game.ts"]);

		t.recordToolCall("check_file", { paths: ["src/game.ts"] });
		expect(t.getState().unchecked).toEqual([]);
	});

	// The measured sequence: the linter ran once before anything was touched,
	// then four edits landed with nothing checking them.
	it("a check before the edit does not count for the edit", () => {
		const t = tracker();
		t.recordToolCall("check_file", { paths: ["manic_miner.html"] });
		t.recordToolCall("editor", { path: "manic_miner.html" });
		t.recordToolCall("editor", { path: "manic_miner.html" });

		expect(t.getState().unchecked).toEqual(["manic_miner.html"]);
	});

	it("tracks each file separately", () => {
		const t = tracker();
		t.recordToolCall("editor", { path: "a.ts" });
		t.recordToolCall("apply_patch", { path: "b.ts" });
		t.recordToolCall("check_file", { paths: ["a.ts"] });

		expect(t.getState().unchecked).toEqual(["b.ts"]);
	});

	// A model that edits `src/game.ts` and checks `./src/game.ts` means the
	// same file and should not be nagged for it.
	it("does not nag over separator and prefix noise", () => {
		const t = tracker();
		t.recordToolCall("editor", { path: "src\\game.ts" });
		t.recordToolCall("check_file", { paths: ["./src/game.ts"] });

		expect(t.getState().unchecked).toEqual([]);
	});

	it("ignores tools that neither edit nor check", () => {
		const t = tracker();
		t.recordToolCall("read_files", { files: [{ path: "a.ts" }] });
		expect(t.getState().unchecked).toEqual([]);
	});
});

describe("holding the run back", () => {
	it("names the files, then asks once more, then stands aside", () => {
		const t = tracker();
		const guard = createEditVerificationCompletionGuard(t, config);
		t.recordToolCall("editor", { path: "manic_miner.html" });

		const first = guard();
		expect(first).toContain("manic_miner.html");
		expect(first).toContain("check_file");

		const second = guard();
		expect(second).toContain("last time you will be asked");

		// Two refusals is a warning; a third would be an argument.
		expect(guard()).toBeUndefined();
	});

	it("lets a run end when everything edited has been checked", () => {
		const t = tracker();
		const guard = createEditVerificationCompletionGuard(t, config);
		t.recordToolCall("editor", { path: "a.ts" });
		t.recordToolCall("check_file", { paths: ["a.ts"] });

		expect(guard()).toBeUndefined();
	});

	it("lets a run end when nothing was edited at all", () => {
		expect(createEditVerificationCompletionGuard(tracker(), config)()).toBeUndefined();
	});

	// A host with no linter must not get a guard that can never be satisfied.
	it("stands aside entirely when the host named no checker", () => {
		const bare = { editTools: ["editor"], checkTools: [] };
		const t = new EditVerificationTracker(bare);
		t.recordToolCall("editor", { path: "a.ts" });

		expect(createEditVerificationCompletionGuard(t, bare)()).toBeUndefined();
	});
});

describe("watching a tool's calls", () => {
	function fakeTool(name: string): AgentTool<{ path: string }, string> {
		return {
			name,
			description: name,
			inputSchema: { type: "object", properties: {} },
			execute: vi.fn(async () => "done"),
		} as unknown as AgentTool<{ path: string }, string>;
	}

	it("records the call and returns the tool's own result untouched", async () => {
		const t = tracker();
		const wrapped = withEditVerificationCapture(fakeTool("editor"), t);

		await expect(wrapped.execute({ path: "a.ts" }, {} as never)).resolves.toBe(
			"done",
		);
		expect(t.getState().unchecked).toEqual(["a.ts"]);
	});

	// A failed edit still touched the file: the tool may have written part of
	// it, and a guard that trusted `success` would be answering a different
	// question than "has anyone looked at this file".
	it("counts an edit that threw", async () => {
		const t = tracker();
		const failing = {
			...fakeTool("editor"),
			execute: async () => {
				throw new Error("No change");
			},
		} as unknown as AgentTool<{ path: string }, string>;
		const wrapped = withEditVerificationCapture(failing, t);

		await expect(
			wrapped.execute({ path: "a.ts" }, {} as never),
		).rejects.toThrow("No change");
		expect(t.getState().unchecked).toEqual(["a.ts"]);
	});

	it("wraps once however many layers ask", async () => {
		const t = tracker();
		const once = withEditVerificationCapture(fakeTool("editor"), t);
		const twice = withEditVerificationCapture(once, t);

		expect(twice).toBe(once);
		await twice.execute({ path: "a.ts" }, {} as never);
		expect(t.getState().unchecked).toEqual(["a.ts"]);
	});
});

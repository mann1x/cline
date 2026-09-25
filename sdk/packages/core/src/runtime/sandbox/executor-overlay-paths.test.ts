import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultExecutors } from "../../extensions/tools/executors";
import { AgentOverlay } from "./overlay-fs";

// A delegated agent works on a private copy of the workspace, but it is told
// only about the workspace: a path into its overlay in any text an executor
// hands back -- a result, a refusal, an error -- is an address it was never
// meant to have, and one it will then read and write directly.
describe("executors over an overlay never show the agent the overlay's path", () => {
	let base: string;
	let ws: string;
	let ov: string;
	let executors: Required<ReturnType<typeof createDefaultExecutors>>;
	const ctx = { agentId: "a", conversationId: "c", iteration: 1 };

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "overlay-paths-"));
		ws = path.join(base, "ws");
		ov = path.join(base, "ov");
		await fs.mkdir(ws, { recursive: true });
		await fs.writeFile(path.join(ws, "a.txt"), "line one\nline two\n");
		const overlay = new AgentOverlay(ws, ov);
		executors = createDefaultExecutors({ overlay }) as Required<
			ReturnType<typeof createDefaultExecutors>
		>;
		// The agent has already changed a.txt, so it lives in the overlay now.
		await overlay.write("a.txt", "line one\nline two changed\n");
	});

	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	/** Everything the agent would see from a call: its result or its error. */
	const seen = async (call: () => Promise<unknown>): Promise<string> => {
		try {
			return JSON.stringify(await call());
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	};

	const expectNoOverlayPath = (text: string) => {
		expect(text.length).toBeGreaterThan(0);
		expect(text).not.toContain(ov);
	};

	it("editor: a read-before-edit refusal names the workspace file", async () => {
		const text = await seen(() =>
			executors.editor(
				{ path: path.join(ws, "a.txt"), new_text: "replaced" },
				ws,
				ctx,
			),
		);
		expect(text).toContain(path.join(ws, "a.txt"));
		expectNoOverlayPath(text);
	});

	it("editor: a stale-read refusal names the workspace file", async () => {
		await executors.readFile({ path: path.join(ws, "a.txt") }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 5));
		await fs.writeFile(path.join(ov, "a.txt"), "someone else\n");
		const text = await seen(() =>
			executors.editor(
				{ path: path.join(ws, "a.txt"), new_text: "replaced" },
				ws,
				ctx,
			),
		);
		expect(text).toContain("changed since");
		expectNoOverlayPath(text);
	});

	it("apply_patch: a hunk that does not match names the workspace file", async () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: a.txt",
			"@@",
			"-no such line",
			"+whatever",
			"*** End Patch",
		].join("\n");
		expectNoOverlayPath(
			await seen(() => executors.applyPatch({ input: patch }, ws, ctx)),
		);
	});

	it("sed: an in-place edit of an unread file names the workspace file", async () => {
		expectNoOverlayPath(
			await seen(() =>
				executors.sed(
					{
						script: "s/one/ONE/",
						files: [path.join(ws, "a.txt")],
						in_place: true,
					},
					ws,
					ctx,
				),
			),
		);
	});

	it("awk: FILENAME is the workspace file", async () => {
		const text = await seen(() =>
			executors.awk(
				{ program: "{ print FILENAME }", files: [path.join(ws, "a.txt")] },
				ws,
				ctx,
			),
		);
		expectNoOverlayPath(text);
	});

	it("grep: a match in a changed file is reported at its workspace path", async () => {
		const text = await seen(() =>
			executors.grep({ pattern: "changed", paths: [ws] }, ws, ctx),
		);
		expect(text).toContain("a.txt");
		expectNoOverlayPath(text);
	});

	it("read_files: a changed file reads back under its workspace path", async () => {
		expectNoOverlayPath(
			await seen(() =>
				executors.readFile({ path: path.join(ws, "a.txt") }, ctx),
			),
		);
	});

	it("read_files: a file the agent deleted fails at its workspace path", async () => {
		await fs.rm(path.join(ov, "a.txt"));
		await fs.writeFile(path.join(ov, ".wh.a.txt"), "");
		const text = await seen(() =>
			executors.readFile({ path: path.join(ws, "a.txt") }, ctx),
		);
		expectNoOverlayPath(text);
	});
});

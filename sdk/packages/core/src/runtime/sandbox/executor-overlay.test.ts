import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApplyPatchExecutor } from "../../extensions/tools/executors/apply-patch";
import { createEditorExecutor } from "../../extensions/tools/executors/editor";
import { createFileReadExecutor } from "../../extensions/tools/executors/file-read";
import { createGrepExecutor } from "../../extensions/tools/executors/grep";
import { createSedExecutor } from "../../extensions/tools/executors/sed";
import { AgentOverlay } from "./overlay-fs";

// The real editor and read executors, driven through an agent overlay: edits
// land in the overlay, the workspace is untouched, and reads see the overlay.
describe("executors over an AgentOverlay", () => {
	let base: string;
	let ws: string;
	let ov: string;
	let overlay: AgentOverlay;
	const ctx = { agentId: "a", conversationId: "c", iteration: 1 };

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "exec-overlay-"));
		ws = path.join(base, "ws");
		ov = path.join(base, "ov");
		await fs.mkdir(ws, { recursive: true });
		await fs.writeFile(path.join(ws, "a.txt"), "ORIG");
		overlay = new AgentOverlay(ws, ov);
	});

	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	it("edits into the overlay, leaving the workspace file untouched", async () => {
		const editor = createEditorExecutor({ overlay, restrictToCwd: false });
		await editor({ path: path.join(ws, "a.txt"), new_text: "EDITED" }, ws, ctx);

		expect((await fs.readFile(path.join(ws, "a.txt"))).toString()).toBe("ORIG");
		expect((await fs.readFile(path.join(ov, "a.txt"))).toString()).toBe(
			"EDITED",
		);
	});

	it("creates a new file only in the overlay", async () => {
		const editor = createEditorExecutor({ overlay, restrictToCwd: false });
		await editor({ path: path.join(ws, "new.txt"), new_text: "NEW" }, ws, ctx);

		await expect(fs.access(path.join(ws, "new.txt"))).rejects.toThrow();
		expect((await fs.readFile(path.join(ov, "new.txt"))).toString()).toBe(
			"NEW",
		);
	});

	it("reads the overlay version after an edit, and the workspace otherwise", async () => {
		const editor = createEditorExecutor({ overlay, restrictToCwd: false });
		const read = createFileReadExecutor({ overlay, cwd: ws });

		await editor({ path: path.join(ws, "a.txt"), new_text: "EDITED" }, ws, ctx);
		const edited = await read({ path: "a.txt" }, ctx);
		expect(JSON.stringify(edited)).toContain("EDITED");

		await fs.writeFile(path.join(ws, "only-ws.txt"), "WSONLY");
		const wsRead = await read({ path: "only-ws.txt" }, ctx);
		expect(JSON.stringify(wsRead)).toContain("WSONLY");
	});

	it("hands back the change set from the overlay", async () => {
		const editor = createEditorExecutor({ overlay, restrictToCwd: false });
		await editor({ path: path.join(ws, "a.txt"), new_text: "EDITED" }, ws, ctx);
		await editor({ path: path.join(ws, "new.txt"), new_text: "NEW" }, ws, ctx);

		const changes = Object.fromEntries(
			(await overlay.changedFiles()).map((c) => [c.rel, c.kind]),
		);
		expect(changes["a.txt"]).toBe("modified");
		expect(changes["new.txt"]).toBe("created");
	});

	it("sed -i writes the overlay, not the workspace", async () => {
		const sed = createSedExecutor({ overlay });
		await sed(
			{
				script: "s/ORIG/SEDDED/",
				files: [path.join(ws, "a.txt")],
				in_place: true,
			},
			ws,
		);
		expect((await fs.readFile(path.join(ws, "a.txt"))).toString()).toBe("ORIG");
		expect((await fs.readFile(path.join(ov, "a.txt"))).toString()).toBe(
			"SEDDED",
		);
	});

	it("apply_patch creates in the overlay, workspace untouched", async () => {
		const apply = createApplyPatchExecutor({ overlay, restrictToCwd: false });
		const patch = [
			"*** Begin Patch",
			"*** Add File: added.txt",
			"+hello from patch",
			"*** End Patch",
		].join("\n");
		await apply({ input: patch }, ws, ctx);
		await expect(fs.access(path.join(ws, "added.txt"))).rejects.toThrow();
		expect(
			(await fs.readFile(path.join(ov, "added.txt"))).toString(),
		).toContain("hello from patch");
	});

	it("grep sees an overlay-only new file and not a deleted one", async () => {
		await overlay.write("fresh.txt", "needle here");
		await overlay.unlink("a.txt");
		const grep = createGrepExecutor({ overlay });
		const hit = await grep({ pattern: "needle", paths: [ws] }, ws);
		expect(hit).toContain("fresh.txt");
		const gone = await grep({ pattern: "ORIG", paths: [ws] }, ws);
		expect(gone).not.toContain("a.txt");
	});
});

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentOverlay, WHITEOUT_PREFIX } from "./overlay-fs";

describe("AgentOverlay", () => {
	let ws: string;
	let ov: string;
	let overlay: AgentOverlay;

	beforeEach(async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "overlay-"));
		ws = path.join(base, "ws");
		ov = path.join(base, "ov");
		await fs.mkdir(ws, { recursive: true });
		await fs.mkdir(path.join(ws, "sub"), { recursive: true });
		await fs.writeFile(path.join(ws, "a.txt"), "A");
		await fs.writeFile(path.join(ws, "b.txt"), "B");
		await fs.writeFile(path.join(ws, "c.txt"), "C");
		overlay = new AgentOverlay(ws, ov);
	});

	afterEach(async () => {
		await fs.rm(path.dirname(ws), { recursive: true, force: true });
	});

	it("reads a workspace-only file by falling through", async () => {
		expect((await overlay.read("a.txt")).toString()).toBe("A");
		// A pure read must not copy anything into the overlay.
		expect(await fs.readdir(ov).catch(() => [])).toEqual([]);
	});

	it("isolates a write: the workspace file is untouched", async () => {
		await overlay.write("b.txt", "B-EDIT");
		expect((await overlay.read("b.txt")).toString()).toBe("B-EDIT");
		expect((await fs.readFile(path.join(ws, "b.txt"))).toString()).toBe("B"); // real ws intact
		expect((await fs.readFile(path.join(ov, "b.txt"))).toString()).toBe(
			"B-EDIT",
		);
	});

	it("creates a new nested file only in the overlay", async () => {
		await overlay.write("sub/new.txt", "NEW");
		expect(await overlay.exists("sub/new.txt")).toBe(true);
		await expect(fs.access(path.join(ws, "sub", "new.txt"))).rejects.toThrow();
	});

	it("deletes via a whiteout, leaving the workspace file", async () => {
		await overlay.unlink("c.txt");
		expect((await fs.readFile(path.join(ws, "c.txt"))).toString()).toBe("C"); // survives
		expect(await overlay.exists("c.txt")).toBe(false);
		await expect(overlay.read("c.txt")).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(await fs.readdir(ov)).toContain(`${WHITEOUT_PREFIX}c.txt`);
	});

	it("re-creating a deleted file drops the whiteout", async () => {
		await overlay.unlink("c.txt");
		await overlay.write("c.txt", "C2");
		expect(await overlay.exists("c.txt")).toBe(true);
		expect((await overlay.read("c.txt")).toString()).toBe("C2");
		expect(await fs.readdir(ov)).not.toContain(`${WHITEOUT_PREFIX}c.txt`);
	});

	it("renames within the overlay and whiteouts the source", async () => {
		await overlay.rename("a.txt", "renamed.txt");
		expect((await fs.readFile(path.join(ws, "a.txt"))).toString()).toBe("A"); // ws intact
		expect(await overlay.exists("a.txt")).toBe(false);
		expect((await overlay.read("renamed.txt")).toString()).toBe("A");
	});

	it("merges directory listings, minus whiteouts and markers", async () => {
		await overlay.write("b.txt", "B-EDIT"); // copied up
		await overlay.write("d.txt", "D"); // overlay only
		await overlay.unlink("c.txt"); // whiteouted
		const names = await overlay.readdir(".");
		expect(names).toEqual(["a.txt", "b.txt", "d.txt", "sub"]);
		expect(names).not.toContain("c.txt");
		expect(names.some((n) => n.startsWith(WHITEOUT_PREFIX))).toBe(false);
	});

	it("reports the change set for the hand-back", async () => {
		await overlay.write("b.txt", "B-EDIT");
		await overlay.write("sub/new.txt", "NEW");
		await overlay.unlink("c.txt");
		const changes = await overlay.changedFiles();
		const byRel = Object.fromEntries(changes.map((c) => [c.rel, c.kind]));
		expect(byRel["b.txt"]).toBe("modified");
		expect(byRel["sub/new.txt"]).toBe("created");
		expect(byRel["c.txt"]).toBe("deleted");
	});
});

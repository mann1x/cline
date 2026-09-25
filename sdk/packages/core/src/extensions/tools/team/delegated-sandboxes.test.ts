import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createRevisionLog,
	type RevisionLog,
} from "../../../runtime/atomic/file-revisions";
import { createDelegatedSandboxes } from "./delegated-sandboxes";

describe("createDelegatedSandboxes", () => {
	let base: string;
	let ws: string;
	let overlays: string;
	let log: RevisionLog;

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "delegated-sandboxes-"));
		ws = path.join(base, "ws");
		overlays = path.join(base, "overlays");
		await fs.mkdir(ws, { recursive: true });
		await fs.mkdir(overlays, { recursive: true });
		await fs.writeFile(path.join(ws, "a.txt"), "ORIG");
		log = createRevisionLog();
	});

	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	const sandboxes = (launcher = false, commandsEnabled = false) =>
		createDelegatedSandboxes({
			provider: {
				workspaceRoot: ws,
				overlayRootFor: (id) =>
					path.join(overlays, id.replace(/[^A-Za-z0-9_.-]/g, "_")),
				...(launcher
					? {
							binaries: {
								launcher: "/nonexistent/launcher",
								hook: "/nonexistent/launcher",
								platforms: [process.platform],
							},
						}
					: {}),
			},
			commandsEnabled,
			revisionLog: () => log,
		});

	it("allows commands only with a launcher for this platform and the toggle on", async () => {
		expect((await sandboxes(true, true).open("k")).allowCommands).toBe(true);
		expect((await sandboxes(false, true).open("k")).allowCommands).toBe(false);
		expect((await sandboxes(true, false).open("k")).allowCommands).toBe(false);
	});

	it("hands back only what changed since the last hand-back", async () => {
		const boxes = sandboxes();
		const { sandbox } = boxes.openSync("teammate:t1");
		await sandbox.overlay.write("a.txt", "ONE");
		const first = await boxes.handBack("teammate:t1", "t1");
		expect(first.map((h) => [h.rel, h.kind])).toEqual([["a.txt", "modified"]]);

		// Nothing new: nothing handed back, however often it is asked.
		expect(await boxes.handBack("teammate:t1", "t1")).toEqual([]);

		await sandbox.overlay.write("b.txt", "NEW");
		const second = await boxes.handBack("teammate:t1", "t1");
		expect(second.map((h) => h.rel)).toEqual(["b.txt"]);
		expect(log.revisions(path.join(ws, "b.txt")).at(-1)?.by).toBe("agent:t1");
		expect(boxes.has("teammate:t1")).toBe(true);
	});

	it("records an agent putting a handed-back file back the way it was", async () => {
		const boxes = sandboxes();
		const { sandbox } = await boxes.open("k");
		await sandbox.overlay.write("a.txt", "CHANGED");
		await boxes.handBack("k", "agent-x");
		await sandbox.overlay.write("a.txt", "ORIG");
		const handed = await boxes.handBack("k", "agent-x");
		expect(handed.map((h) => [h.rel, h.kind])).toEqual([["a.txt", "reverted"]]);
		expect(log.revisions(path.join(ws, "a.txt")).at(-1)?.body?.toString()).toBe(
			"ORIG",
		);
	});

	it("hands back what is outstanding when it closes, disposes, and is idempotent", async () => {
		const boxes = sandboxes();
		const { sandbox } = await boxes.open("k");
		await sandbox.overlay.write("a.txt", "LAST");
		const handed = await boxes.close("k", "agent-x");
		expect(handed.map((h) => h.rel)).toEqual(["a.txt"]);
		expect(boxes.has("k")).toBe(false);
		expect(await fs.readdir(overlays)).toEqual([]);
		expect(await boxes.close("k", "agent-x")).toEqual([]);
		expect(await fs.readFile(path.join(ws, "a.txt"), "utf8")).toBe("ORIG");
	});

	it("gives a reopened key a fresh workspace and releases the old one", async () => {
		const boxes = sandboxes();
		const old = await boxes.open("teammate:t1");
		await old.sandbox.overlay.write("a.txt", "OLD");
		const fresh = boxes.openSync("teammate:t1");
		expect(fresh.sandbox.overlayRoot).not.toBe(old.sandbox.overlayRoot);
		expect((await fresh.sandbox.overlay.read("a.txt")).toString()).toBe("ORIG");
		await boxes.closeAll();
		expect(await fs.readdir(overlays)).toEqual([]);
		// The old workspace's work was handed back, not dropped.
		expect(log.revisions(path.join(ws, "a.txt")).at(-1)?.body?.toString()).toBe(
			"OLD",
		);
	});
});

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setUpDelegatedSandbox } from "../../extensions/tools/team/agent-sandbox-executors";
import { createRevisionLog } from "../atomic/file-revisions";
import { createAgentSandbox } from "./agent-sandbox";

describe("createAgentSandbox", () => {
	let base: string;
	let ws: string;
	let ov: string;

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sandbox-"));
		ws = path.join(base, "ws");
		ov = path.join(base, "ov");
		await fs.mkdir(ws, { recursive: true });
		await fs.writeFile(path.join(ws, "a.txt"), "ORIG");
	});

	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	it("gives no shell wrapper when there is no launcher for this platform", async () => {
		const sandbox = await createAgentSandbox({
			workspaceRoot: ws,
			overlayRoot: ov,
		});
		expect(sandbox.wrapSpawn).toBeUndefined();
		// The overlay still works — file isolation without a shell.
		await sandbox.overlay.write("a.txt", "EDITED");
		expect((await fs.readFile(path.join(ws, "a.txt"))).toString()).toBe("ORIG");
		const changes = await sandbox.changedFiles();
		expect(changes.map((c) => [c.rel, c.kind])).toEqual([
			["a.txt", "modified"],
		]);
	});

	it("wraps a spawn at the launcher when binaries cover the platform", async () => {
		const sandbox = await createAgentSandbox({
			workspaceRoot: ws,
			overlayRoot: ov,
			binaries: {
				launcher: "/opt/launch.exe",
				hook: "/opt/hook.dll",
				platforms: [process.platform],
			},
		});
		expect(sandbox.wrapSpawn).toBeDefined();
		const wrapped = sandbox.wrapSpawn?.({
			executable: "powershell",
			args: ["-Command", "echo hi"],
			cwd: "/somewhere/else",
			env: { PATH: "/bin" },
		});
		expect(wrapped?.executable).toBe("/opt/launch.exe");
		// The log is a sibling of the overlay root, never inside it: inside, it
		// would show in the agent's own listing of the workspace and hand back as
		// a phantom revision.
		const logPath = `${ov}.sandbox.log`;
		expect(logPath.startsWith(`${ov}${path.sep}`)).toBe(false);
		// launcher hook log <origExec> <...origArgs>
		expect(wrapped?.args).toEqual([
			"/opt/hook.dll",
			logPath,
			"powershell",
			"-Command",
			"echo hi",
		]);
		// cwd is forced back to the workspace so relative paths map into the overlay.
		expect(wrapped?.cwd).toBe(ws);
		expect(wrapped?.env.CEREBRILINE_WS_ROOT).toBe(ws);
		expect(wrapped?.env.CEREBRILINE_OVERLAY_ROOT).toBe(ov);
		expect(wrapped?.env.CEREBRILINE_SANDBOX_LOG).toBe(logPath);
		expect(wrapped?.env.PATH).toBe("/bin");
	});

	it("dispose removes the overlay directory", async () => {
		const sandbox = await createAgentSandbox({
			workspaceRoot: ws,
			overlayRoot: ov,
		});
		await sandbox.overlay.write("b.txt", "new");
		await sandbox.dispose();
		await expect(fs.access(ov)).rejects.toThrow();
	});
});

describe("setUpDelegatedSandbox", () => {
	let base: string;
	let ws: string;
	let ov: string;

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "delegated-setup-"));
		ws = path.join(base, "ws");
		ov = path.join(base, "ov");
		await fs.mkdir(ws, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	it("binds the overlay and withholds commands with no launcher", async () => {
		const setup = await setUpDelegatedSandbox({
			workspaceRoot: ws,
			overlayRoot: ov,
		});
		expect(setup.commandsEnabled).toBe(false);
		expect(setup.executorOptions.overlay).toBe(setup.sandbox.overlay);
		// No wrapper means the shell built from these options would run unwrapped,
		// which is exactly why the caller must not build one — commandsEnabled says so.
		expect(setup.executorOptions.bash?.wrapSpawn).toBeUndefined();
	});

	it("enables commands and sets the wrapper when the launcher is present", async () => {
		const setup = await setUpDelegatedSandbox({
			workspaceRoot: ws,
			overlayRoot: ov,
			binaries: {
				launcher: "/opt/launch.exe",
				hook: "/opt/hook.dll",
				platforms: [process.platform],
			},
		});
		expect(setup.commandsEnabled).toBe(true);
		expect(setup.executorOptions.bash?.wrapSpawn).toBe(setup.sandbox.wrapSpawn);
	});
});

// The hand-back contract (Step 3): an agent's overlay changes fold into the
// lead's own revision log as recoverable revisions marked as the agent's, and
// nothing is written to the workspace. This mirrors `handBackAndDispose`.
describe("hand-back into the lead's revision log", () => {
	let base: string;
	let ws: string;
	let ov: string;

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "handback-"));
		ws = path.join(base, "ws");
		ov = path.join(base, "ov");
		await fs.mkdir(ws, { recursive: true });
		await fs.writeFile(path.join(ws, "keep.txt"), "ORIG");
		await fs.writeFile(path.join(ws, "gone.txt"), "DOOMED");
	});

	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true });
	});

	it("records modified, created and deleted files as the agent's revisions", async () => {
		const sandbox = await createAgentSandbox({
			workspaceRoot: ws,
			overlayRoot: ov,
		});
		await sandbox.overlay.write("keep.txt", "EDITED");
		await sandbox.overlay.write("fresh.txt", "NEW");
		await sandbox.overlay.unlink("gone.txt");

		const log = createRevisionLog();
		const by = "agent:worker";
		for (const change of await sandbox.changedFiles()) {
			const absolutePath = path.join(ws, change.rel);
			const onDisk = await fs
				.readFile(absolutePath)
				.catch(() => undefined as Buffer | undefined);
			log.seed(absolutePath, onDisk, "session");
			const body =
				change.kind === "deleted" || !change.overlayPath
					? undefined
					: await fs.readFile(change.overlayPath);
			log.record(absolutePath, body, by, { intent: `${change.kind} by agent` });
		}

		const head = (rel: string) => {
			const revs = log.revisions(path.join(ws, rel));
			return revs[revs.length - 1];
		};
		// The agent's version is the newest revision, attributed to the agent.
		expect(head("keep.txt")?.body?.toString()).toBe("EDITED");
		expect(head("keep.txt")?.by).toBe(by);
		expect(head("fresh.txt")?.body?.toString()).toBe("NEW");
		// A deletion is a revision whose content is absent.
		expect(head("gone.txt")?.body).toBeUndefined();
		// The lead's on-disk version is preserved as an earlier revision, so a
		// restore can go back from the agent's change.
		const keepRevs = log.revisions(path.join(ws, "keep.txt"));
		expect(keepRevs[0]?.body?.toString()).toBe("ORIG");

		// Nothing reached the workspace.
		expect((await fs.readFile(path.join(ws, "keep.txt"))).toString()).toBe(
			"ORIG",
		);
		expect((await fs.readFile(path.join(ws, "gone.txt"))).toString()).toBe(
			"DOOMED",
		);
		await expect(fs.access(path.join(ws, "fresh.txt"))).rejects.toThrow();
	});
});

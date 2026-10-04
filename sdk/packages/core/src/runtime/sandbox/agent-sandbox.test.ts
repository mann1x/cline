import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setUpDelegatedSandbox } from "../../extensions/tools/team/agent-sandbox-executors";
import { createRevisionLog } from "../atomic/file-revisions";
import {
	archiveSandboxLog,
	confinementEnv,
	createAgentSandbox,
	createLeadConfinement,
	withWorkspaceOnPath,
} from "./agent-sandbox";

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
		// The workspace goes last on the search path: a program beside the
		// files is found by its bare name, and shadows no system command.
		expect(wrapped?.env.PATH).toBe(`/bin${path.delimiter}${ws}`);
	});

	it("puts the workspace on the search path whatever the shell's own lookup does", () => {
		// Windows: the key is `Path`, and the comparison ignores case.
		expect(
			withWorkspaceOnPath(
				{},
				"C:\\Users\\m\\repo",
				{ Path: "C:\\Windows;C:\\Tools" },
				"win32",
			),
		).toEqual({ Path: "C:\\Windows;C:\\Tools;C:\\Users\\m\\repo" });
		const already = { Path: "C:\\Windows;c:\\users\\m\\REPO" };
		expect(
			withWorkspaceOnPath(already, "C:\\Users\\m\\repo", {}, "win32"),
		).toBe(already);
		expect(withWorkspaceOnPath({ PATH: "/bin" }, "/w", {}, "linux")).toEqual({
			PATH: "/bin:/w",
		});
		expect(withWorkspaceOnPath({}, "/w", {}, "linux")).toEqual({ PATH: "/w" });
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

	// The trace is the record of what the agent's commands touched; it is
	// kept, compressed, instead of being deleted with the overlay (a 201 MB
	// trace was 9 MB at gzip level 1).
	it("dispose keeps the sandbox log as a gzip archive", async () => {
		const sandbox = await createAgentSandbox({
			workspaceRoot: ws,
			overlayRoot: ov,
		});
		const log = `${ov}.sandbox.log`;
		const trace = Buffer.from(
			"123\tREDIRECT-R\t\\??\\C:\\ov\r\n".repeat(500),
			"utf16le",
		);
		await fs.writeFile(log, trace);
		await sandbox.dispose();

		await expect(fs.access(log)).rejects.toThrow();
		const archived = await fs.readFile(`${log}.gz`);
		expect(archived.length).toBeLessThan(trace.length / 10);
		expect(gunzipSync(archived).equals(trace)).toBe(true);
	});

	it("leaves nothing for an empty or absent log", async () => {
		const log = path.join(base, "empty.sandbox.log");
		await fs.writeFile(log, "");
		await archiveSandboxLog(log);
		await archiveSandboxLog(path.join(base, "absent.sandbox.log"));
		expect(
			(await fs.readdir(base)).filter((name) => name.includes("sandbox.log")),
		).toEqual([]);
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

describe("write confinement", () => {
	it("tells the launcher to confine, with a temp folder of its own on Windows", () => {
		expect(confinementEnv("/x/ov.tmp", "linux")).toEqual({
			CEREBRILINE_SANDBOX_CONFINE: "1",
		});
		expect(confinementEnv("C:\\x\\ov.tmp", "win32")).toEqual({
			CEREBRILINE_SANDBOX_CONFINE: "1",
			CEREBRILINE_SANDBOX_TMP: "C:\\x\\ov.tmp",
			TEMP: "C:\\x\\ov.tmp",
			TMP: "C:\\x\\ov.tmp",
		});
	});

	const binaries = {
		launcher: "/bin/launcher",
		hook: "/bin/hook",
		platforms: [process.platform],
	};
	const spec = { executable: "sh", args: ["-c", "true"], cwd: "/ws", env: {} };

	it("confines an agent's commands unless told not to", async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "agent-confine-"));
		try {
			const on = await createAgentSandbox({
				workspaceRoot: base,
				overlayRoot: path.join(base, "on"),
				binaries,
			});
			expect(on.wrapSpawn?.(spec).env.CEREBRILINE_SANDBOX_CONFINE).toBe("1");
			const off = await createAgentSandbox({
				workspaceRoot: base,
				overlayRoot: path.join(base, "off"),
				binaries,
				confine: false,
			});
			expect(
				off.wrapSpawn?.(spec).env.CEREBRILINE_SANDBOX_CONFINE,
			).toBeUndefined();
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});

	it("leaves the lead's commands alone when its confinement is off", () => {
		expect(
			createLeadConfinement({
				enabled: false,
				workspaceRoot: "/ws",
				binaries,
				tempRoot: "/t",
			}),
		).toBeUndefined();
	});

	it("runs the lead's commands in direct mode, in the caller's folder", () => {
		const wrap = createLeadConfinement({
			enabled: true,
			workspaceRoot: "/ws",
			binaries,
			tempRoot: "/t",
			platform: process.platform,
		});
		const out = wrap?.({ ...spec, cwd: "/ws/sub", env: { A: "1" } });
		expect(out?.executable).toBe("/bin/launcher");
		expect(out?.args).toEqual(["/bin/hook", "", "sh", "-c", "true"]);
		expect(out?.cwd).toBe("/ws/sub");
		expect(out?.env).toMatchObject({
			A: "1",
			CEREBRILINE_WS_ROOT: "/ws",
			CEREBRILINE_SANDBOX_DIRECT: "1",
		});
		expect(out?.env.CEREBRILINE_OVERLAY_ROOT).toBeUndefined();
	});

	it("gives the lead a temp folder of its own on Windows", () => {
		const wrap = createLeadConfinement({
			enabled: true,
			workspaceRoot: "C:\\ws",
			binaries: { ...binaries, platforms: ["win32"] },
			tempRoot: "C:\\t",
			platform: "win32",
		});
		expect(wrap?.(spec).env).toMatchObject({
			CEREBRILINE_SANDBOX_TMP: "C:\\t",
			TEMP: "C:\\t",
			TMP: "C:\\t",
		});
	});

	it("refuses the command when confinement is on and there is no launcher", () => {
		const wrap = createLeadConfinement({
			enabled: true,
			workspaceRoot: "/ws",
			tempRoot: "/t",
		});
		expect(() => wrap?.(spec)).toThrow(/was not run/);
	});
});

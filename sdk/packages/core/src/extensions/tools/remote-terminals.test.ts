import { spawn, spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolContext } from "@cline/shared";
import { create } from "tar";
import { describe, expect, it } from "vitest";
import { createPlanModeCommandGuardExtension } from "./command-guard-extension";
import {
	packFolder,
	resolveLocalPath,
	unpackArchive,
} from "./remote-copy-local";
import {
	createRemoteTerminalTools,
	listRemoteMachines,
	matchRemoteTerminal,
	type RemoteTerminalsConfig,
	type RemoteWorkspaceRecord,
	RUN_MARKER_VARIABLE,
	remoteTerminalsUnavailable,
	remoteWorkspaceId,
	removeRemoteWorkspace,
	stopCommand,
	trimRemoteOutput,
} from "./remote-terminals";

const CONFIG: RemoteTerminalsConfig = {
	openWebUiUrl: "http://owui:3003/",
	apiKey: "sk-test",
	terminals: [
		{
			name: "bench-app",
			machineId: "solidpc-bench-app",
			description: "builds and benchmarks the app",
		},
		{ name: "general", machineId: "solidpc-open-terminal" },
	],
};

interface Call {
	method: string;
	url: URL;
	headers: Record<string, string>;
	body?: Record<string, unknown>;
	form?: FormData;
}

/** A fake Open WebUI: records every request, answers from a handler. */
function fakeOpenWebUi(
	handler: (call: Call) => {
		status?: number;
		json?: unknown;
		text?: string;
		bytes?: Uint8Array;
		contentType?: string;
	},
) {
	const calls: Call[] = [];
	const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
		const call: Call = {
			method: init?.method ?? "GET",
			url: new URL(String(input)),
			headers: (init?.headers ?? {}) as Record<string, string>,
			body:
				init?.body && !(init.body instanceof FormData)
					? JSON.parse(String(init.body))
					: undefined,
			form: init?.body instanceof FormData ? init.body : undefined,
		};
		calls.push(call);
		const answer = handler(call);
		if (answer.bytes)
			return new Response(new Uint8Array(answer.bytes), {
				status: answer.status ?? 200,
				headers: answer.contentType
					? { "content-type": answer.contentType }
					: {},
			});
		const text = answer.text ?? JSON.stringify(answer.json ?? {});
		return new Response(text, {
			status: answer.status ?? 200,
			headers: answer.contentType ? { "content-type": answer.contentType } : {},
		});
	}) as typeof fetch;
	return { calls, fetchImpl };
}

const WORKSPACE = "/home/u76b162c1/cerebriline/1790_task";

/** What the fake answers for /system/info; empty unless a test sets it. */
let machineInfo: unknown;

/** Answers the workspace mkdir, then hands everything else to `rest`. */
function withWorkspace(
	rest: (call: Call) => {
		status?: number;
		json?: unknown;
		text?: string;
		bytes?: Uint8Array;
		contentType?: string;
	},
) {
	return (call: Call) => {
		const command = call.body?.command;
		// The machine summary asked for when a workspace is made: none here,
		// so results carry no first-use note unless a test answers it itself.
		if (call.url.pathname.endsWith("/system/info") && !machineInfo)
			return { json: {} };
		if (call.url.pathname.endsWith("/system/info"))
			return { json: machineInfo };
		if (
			call.url.pathname.endsWith("/execute") &&
			typeof command === "string" &&
			command.startsWith("mkdir -p")
		) {
			return {
				json: {
					id: "ws",
					status: "done",
					exit_code: 0,
					output: [{ data: `${WORKSPACE}\r\n` }],
				},
			};
		}
		return rest(call);
	};
}

const context = (
	overrides: Partial<AgentToolContext> = {},
): AgentToolContext => ({
	agentId: "agent-1",
	sessionId: "1790_task",
	iteration: 1,
	...overrides,
});

function tool(
	tools: ReturnType<typeof createRemoteTerminalTools>,
	name: string,
) {
	const found = tools.find((entry) => entry.name === name);
	if (!found) throw new Error(`no ${name}`);
	return found as unknown as {
		execute: (input: unknown, context: AgentToolContext) => Promise<string>;
		description: string;
		readOnly?: boolean;
	};
}

describe("remote terminals: offering", () => {
	it("offers nothing until the URL, the key and a terminal are all set", () => {
		expect(remoteTerminalsUnavailable(undefined)).toMatch(/off/);
		expect(
			remoteTerminalsUnavailable({ ...CONFIG, openWebUiUrl: " " }),
		).toMatch(/URL/);
		expect(remoteTerminalsUnavailable({ ...CONFIG, apiKey: "" })).toMatch(
			/API key/,
		);
		expect(
			remoteTerminalsUnavailable({
				...CONFIG,
				terminals: [{ name: "x", machineId: "" }],
			}),
		).toMatch(/no terminal/);
		expect(
			createRemoteTerminalTools({
				getConfig: () => ({ ...CONFIG, apiKey: "" }),
			}),
		).toEqual([]);
	});

	it("offers three tools that name every terminal and its description", () => {
		const tools = createRemoteTerminalTools({ getConfig: () => CONFIG });
		expect(tools.map((entry) => entry.name)).toEqual([
			"remote_run",
			"remote_read",
			"remote_write",
		]);
		expect(tool(tools, "remote_run").description).toContain(
			"- bench-app (machine solidpc-bench-app): builds and benchmarks the app",
		);
		expect(tool(tools, "remote_run").description).toContain(
			"- general (machine solidpc-open-terminal)",
		);
		expect(tool(tools, "remote_read").readOnly).toBe(true);
		expect(tool(tools, "remote_write").readOnly).toBeUndefined();
	});
});

describe("remote_run", () => {
	it("goes through Open WebUI's machine proxy, in the session's workspace, with HOME there", async () => {
		const records: RemoteWorkspaceRecord[] = [];
		const { calls, fetchImpl } = fakeOpenWebUi(
			withWorkspace(() => ({
				json: {
					id: "p1",
					status: "done",
					exit_code: 0,
					output: [{ data: "hello\r\n" }],
				},
			})),
		);
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl,
			onWorkspace: (r) => records.push(r),
		});
		const result = await tool(tools, "remote_run").execute(
			{ terminal: "Bench-App", command: "echo hello", cwd: "src" },
			context(),
		);

		expect(result).toMatch(/^\[bench-app\] exit 0 after [\d.]+ s\nhello$/);
		const mkdir = calls[0];
		const run = calls.find(
			(call) => call.body?.command === "echo hello",
		) as Call;
		expect(mkdir.url.pathname).toBe(
			"/api/v1/machines/solidpc-bench-app/execute",
		);
		expect(mkdir.body?.command).toBe(
			`mkdir -p "$HOME"/'cerebriline/1790_task' && cd "$HOME"/'cerebriline/1790_task' && pwd`,
		);
		expect(run.headers.Authorization).toBe("Bearer sk-test");
		expect(run.headers["X-Session-Id"]).toBeUndefined();
		expect(run.body).toMatchObject({
			command: "echo hello",
			cwd: `${WORKSPACE}/src`,
			env: { HOME: WORKSPACE },
		});
		// Every command carries a marker of its own, for stopping it.
		const env = run.body?.env as Record<string, string>;
		expect(env[RUN_MARKER_VARIABLE]).toMatch(/^[a-f0-9]{32}$/);
		expect(records).toEqual([
			{
				terminal: "bench-app",
				machineId: "solidpc-bench-app",
				workspaceId: "1790_task",
				path: WORKSPACE,
			},
		]);

		// The workspace is made once per session and machine.
		await tool(tools, "remote_run").execute(
			{ terminal: "bench-app", command: "true" },
			context(),
		);
		expect(
			calls.filter((call) =>
				String(call.body?.command ?? "").startsWith("mkdir"),
			),
		).toHaveLength(1);
	});

	it("waits for a long command in steps and keeps all of its output", async () => {
		let polls = 0;
		const { calls, fetchImpl } = fakeOpenWebUi(
			withWorkspace((call) => {
				if (call.method === "POST")
					return {
						json: {
							id: "p2",
							status: "running",
							next_offset: 1,
							output: [{ data: "tick 1\n" }],
						},
					};
				polls += 1;
				return polls < 2
					? {
							json: {
								id: "p2",
								status: "running",
								next_offset: 2,
								output: [{ data: "tick 2\n" }],
							},
						}
					: {
							json: {
								id: "p2",
								status: "done",
								exit_code: 3,
								next_offset: 3,
								output: [{ data: "tick 3\n" }],
							},
						};
			}),
		);
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl,
		});
		const result = await tool(tools, "remote_run").execute(
			{ terminal: "bench-app", command: "bench" },
			context(),
		);
		expect(result).toMatch(/exit 3/);
		expect(result).toContain("tick 1\ntick 2\ntick 3");
		const status = calls.filter((call) =>
			call.url.pathname.endsWith("/status"),
		);
		expect(status.map((call) => call.url.searchParams.get("offset"))).toEqual([
			"1",
			"2",
		]);
		expect(Number(status[0].url.searchParams.get("wait"))).toBeLessThanOrEqual(
			30,
		);
	});

	it("says how to keep waiting when the timeout passes first", async () => {
		const { fetchImpl } = fakeOpenWebUi(
			withWorkspace(() => ({
				json: { id: "p3", status: "running", next_offset: 0, output: [] },
			})),
		);
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl,
		});
		const result = await tool(tools, "remote_run").execute(
			{ terminal: "bench-app", command: "sleep 99", timeout_seconds: 0.001 },
			context(),
		);
		expect(result).toContain("still running");
		expect(result).toContain('process_id "p3"');
	});

	it("stops the remote command when the run is cancelled", async () => {
		const abort = new AbortController();
		const { calls, fetchImpl } = fakeOpenWebUi(
			withWorkspace((call) => {
				if (call.method === "POST" && call.body?.command === "sleep 99")
					return {
						json: { id: "p4", status: "running", next_offset: 0, output: [] },
					};
				if (call.method === "POST")
					return {
						json: {
							id: "stop",
							status: "done",
							exit_code: 0,
							output: [{ data: "stopped\n" }],
						},
					};
				if (call.method === "GET") {
					abort.abort();
					throw new Error("aborted");
				}
				return { json: { ok: true } };
			}),
		);
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl,
		});
		await expect(
			tool(tools, "remote_run").execute(
				{ terminal: "bench-app", command: "sleep 99" },
				context({ signal: abort.signal }),
			),
		).rejects.toThrow();
		// Not Open Terminal's DELETE, which its server cannot carry out under
		// sudo: a command that kills whatever carries this run's marker.
		const started = calls.find((call) => call.body?.command === "sleep 99");
		const marker = (started?.body?.env as Record<string, string>)[
			RUN_MARKER_VARIABLE
		];
		const stop = calls.at(-1);
		expect(stop?.url.pathname).toBe(
			"/api/v1/machines/solidpc-bench-app/execute",
		);
		expect(stop?.body?.command).toBe(stopCommand(marker));
		expect(calls.some((call) => call.method === "DELETE")).toBe(false);
	});

	it("names the configured terminals when asked for one that does not exist", async () => {
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl: fakeOpenWebUi(() => ({})).fetchImpl,
		});
		await expect(
			tool(tools, "remote_run").execute(
				{ terminal: "gpu", command: "x" },
				context(),
			),
		).rejects.toThrow(
			/no remote terminal called "gpu".*Available: bench-app \(solidpc-bench-app\), general/,
		);
	});

	it("explains Open WebUI's refusals", async () => {
		const unknownMachine = fakeOpenWebUi(() => ({
			status: 404,
			json: { error: "Machine 'solidpc-bench-app' not found" },
		}));
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl: unknownMachine.fetchImpl,
		});
		await expect(
			tool(tools, "remote_run").execute(
				{ terminal: "bench-app", command: "x" },
				context(),
			),
		).rejects.toThrow(/no machine "solidpc-bench-app"/);
		const badKey = fakeOpenWebUi(() => ({
			status: 401,
			text: "Not authenticated",
		}));
		const tools2 = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl: badKey.fetchImpl,
		});
		await expect(
			tool(tools2, "remote_run").execute(
				{ terminal: "bench-app", command: "x" },
				context(),
			),
		).rejects.toThrow(/refused the API key/);
	});
});

describe("remote_read and remote_write", () => {
	it("resolves relative paths against the workspace and leaves absolute ones alone", async () => {
		const { calls, fetchImpl } = fakeOpenWebUi(
			withWorkspace((call) => {
				if (call.url.pathname.endsWith("/files/read"))
					return {
						json: {
							path: call.url.searchParams.get("path"),
							content: "two\n",
							total_lines: 3,
						},
					};
				if (call.url.pathname.endsWith("/files/list"))
					return {
						json: {
							dir: WORKSPACE,
							entries: [
								{ name: "src", type: "directory" },
								{ name: "a.txt", type: "file", size: 14 },
							],
						},
					};
				return { json: {} };
			}),
		);
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl,
		});
		const read = await tool(tools, "remote_read").execute(
			{
				terminal: "bench-app",
				action: "read",
				path: "w/a.txt",
				start_line: 2,
				end_line: 2,
			},
			context(),
		);
		expect(read).toBe(
			`[bench-app] ${WORKSPACE}/w/a.txt lines 2-2 (3 lines)\ntwo\n`,
		);
		await tool(tools, "remote_read").execute(
			{ terminal: "bench-app", action: "read", path: "/etc/os-release" },
			context(),
		);
		expect(calls.at(-1)?.url.searchParams.get("path")).toBe("/etc/os-release");
		const list = await tool(tools, "remote_read").execute(
			{ terminal: "bench-app", action: "list" },
			context(),
		);
		expect(list).toBe(`[bench-app] ${WORKSPACE}\nsrc/\na.txt (14 B)`);
	});

	it("maps edits onto Open Terminal's replacements", async () => {
		const { calls, fetchImpl } = fakeOpenWebUi(
			withWorkspace((call) =>
				call.url.pathname.endsWith("/files/replace")
					? { json: { path: `${WORKSPACE}/a.txt`, patch: "-two\n+TWO" } }
					: { json: { path: `${WORKSPACE}/a.txt`, size: 3, created: true } },
			),
		);
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl,
		});
		expect(
			await tool(tools, "remote_write").execute(
				{
					terminal: "bench-app",
					action: "write",
					path: "a.txt",
					content: "one",
				},
				context(),
			),
		).toBe(`[bench-app] created ${WORKSPACE}/a.txt (3 B)`);
		await tool(tools, "remote_write").execute(
			{
				terminal: "bench-app",
				action: "replace",
				path: "a.txt",
				edits: [{ old_text: "two", new_text: "TWO", replace_all: true }],
			},
			context(),
		);
		expect(calls.at(-1)?.body).toEqual({
			path: `${WORKSPACE}/a.txt`,
			replacements: [
				{ target: "two", replacement: "TWO", allow_multiple: true },
			],
		});
	});
});

describe("helpers", () => {
	it("makes a readable, path-safe workspace id from the session", () => {
		expect(
			remoteWorkspaceId({ sessionId: "1790503776490_9jhpx", agentId: "a" }),
		).toBe("1790503776490_9jhpx");
		expect(remoteWorkspaceId({ sessionId: "../../etc", agentId: "a" })).toBe(
			"__.._etc",
		);
		expect(remoteWorkspaceId({ agentId: "agent 7" })).toBe("agent_7");
	});

	it("keeps the start and the end of long output", () => {
		const text = `${"a".repeat(10_000)}${"b".repeat(30_000)}`;
		const trimmed = trimRemoteOutput(text);
		expect(trimmed.startsWith("a".repeat(4_000))).toBe(true);
		expect(trimmed.endsWith("b".repeat(16_000))).toBe(true);
		expect(trimmed).toContain("characters left out");
	});

	it("removes exactly one workspace folder and refuses odd names", async () => {
		const { calls, fetchImpl } = fakeOpenWebUi(() => ({
			json: { id: "rm", status: "done", exit_code: 0, output: [] },
		}));
		await removeRemoteWorkspace(
			CONFIG,
			{
				terminal: "bench-app",
				machineId: "solidpc-bench-app",
				workspaceId: "1790_task",
			},
			fetchImpl,
		);
		expect(calls[0].body?.command).toBe(
			`rm -rf -- "$HOME"/'cerebriline/1790_task'`,
		);
		await expect(
			removeRemoteWorkspace(
				CONFIG,
				{ terminal: "bench-app", machineId: "m", workspaceId: "../x" },
				fetchImpl,
			),
		).rejects.toThrow(/unexpected name/);
	});
});

describe("plan mode", () => {
	const guard = createPlanModeCommandGuardExtension();
	const before = (name: string, input: unknown) =>
		guard.hooks?.beforeTool?.({
			tool: { name },
			input,
			toolCall: { toolCallId: "t1" },
			snapshot: { agentId: "a", conversationId: "c", runId: "r", iteration: 1 },
		} as never);

	it("refuses remote writes and file-editing remote commands, lets reads through", () => {
		expect(
			before("remote_write", {
				terminal: "bench-app",
				action: "write",
				path: "a",
				content: "",
			}),
		).toMatchObject({ skip: true });
		expect(
			before("remote_run", {
				terminal: "bench-app",
				command: "echo hi > a.txt",
			}),
		).toMatchObject({ skip: true });
		expect(
			before("remote_run", { terminal: "bench-app", command: "ls -la" }),
		).toBeUndefined();
		expect(
			before("remote_read", { terminal: "bench-app", action: "list" }),
		).toBeUndefined();
		for (const direction of ["upload", "download"]) {
			expect(
				before("remote_copy", { terminal: "bench-app", direction, from: "x" }),
			).toMatchObject({ skip: true });
		}
	});
});

describe("remote_run cancelled while starting", () => {
	it("stops the command by its marker though no process id came back", async () => {
		const abort = new AbortController();
		const { calls, fetchImpl } = fakeOpenWebUi(
			withWorkspace((call) => {
				if (call.body?.command === "sleep 99") {
					abort.abort();
					throw new Error("aborted");
				}
				return {
					json: {
						id: "stop",
						status: "done",
						exit_code: 0,
						output: [{ data: "stopped\n" }],
					},
				};
			}),
		);
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl,
		});
		await expect(
			tool(tools, "remote_run").execute(
				{ terminal: "bench-app", command: "sleep 99" },
				context({ signal: abort.signal }),
			),
		).rejects.toThrow();
		const started = calls.find((call) => call.body?.command === "sleep 99");
		const marker = (started?.body?.env as Record<string, string>)[
			RUN_MARKER_VARIABLE
		];
		expect(calls.at(-1)?.body?.command).toBe(stopCommand(marker));
	});
});

describe.skipIf(process.platform === "win32")("stopCommand", () => {
	it("kills a marked command and its children, and nothing else", async () => {
		const marker = "abc123";
		// A shell whose child is the long-running process, as `sudo … bash -c` has.
		const marked = spawn("sh", ["-c", "sleep 30; echo survived"], {
			env: { ...process.env, [RUN_MARKER_VARIABLE]: marker },
		});
		const other = spawn("sh", ["-c", "sleep 30"], {
			env: { ...process.env, [RUN_MARKER_VARIABLE]: "other" },
		});
		const exited = new Promise((resolve) => marked.on("exit", resolve));
		await new Promise((resolve) => setTimeout(resolve, 200));
		const result = spawnSync("sh", ["-c", stopCommand(marker)], {
			encoding: "utf8",
		});
		expect(result.stdout.trim()).toBe("stopped");
		await exited;
		const children = spawnSync(
			"sh",
			[
				"-c",
				`grep -l "${RUN_MARKER_VARIABLE}=${marker}" /proc/[0-9]*/environ 2>/dev/null | wc -l`,
			],
			{
				encoding: "utf8",
			},
		);
		expect(children.stdout.trim()).toBe("0");
		expect(other.exitCode).toBeNull();
		other.kill("SIGKILL");
		expect(() => stopCommand("x; rm -rf /")).toThrow(/unexpected/);
	});
});

const done = (data = "") => ({
	json: { id: "x", status: "done", exit_code: 0, output: [{ data }] },
});

async function tempDir(label: string): Promise<string> {
	return mkdtemp(join(tmpdir(), `rt-${label}-`));
}

describe("matching and discovery", () => {
	const terminals = [
		{ name: "solidpc", machineId: "solidpc-open-terminal" },
		{ name: "bench-app", machineId: "solidpc-bench-app" },
	];

	it("finds a terminal by name, by machine ID, or by a part only one of them has", () => {
		expect(matchRemoteTerminal(terminals, "Bench-App")?.machineId).toBe(
			"solidpc-bench-app",
		);
		expect(matchRemoteTerminal(terminals, "solidpc-open-terminal")?.name).toBe(
			"solidpc",
		);
		expect(matchRemoteTerminal(terminals, "open-terminal")?.name).toBe(
			"solidpc",
		);
		expect(matchRemoteTerminal(terminals, "openterminal")?.name).toBe(
			"solidpc",
		);
		// "solidpc" is a name, so it wins over the two IDs that contain it.
		expect(matchRemoteTerminal(terminals, "solidpc")?.machineId).toBe(
			"solidpc-open-terminal",
		);
		expect(
			matchRemoteTerminal(
				[
					{ name: "a", machineId: "x-gpu-1" },
					{ name: "b", machineId: "x-gpu-2" },
				],
				"gpu",
			),
		).toBeUndefined();
	});

	it("lists the machines Open WebUI lets this user use, without templates", async () => {
		const { calls, fetchImpl } = fakeOpenWebUi(() => ({
			json: [
				{ id: "solidpc-open-terminal", name: "solidpc" },
				{ id: "solidpc-bench-app", name: "" },
				{ id: "orchestrator:t1", name: "Orchestrated", template_id: "t1" },
			],
		}));
		expect(await listRemoteMachines(CONFIG, fetchImpl)).toEqual([
			{ name: "solidpc", machineId: "solidpc-open-terminal" },
			{ name: "solidpc-bench-app", machineId: "solidpc-bench-app" },
		]);
		expect(calls[0].url.pathname).toBe("/api/v1/machines/");
		const refused = fakeOpenWebUi(() => ({ status: 401, text: "no" }));
		await expect(listRemoteMachines(CONFIG, refused.fetchImpl)).rejects.toThrow(
			/refused the API key/,
		);
	});

	it("asks Open WebUI again for a name the session does not know", async () => {
		const { calls, fetchImpl } = fakeOpenWebUi(withWorkspace(() => done("hi")));
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl,
			discover: async () => [
				...CONFIG.terminals,
				{ name: "gpu-box", machineId: "solidpc-gpu" },
			],
		});
		await tool(tools, "remote_run").execute(
			{ terminal: "gpu-box", command: "nvidia-smi" },
			context(),
		);
		expect(calls.at(-1)?.url.pathname).toBe(
			"/api/v1/machines/solidpc-gpu/execute",
		);
	});
});

describe("remote_copy", () => {
	it("is offered only when the host names a local workspace", () => {
		expect(
			createRemoteTerminalTools({ getConfig: () => CONFIG }).map(
				(entry) => entry.name,
			),
		).not.toContain("remote_copy");
		expect(
			createRemoteTerminalTools({
				getConfig: () => CONFIG,
				getLocalRoot: () => "/x",
			}).map((entry) => entry.name),
		).toContain("remote_copy");
	});

	it("uploads a binary file as it is", async () => {
		const root = await tempDir("up-file");
		const bytes = new Uint8Array([0, 255, 1, 254, 10, 13]);
		await writeFile(join(root, "app.bin"), bytes);
		const { calls, fetchImpl } = fakeOpenWebUi(
			withWorkspace((call) =>
				call.url.pathname.endsWith("/files/upload")
					? { json: { path: `${WORKSPACE}/bin/app.bin`, size: 6 } }
					: done(),
			),
		);
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl,
			getLocalRoot: () => root,
		});
		const result = await tool(tools, "remote_copy").execute(
			{
				terminal: "bench-app",
				direction: "upload",
				from: "app.bin",
				to: "bin/app.bin",
			},
			context(),
		);
		expect(result).toContain(`uploaded app.bin to ${WORKSPACE}/bin/app.bin`);
		const upload = calls.find((call) =>
			call.url.pathname.endsWith("/files/upload"),
		);
		expect(upload?.url.searchParams.get("directory")).toBe(`${WORKSPACE}/bin`);
		const file = upload?.form?.get("file") as File;
		expect(file.name).toBe("app.bin");
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
		await rm(root, { recursive: true, force: true });
	});

	it("uploads a folder packed, without .git and node_modules, and unpacks it there", async () => {
		const root = await tempDir("up-dir");
		await mkdir(join(root, "proj/src"), { recursive: true });
		await mkdir(join(root, "proj/.git"), { recursive: true });
		await mkdir(join(root, "proj/node_modules/m"), { recursive: true });
		await writeFile(join(root, "proj/src/main.c"), "int main(){}\n");
		await writeFile(join(root, "proj/.git/HEAD"), "ref\n");
		await writeFile(join(root, "proj/node_modules/m/i.js"), "x\n");
		const { calls, fetchImpl } = fakeOpenWebUi(
			withWorkspace((call) =>
				call.url.pathname.endsWith("/files/upload")
					? { json: { path: "p", size: 1 } }
					: done(),
			),
		);
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl,
			getLocalRoot: () => root,
		});
		const result = await tool(tools, "remote_copy").execute(
			{ terminal: "bench-app", direction: "upload", from: "proj" },
			context(),
		);
		expect(result).toMatch(/uploaded proj to .*\/proj: 1 file,/);
		expect(result).toContain("left out 2 paths");
		const upload = calls.find((call) =>
			call.url.pathname.endsWith("/files/upload"),
		);
		const name = (upload?.form?.get("file") as File).name;
		expect(name).toMatch(/^\.cerebriline-upload-[a-f0-9]{12}\.tar\.gz$/);
		const unpack = calls.at(-1)?.body?.command as string;
		expect(unpack).toContain(
			`mkdir -p '${WORKSPACE}/proj' && tar -xzf '${WORKSPACE}/${name}' -C '${WORKSPACE}/proj'`,
		);
		expect(unpack).toContain(`rm -f '${WORKSPACE}/${name}'`);
		// What was sent unpacks to the source without the excluded folders.
		const check = await tempDir("up-check");
		await unpackArchive(
			new Uint8Array(await (upload?.form?.get("file") as File).arrayBuffer()),
			check,
		);
		expect(await readFile(join(check, "src/main.c"), "utf8")).toBe(
			"int main(){}\n",
		);
		await expect(readFile(join(check, ".git/HEAD"))).rejects.toThrow();
		await expect(
			readFile(join(check, "node_modules/m/i.js")),
		).rejects.toThrow();
		await rm(root, { recursive: true, force: true });
		await rm(check, { recursive: true, force: true });
	});

	it("downloads a folder, refuses to replace files, and replaces them when asked", async () => {
		const remoteSide = await tempDir("remote");
		await mkdir(join(remoteSide, "out"), { recursive: true });
		await writeFile(join(remoteSide, "out/result.json"), '{"score":1}');
		const archive = (await packFolder(remoteSide, [])).archive;
		const root = await tempDir("down");
		const { calls, fetchImpl } = fakeOpenWebUi(
			withWorkspace((call) => {
				const command = String(call.body?.command ?? "");
				if (command.startsWith("if [ -d")) return done("dir\n");
				if (command.startsWith("tar -czf")) return done(`${archive.length}\n`);
				if (call.url.pathname.endsWith("/files/view"))
					return { bytes: archive };
				return done();
			}),
		);
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl,
			getLocalRoot: () => root,
		});
		const first = await tool(tools, "remote_copy").execute(
			{ terminal: "bench-app", direction: "download", from: "results" },
			context(),
		);
		expect(first).toContain(
			`downloaded ${WORKSPACE}/results to ${join(root, "results")}: 1 file`,
		);
		expect(await readFile(join(root, "results/out/result.json"), "utf8")).toBe(
			'{"score":1}',
		);
		expect(calls.at(-1)?.body?.command).toMatch(
			/^rm -f '.*\.cerebriline-download-[a-f0-9]{12}\.tar\.gz'$/,
		);
		await expect(
			tool(tools, "remote_copy").execute(
				{ terminal: "bench-app", direction: "download", from: "results" },
				context(),
			),
		).rejects.toThrow(/already exist.*overwrite: true/);
		const again = await tool(tools, "remote_copy").execute(
			{
				terminal: "bench-app",
				direction: "download",
				from: "results",
				overwrite: true,
			},
			context(),
		);
		expect(again).toContain("replaced 1 existing file");
		await rm(root, { recursive: true, force: true });
		await rm(remoteSide, { recursive: true, force: true });
	});

	it("never reads or writes outside the local workspace", async () => {
		const root = await tempDir("conf");
		const outside = await tempDir("outside");
		await symlink(outside, join(root, "escape"));
		await expect(resolveLocalPath(root, "../x")).rejects.toThrow(
			/outside the workspace/,
		);
		await expect(resolveLocalPath(root, "escape/file")).rejects.toThrow(
			/outside the workspace/,
		);
		await expect(resolveLocalPath(root, "/etc/passwd")).rejects.toThrow(
			/outside the workspace/,
		);
		expect(await resolveLocalPath(root, "new/dir/file")).toMatch(
			/new\/dir\/file$/,
		);
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	});

	it("does not write the links an archive carries", async () => {
		const source = await tempDir("links");
		await writeFile(join(source, "real.txt"), "ok");
		await symlink("/etc/passwd", join(source, "link"));
		const chunks: Buffer[] = [];
		for await (const chunk of create(
			{ gzip: true, cwd: source, portable: true },
			["."],
		) as unknown as AsyncIterable<Buffer>)
			chunks.push(chunk);
		const target = await tempDir("links-out");
		const result = await unpackArchive(Buffer.concat(chunks), target);
		expect(result).toMatchObject({ files: 1, skipped: 1 });
		await expect(readFile(join(target, "link"))).rejects.toThrow();
		await rm(source, { recursive: true, force: true });
		await rm(target, { recursive: true, force: true });
	});
});

describe("activity for the host's display", () => {
	it("reports a command, its output as it arrives, how it ended, and one line per write", async () => {
		let polls = 0;
		const { fetchImpl } = fakeOpenWebUi(
			withWorkspace((call) => {
				if (call.url.pathname.endsWith("/files/write"))
					return { json: { path: `${WORKSPACE}/a`, size: 1, created: true } };
				if (call.method === "POST")
					return {
						json: {
							id: "p",
							status: "running",
							next_offset: 1,
							output: [{ data: "one\n" }],
						},
					};
				polls += 1;
				return {
					json: {
						id: "p",
						status: "done",
						exit_code: 0,
						next_offset: 2,
						output: [{ data: "two\n" }],
					},
				};
			}),
		);
		const events: unknown[] = [];
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl,
			onActivity: (event) => events.push(event),
		});
		await tool(tools, "remote_run").execute(
			{ terminal: "bench-app", command: "make" },
			context(),
		);
		await tool(tools, "remote_write").execute(
			{ terminal: "bench-app", action: "write", path: "a", content: "x" },
			context(),
		);
		expect(polls).toBe(1);
		expect(events.map((event) => (event as { type: string }).type)).toEqual([
			"command",
			"output",
			"output",
			"exit",
			"note",
		]);
		expect(events[0]).toMatchObject({
			terminal: "bench-app",
			sessionId: "1790_task",
			cwd: WORKSPACE,
			command: "make",
		});
		expect(events[3]).toMatchObject({ type: "exit", exitCode: 0 });
		expect(events[4]).toMatchObject({
			type: "note",
			text: `remote_write: created ${WORKSPACE}/a (1 B)`,
		});
	});

	it("continues a still-running command's output where the last call stopped", async () => {
		let resumed = false;
		const offsets: Array<string | null> = [];
		const { fetchImpl } = fakeOpenWebUi(
			withWorkspace((call) => {
				if (call.method === "POST")
					return {
						json: {
							id: "p",
							status: "running",
							next_offset: 3,
							output: [{ data: "abc" }],
						},
					};
				if (!resumed)
					return {
						json: { id: "p", status: "running", next_offset: 3, output: [] },
					};
				offsets.push(call.url.searchParams.get("offset"));
				return {
					json: {
						id: "p",
						status: "done",
						exit_code: 0,
						next_offset: 4,
						output: [{ data: "d" }],
					},
				};
			}),
		);
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl,
		});
		const first = await tool(tools, "remote_run").execute(
			{ terminal: "bench-app", command: "x", timeout_seconds: 1 },
			context(),
		);
		expect(first).toContain("still running");
		resumed = true;
		const second = await tool(tools, "remote_run").execute(
			{ terminal: "bench-app", process_id: "p" },
			context(),
		);
		expect(offsets).toEqual(["3"]);
		expect(second).toMatch(/exit 0 after [\d.]+ s\nd$/);
	});

	it("a display that throws does not break the tool", async () => {
		const { fetchImpl } = fakeOpenWebUi(withWorkspace(() => done("ok")));
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl,
			onActivity: () => {
				throw new Error("display gone");
			},
		});
		expect(
			await tool(tools, "remote_run").execute(
				{ terminal: "bench-app", command: "true" },
				context(),
			),
		).toContain("exit 0");
	});
});

describe("images, input, run records, processes, info, ports", () => {
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

	it("shows an image to a model that can see, and explains to one that cannot", async () => {
		const { fetchImpl } = fakeOpenWebUi(
			withWorkspace((call) =>
				call.url.pathname.endsWith("/files/read")
					? { bytes: png, contentType: "image/png" }
					: done(),
			),
		);
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl,
		});
		const seen = (await tool(tools, "remote_read").execute(
			{ terminal: "bench-app", action: "read", path: "plot.png" },
			context({
				metadata: { modelSupportsImages: true },
			} as Partial<AgentToolContext>),
		)) as unknown as Array<{
			type: string;
			data?: string;
			mediaType?: string;
			text?: string;
		}>;
		expect(seen[0].text).toContain("plot.png: image/png image");
		expect(seen[1]).toEqual({
			type: "image",
			data: Buffer.from(png).toString("base64"),
			mediaType: "image/png",
		});
		const blind = await tool(tools, "remote_read").execute(
			{ terminal: "bench-app", action: "read", path: "plot.png" },
			context(),
		);
		expect(blind).toContain("cannot see images; copy it with remote_copy");
	});

	it("types into a running command, then waits for its answer", async () => {
		const { calls, fetchImpl } = fakeOpenWebUi(
			withWorkspace((call) => {
				if (call.url.pathname.endsWith("/input"))
					return { json: { status: "ok" } };
				return {
					json: {
						id: "p9",
						status: "done",
						exit_code: 0,
						next_offset: 2,
						output: [{ data: "installed\n" }],
					},
				};
			}),
		);
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl,
		});
		const result = await tool(tools, "remote_run").execute(
			{ terminal: "bench-app", process_id: "p9", input: "y\n" },
			context(),
		);
		const typed = calls.find((call) =>
			call.url.pathname.endsWith("/execute/p9/input"),
		);
		expect(typed?.body).toEqual({ input: "y\n" });
		expect(result).toContain("installed");
	});

	it("records a long-running command in the session folder, and stops it after a reload", async () => {
		const files = new Map<string, string>();
		const handler = withWorkspace((call) => {
			if (call.url.pathname.endsWith("/files/write")) {
				files.set(String(call.body?.path), String(call.body?.content));
				return { json: { path: call.body?.path, size: 1 } };
			}
			if (call.url.pathname.endsWith("/files/read")) {
				const content = files.get(String(call.url.searchParams.get("path")));
				return content
					? { json: { path: "x", content, total_lines: 1 } }
					: { status: 404, json: { detail: "File not found" } };
			}
			const command = String(call.body?.command ?? "");
			if (command.startsWith("m='CEREBRILINE_RUN=")) return done("stopped");
			return {
				json: {
					id: "20261128-1-abc",
					status: "running",
					next_offset: 0,
					output: [],
				},
			};
		});
		const first = fakeOpenWebUi(handler);
		const before = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl: first.fetchImpl,
		});
		await tool(before, "remote_run").execute(
			{ terminal: "bench-app", command: "serve", timeout_seconds: 1 },
			context(),
		);
		const recordPath = `${WORKSPACE}/.cerebriline/runs/20261128-1-abc`;
		const marker = files.get(recordPath);
		expect(marker).toMatch(/^[a-f0-9]{32}$/);
		// A new set of tools is what a reload gives: nothing in memory.
		const second = fakeOpenWebUi(handler);
		const after = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl: second.fetchImpl,
		});
		await tool(after, "remote_run").execute(
			{ terminal: "bench-app", process_id: "20261128-1-abc", kill: true },
			context(),
		);
		expect(second.calls.at(-1)?.body?.command).toBe(
			stopCommand(marker as string),
		);
		expect(second.calls.some((call) => call.method === "DELETE")).toBe(false);
	});

	it("lists this conversation's commands from its run records, not the whole account's", async () => {
		const { fetchImpl } = fakeOpenWebUi(
			withWorkspace((call) => {
				if (call.url.pathname.endsWith("/files/list")) {
					return {
						json: {
							dir: "x",
							entries: [
								{ name: "p-mine", type: "file" },
								{ name: "p-gone", type: "file" },
							],
						},
					};
				}
				if (call.method === "GET" && call.url.pathname.endsWith("/execute")) {
					return {
						json: [
							{
								id: "p-mine",
								command: "make bench",
								status: "running",
								exit_code: null,
							},
							{
								id: "p-other-conversation",
								command: "secret",
								status: "running",
							},
						],
					};
				}
				return done();
			}),
		);
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl,
		});
		const listed = await tool(tools, "remote_read").execute(
			{ terminal: "bench-app", action: "processes" },
			context(),
		);
		expect(listed).toContain("p-mine  running  make bench");
		expect(listed).toContain("p-gone  finished (no longer tracked)");
		expect(listed).not.toContain("secret");
	});

	it("says once what the machine is, and on demand", async () => {
		machineInfo = {
			os: "Linux 6.2",
			arch: "x86_64",
			environment: "container",
			cpu: { cores: 4 },
			memory: { total: 8 * 1024 ** 3, used: 1024 ** 3 },
			disk: { free: 100 * 1024 ** 3, total: 900 * 1024 ** 3 },
		};
		try {
			const { fetchImpl } = fakeOpenWebUi(withWorkspace(() => done("ok")));
			const tools = createRemoteTerminalTools({
				getConfig: () => CONFIG,
				fetchImpl,
			});
			const first = await tool(tools, "remote_run").execute(
				{ terminal: "bench-app", command: "true" },
				context(),
			);
			expect(first).toContain(
				"(bench-app: 4 cores, 8.0 GB memory (1.0 GB used), 100.0 GB disk free of 900.0 GB, Linux 6.2 x86_64, container)",
			);
			const second = await tool(tools, "remote_run").execute(
				{ terminal: "bench-app", command: "true" },
				context(),
			);
			expect(second).not.toContain("cores");
			expect(
				await tool(tools, "remote_read").execute(
					{ terminal: "bench-app", action: "info" },
					context(),
				),
			).toContain("4 cores");
		} finally {
			machineInfo = undefined;
		}
	});

	it("lists ports and fetches a page through the proxy", async () => {
		const { calls, fetchImpl } = fakeOpenWebUi(
			withWorkspace((call) => {
				if (call.url.pathname.endsWith("/ports"))
					return { json: { ports: [{ port: 8080, process: "python3" }] } };
				if (call.url.pathname.includes("/proxy/8080/"))
					return {
						text: "<script>\n(() => { parent.postMessage({type: 'terminal-browser-state'}, '*'); })();\n</script><h1>ok</h1><script>app()</script>",
						contentType: "text/html",
					};
				if (call.url.pathname.includes("/proxy/9999/"))
					return { status: 404, json: { detail: "Port not found" } };
				return done();
			}),
		);
		const tools = createRemoteTerminalTools({
			getConfig: () => CONFIG,
			fetchImpl,
		});
		expect(
			await tool(tools, "remote_read").execute(
				{ terminal: "bench-app", action: "ports" },
				context(),
			),
		).toContain("port=8080  process=python3");
		const page = await tool(tools, "remote_read").execute(
			{
				terminal: "bench-app",
				action: "fetch",
				port: 8080,
				path: "/api/health?full=1",
			},
			context(),
		);
		// Open Terminal's own preview script is gone; the page's script stays.
		expect(page).toContain(
			"GET :8080/api/health?full=1 -> HTTP 200 (text/html)\n<h1>ok</h1><script>app()</script>",
		);
		const proxied = calls.find((call) =>
			call.url.pathname.includes("/proxy/8080/"),
		);
		expect(proxied?.url.pathname).toBe(
			"/api/v1/machines/solidpc-bench-app/proxy/8080/api/health",
		);
		expect(proxied?.url.searchParams.get("full")).toBe("1");
		await expect(
			tool(tools, "remote_read").execute(
				{ terminal: "bench-app", action: "fetch", port: 9999, path: "/" },
				context(),
			),
		).rejects.toThrow(/Nothing of this account listens on port 9999/);
	});
});

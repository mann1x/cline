import type { AgentToolContext } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { createPlanModeCommandGuardExtension } from "./command-guard-extension";
import {
	createRemoteTerminalTools,
	type RemoteTerminalsConfig,
	type RemoteWorkspaceRecord,
	remoteTerminalsUnavailable,
	remoteWorkspaceId,
	removeRemoteWorkspace,
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
}

/** A fake Open WebUI: records every request, answers from a handler. */
function fakeOpenWebUi(
	handler: (call: Call) => { status?: number; json?: unknown; text?: string },
) {
	const calls: Call[] = [];
	const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
		const call: Call = {
			method: init?.method ?? "GET",
			url: new URL(String(input)),
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		};
		calls.push(call);
		const answer = handler(call);
		const text = answer.text ?? JSON.stringify(answer.json ?? {});
		return new Response(text, { status: answer.status ?? 200 });
	}) as typeof fetch;
	return { calls, fetchImpl };
}

const WORKSPACE = "/home/u76b162c1/cerebriline/1790_task";

/** Answers the workspace mkdir, then hands everything else to `rest`. */
function withWorkspace(
	rest: (call: Call) => { status?: number; json?: unknown; text?: string },
) {
	return (call: Call) => {
		const command = call.body?.command;
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
			"- bench-app: builds and benchmarks the app",
		);
		expect(tool(tools, "remote_run").description).toContain("- general");
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
		const [mkdir, run] = calls;
		expect(mkdir.url.pathname).toBe(
			"/api/v1/machines/solidpc-bench-app/execute",
		);
		expect(mkdir.body?.command).toBe(
			`mkdir -p "$HOME"/'cerebriline/1790_task' && cd "$HOME"/'cerebriline/1790_task' && pwd`,
		);
		expect(run.headers.Authorization).toBe("Bearer sk-test");
		expect(run.headers["X-Session-Id"]).toBe("1790_task");
		expect(run.body).toEqual({
			command: "echo hello",
			cwd: `${WORKSPACE}/src`,
			env: { HOME: WORKSPACE },
		});
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
				if (call.method === "POST")
					return {
						json: { id: "p4", status: "running", next_offset: 0, output: [] },
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
		const kill = calls.find((call) => call.method === "DELETE");
		expect(kill?.url.pathname).toBe(
			"/api/v1/machines/solidpc-bench-app/execute/p4",
		);
		expect(kill?.url.searchParams.get("force")).toBe("true");
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
		).rejects.toThrow(/no remote terminal called "gpu".*bench-app, general/);
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
	});
});

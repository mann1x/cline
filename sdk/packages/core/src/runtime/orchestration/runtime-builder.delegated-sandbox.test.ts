import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent, AgentTool } from "@cline/shared";
import { setHomeDir } from "@cline/shared/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDelegatedSandboxes } from "../../extensions/tools/team/delegated-sandboxes";
import type { CoreSessionConfig } from "../../types/config";
import { createRevisionLog, type RevisionLog } from "../atomic/file-revisions";

// The two delegated paths the builder runs itself -- configured agents and
// teammates -- on private workspaces: writes land in the agent's overlay, come
// back to the lead as revisions attributed to it, the overlay goes when the
// agent does, and the shell is there only when the sandbox can launch it.

type Behaviour = (
	tools: AgentTool[],
	input: string,
) => Promise<{ text: string; finishReason?: string }>;
let behaviour: Behaviour = async () => ({ text: "done" });
const constructed: Array<{ tools: AgentTool[]; systemPrompt?: string }> = [];

vi.mock("./session-runtime-orchestrator", () => ({
	SessionRuntime: class MockSessionRuntime {
		private readonly tools: AgentTool[];
		constructor(config: { tools: AgentTool[]; systemPrompt?: string }) {
			constructed.push(config);
			this.tools = config.tools;
		}
		getAgentId(): string {
			return "delegated-agent";
		}
		getConversationId(): string {
			return "delegated-conversation";
		}
		subscribeEvents(_listener: (event: AgentEvent) => void): () => void {
			return () => {};
		}
		canStartRun(): boolean {
			return true;
		}
		getMessages(): unknown[] {
			return [];
		}
		abort(): void {}
		updateConnection(): void {}
		async run(input: string): Promise<unknown> {
			const outcome = await behaviour(this.tools, input);
			return {
				text: outcome.text,
				iterations: 1,
				finishReason: outcome.finishReason ?? "completed",
				usage: { inputTokens: 1, outputTokens: 1 },
			};
		}
		async continue(input: string): Promise<unknown> {
			return this.run(input);
		}
	},
}));

const ctx = { agentId: "delegated", conversationId: "c", iteration: 1 };

function tool(tools: AgentTool[], name: string): AgentTool {
	const found = tools.find((entry) => entry.name === name);
	if (!found) {
		throw new Error(`no ${name} tool`);
	}
	return found;
}

async function write(tools: AgentTool[], file: string, text: string) {
	await tool(tools, "read_files").execute({ files: [{ path: file }] }, ctx);
	const result = await tool(tools, "editor").execute(
		{ path: file, new_text: text },
		ctx,
	);
	if (JSON.stringify(result).includes('"success":false')) {
		throw new Error(`editor refused: ${JSON.stringify(result)}`);
	}
}

describe("delegated paths the runtime builder runs, on private workspaces", () => {
	const previousHome = process.env.HOME;
	let base: string;
	let ws: string;
	let overlays: string;
	let log: RevisionLog;

	beforeEach(async () => {
		constructed.length = 0;
		behaviour = async () => ({ text: "done" });
		base = await fs.mkdtemp(path.join(os.tmpdir(), "builder-sandbox-"));
		ws = path.join(base, "ws");
		overlays = path.join(base, "overlays");
		const home = path.join(base, "home");
		await fs.mkdir(path.join(ws, ".cline", "agents"), { recursive: true });
		await fs.mkdir(overlays, { recursive: true });
		await fs.mkdir(home, { recursive: true });
		process.env.HOME = home;
		setHomeDir(home);
		await fs.writeFile(path.join(ws, "a.txt"), "ORIG");
		await fs.writeFile(
			path.join(ws, ".cline", "agents", "writer.yml"),
			"---\nname: writer\ndescription: Writes files\n---\nYou write files.",
		);
		log = createRevisionLog();
	});

	afterEach(async () => {
		process.env.HOME = previousHome;
		setHomeDir(previousHome ?? "~");
		await fs.rm(base, { recursive: true, force: true });
	});

	async function build(
		options: { launcher?: boolean; commands?: boolean; teams?: boolean } = {},
	) {
		const sandboxes = createDelegatedSandboxes({
			provider: {
				workspaceRoot: ws,
				overlayRootFor: (id) =>
					path.join(overlays, id.replace(/[^A-Za-z0-9_.-]/g, "_")),
				...(options.launcher
					? {
							binaries: {
								launcher: "/nonexistent/launcher",
								hook: "/nonexistent/launcher",
								platforms: [process.platform],
							},
						}
					: {}),
			},
			commandsEnabled: options.commands ?? false,
			revisionLog: () => log,
		});
		const { DefaultRuntimeBuilder } = await import("./runtime-builder");
		const config: CoreSessionConfig = {
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			apiKey: "key",
			systemPrompt: "test",
			cwd: ws,
			workspaceRoot: ws,
			sessionId: "lead",
			enableTools: true,
			enableSpawnAgent: true,
			enableAgentTeams: options.teams ?? false,
		};
		return new DefaultRuntimeBuilder().build({
			config,
			configExtensions: [],
			delegatedSandboxes: () => sandboxes,
		});
	}

	describe("configured agents", () => {
		const callWriter = async (
			runtime: Awaited<ReturnType<typeof build>>,
			toolCallId = "call-7",
		) =>
			(await tool(runtime.tools, "subagent_writer").execute(
				{ prompt: "change a.txt" },
				{ ...ctx, agentId: "lead", toolCallId },
			)) as { text: string };

		it("writes into the agent's overlay and hands it back as the agent's revision", async () => {
			behaviour = async (tools) => {
				await write(tools, path.join(ws, "a.txt"), "FROM-WRITER");
				return { text: "changed a.txt" };
			};
			const runtime = await build();
			const output = await callWriter(runtime);

			expect(await fs.readFile(path.join(ws, "a.txt"), "utf8")).toBe("ORIG");
			const last = log.revisions(path.join(ws, "a.txt")).at(-1);
			expect(last?.by).toBe("agent:writer");
			expect(last?.body?.toString()).toBe("FROM-WRITER");
			expect(output.text).toContain(
				`a.txt — revision #${last?.index} (changed by "writer")`,
			);
			expect(await fs.readdir(overlays)).toEqual([]);
			await runtime.shutdown("test");
		});

		it("hands back and disposes an agent that fails", async () => {
			behaviour = async (tools) => {
				await write(tools, path.join(ws, "a.txt"), "HALF-DONE");
				throw new Error("agent blew up");
			};
			const runtime = await build();
			await expect(callWriter(runtime)).rejects.toThrow("agent blew up");

			expect(await fs.readFile(path.join(ws, "a.txt"), "utf8")).toBe("ORIG");
			const last = log.revisions(path.join(ws, "a.txt")).at(-1);
			expect(last?.by).toBe("agent:writer");
			expect(last?.body?.toString()).toBe("HALF-DONE");
			expect(await fs.readdir(overlays)).toEqual([]);
			await runtime.shutdown("test");
		});

		it("offers run_commands only when a launcher covers the platform and commands are allowed", async () => {
			const names = async (options: {
				launcher?: boolean;
				commands?: boolean;
			}) => {
				constructed.length = 0;
				const runtime = await build(options);
				await callWriter(runtime);
				await runtime.shutdown("test");
				return constructed.at(-1)?.tools.map((entry) => entry.name) ?? [];
			};
			expect(await names({ launcher: true, commands: true })).toContain(
				"run_commands",
			);
			expect(await names({ launcher: false, commands: true })).not.toContain(
				"run_commands",
			);
			expect(await names({ launcher: true, commands: false })).not.toContain(
				"run_commands",
			);
		});
	});

	describe("teammates", () => {
		const spawn = async (runtime: Awaited<ReturnType<typeof build>>) =>
			tool(runtime.tools, "team_spawn_teammate").execute(
				{ agentId: "t1", rolePrompt: "You write files." },
				{ ...ctx, agentId: "lead" },
			);
		const runTask = async (
			runtime: Awaited<ReturnType<typeof build>>,
			task: string,
		) =>
			(await tool(runtime.tools, "team_run_task").execute(
				{ agentId: "t1", task },
				{ ...ctx, agentId: "lead" },
			)) as { text: string };

		it("keeps one overlay across tasks and hands each task's changes back as the teammate's revisions", async () => {
			behaviour = async (tools, input) => {
				if (input.includes("first")) {
					await write(tools, path.join(ws, "a.txt"), "FIRST");
				} else {
					await write(tools, path.join(ws, "b.txt"), "SECOND");
				}
				return { text: "done" };
			};
			const runtime = await build({ teams: true });
			await spawn(runtime);

			const first = await runTask(runtime, "the first task");
			expect(await fs.readFile(path.join(ws, "a.txt"), "utf8")).toBe("ORIG");
			const a = log.revisions(path.join(ws, "a.txt")).at(-1);
			expect(a?.by).toBe("agent:t1");
			expect(a?.body?.toString()).toBe("FIRST");
			expect(first.text).toContain(`a.txt — revision #${a?.index}`);

			// Still open between tasks: it is the teammate's for its lifetime.
			expect(await fs.readdir(overlays)).not.toEqual([]);

			const second = await runTask(runtime, "the second task");
			const b = log.revisions(path.join(ws, "b.txt")).at(-1);
			expect(b?.by).toBe("agent:t1");
			expect(b?.body?.toString()).toBe("SECOND");
			// Only what changed since the last hand-back.
			expect(second.text).toContain("b.txt — revision");
			expect(second.text).not.toContain("a.txt — revision");
			await expect(fs.access(path.join(ws, "b.txt"))).rejects.toThrow();

			await tool(runtime.tools, "team_shutdown_teammate").execute(
				{ agentId: "t1" },
				{ ...ctx, agentId: "lead" },
			);
			await vi.waitFor(async () =>
				expect(await fs.readdir(overlays)).toEqual([]),
			);
			await runtime.shutdown("test");
		});

		it("hands back a failed task's changes and disposes the overlay on shutdown", async () => {
			behaviour = async (tools) => {
				await write(tools, path.join(ws, "a.txt"), "HALF-DONE");
				return { text: "", finishReason: "error" };
			};
			const runtime = await build({ teams: true });
			await spawn(runtime);
			await runTask(runtime, "a task that fails");

			const last = log.revisions(path.join(ws, "a.txt")).at(-1);
			expect(last?.by).toBe("agent:t1");
			expect(last?.body?.toString()).toBe("HALF-DONE");
			expect(await fs.readFile(path.join(ws, "a.txt"), "utf8")).toBe("ORIG");

			// The session ending shuts every teammate down, and their overlays go.
			await runtime.shutdown("session_stop");
			await vi.waitFor(async () =>
				expect(await fs.readdir(overlays)).toEqual([]),
			);
		});

		it("offers run_commands only when a launcher covers the platform and commands are allowed", async () => {
			const names = async (options: {
				launcher?: boolean;
				commands?: boolean;
			}) => {
				constructed.length = 0;
				const runtime = await build({ ...options, teams: true });
				await spawn(runtime);
				await runtime.shutdown("test");
				return constructed.at(-1)?.tools.map((entry) => entry.name) ?? [];
			};
			expect(await names({ launcher: true, commands: true })).toContain(
				"run_commands",
			);
			expect(await names({ launcher: false, commands: true })).not.toContain(
				"run_commands",
			);
			expect(await names({ launcher: true, commands: false })).not.toContain(
				"run_commands",
			);
		});
	});
});

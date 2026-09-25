import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDelegatedSandboxes } from "../../../extensions/tools/team/delegated-sandboxes";
import {
	createRevisionLog,
	type RevisionLog,
} from "../../atomic/file-revisions";

// Swarm workers on private workspaces: each worker's writes land in its own
// overlay, come back to the lead as revisions attributed to it, and the overlay
// is gone when the worker is -- on every exit path.

type Script = (tools: AgentTool[], name: string) => Promise<string>;
let script: Script = async () => "done";
const built: Array<{ tools: AgentTool[] }> = [];

vi.mock("../../../extensions/tools/team/delegated-agent", () => ({
	createDelegatedAgent: (options: {
		tools: AgentTool[];
		engineSessionId: string;
	}) => {
		built.push(options);
		// `<root>:swarm:<name>:<stamp>`
		const name = options.engineSessionId.split(":swarm:")[1]?.split(":")[0];
		const run = async () => ({
			text: await script(options.tools, name ?? "?"),
			finishReason: "completed",
			iterations: 1,
			usage: { inputTokens: 1, outputTokens: 1 },
		});
		return { run, runWithHead: run };
	},
}));

// Off unless a test turns it on: with a pool the round has a reducer, which
// is one more agent through the same runner.
let pooled = false;
vi.mock(
	"../../../extensions/context/polykv-session",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../extensions/context/polykv-session")
		>()),
		snapshotPolykvSession: async () =>
			pooled ? { poolId: "pool-1", borrowed: true } : undefined,
		readPolykvCapacity: async () => undefined,
	}),
);

const { createSessionSwarmTool } = await import("./spawn-tool");

const ctx = { agentId: "worker", conversationId: "c", iteration: 1 };

function tool(tools: AgentTool[], name: string): AgentTool {
	const found = tools.find((entry) => entry.name === name);
	if (!found) {
		throw new Error(`no ${name} tool`);
	}
	return found;
}

async function write(tools: AgentTool[], file: string, text: string) {
	// Read first: the editor refuses to overwrite a file it has not seen.
	await read(tools, file);
	const result = await tool(tools, "editor").execute(
		{ path: file, new_text: text },
		ctx,
	);
	if (JSON.stringify(result).includes('"success":false')) {
		throw new Error(`editor refused: ${JSON.stringify(result)}`);
	}
}

async function read(tools: AgentTool[], file: string): Promise<string> {
	return JSON.stringify(
		await tool(tools, "read_files").execute({ files: [{ path: file }] }, ctx),
	);
}

describe("swarm workers on private workspaces", () => {
	let base: string;
	let ws: string;
	let overlays: string;
	let log: RevisionLog;

	beforeEach(async () => {
		built.length = 0;
		pooled = false;
		script = async () => "done";
		base = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-sandbox-"));
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

	function swarm(options: { launcher?: boolean; commands?: boolean } = {}) {
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
		return createSessionSwarmTool(
			{
				getSession: () => ({ revisionLog: log, runtime: {} }) as never,
				subAgentStarts: new Map(),
				onAgentEvent: () => {},
				invokeBackendOptional: async () => {},
				sandboxes,
			},
			{
				providerId: "ollama",
				modelId: "m",
				cwd: ws,
				// Nothing listens: the round runs unpooled.
				baseUrl: "http://127.0.0.1:9",
				enableTools: true,
			} as never,
			"lead-session",
		) as unknown as {
			execute: (
				input: unknown,
				context: unknown,
			) => Promise<{ digest: string }>;
		};
	}

	const tasks = (...names: string[]) => ({
		systemPrompt: "s",
		tasks: names.map((name) => ({ name, task: `task for ${name}` })),
	});

	it("writes into the worker's overlay and hands it back as the worker's revision", async () => {
		script = async (tools) => {
			await write(tools, path.join(ws, "a.txt"), "FROM-W1");
			return "changed a.txt";
		};
		const output = await swarm().execute(tasks("w1"), {
			agentId: "lead",
			toolCallId: "call-1",
		});

		expect(await fs.readFile(path.join(ws, "a.txt"), "utf8")).toBe("ORIG");
		const revisions = log.revisions(path.join(ws, "a.txt"));
		expect(revisions.at(-1)?.by).toBe("agent:w1");
		expect(revisions.at(-1)?.body?.toString()).toBe("FROM-W1");
		// The report says where the work went.
		expect(output.digest).toContain(
			`a.txt — revision #${revisions.at(-1)?.index} (changed by "w1")`,
		);
		// And the overlay is gone.
		expect(await fs.readdir(overlays)).toEqual([]);
	});

	it("keeps two workers of one round from seeing each other's writes", async () => {
		let arrived = 0;
		let release!: () => void;
		const bothWritten = new Promise<void>((resolve) => {
			release = resolve;
		});
		const seen: Record<string, string> = {};
		script = async (tools, name) => {
			const other = name === "w1" ? "w2" : "w1";
			await write(tools, path.join(ws, `${name}.txt`), `by ${name}`);
			arrived += 1;
			if (arrived === 2) {
				release();
			}
			await bothWritten;
			seen[name] = await read(tools, path.join(ws, `${other}.txt`));
			return "ok";
		};
		await swarm().execute(tasks("w1", "w2"), {
			agentId: "lead",
			toolCallId: "call-1",
		});

		expect(seen.w1).not.toContain("by w2");
		expect(seen.w2).not.toContain("by w1");
		expect(log.revisions(path.join(ws, "w1.txt")).at(-1)?.by).toBe("agent:w1");
		expect(log.revisions(path.join(ws, "w2.txt")).at(-1)?.by).toBe("agent:w2");
		await expect(fs.access(path.join(ws, "w1.txt"))).rejects.toThrow();
		await expect(fs.access(path.join(ws, "w2.txt"))).rejects.toThrow();
	});

	it("hands back and disposes a worker that fails", async () => {
		script = async (tools) => {
			await write(tools, path.join(ws, "a.txt"), "HALF-DONE");
			throw new Error("worker blew up");
		};
		const output = await swarm().execute(tasks("w1"), {
			agentId: "lead",
			toolCallId: "call-1",
		});

		expect(await fs.readFile(path.join(ws, "a.txt"), "utf8")).toBe("ORIG");
		const last = log.revisions(path.join(ws, "a.txt")).at(-1);
		expect(last?.by).toBe("agent:w1");
		expect(last?.body?.toString()).toBe("HALF-DONE");
		expect(output.digest).toContain("worker blew up");
		expect(output.digest).toContain(`revision #${last?.index}`);
		expect(await fs.readdir(overlays)).toEqual([]);
	});

	it("offers run_commands only when a launcher covers the platform and commands are allowed", async () => {
		const names = async (options: {
			launcher?: boolean;
			commands?: boolean;
		}) => {
			built.length = 0;
			await swarm(options).execute(tasks("w1"), {
				agentId: "lead",
				toolCallId: "call-1",
			});
			return built[0]?.tools.map((entry) => entry.name) ?? [];
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

	it("names the reducer's handed-back revisions in the merged report, beside the workers'", async () => {
		pooled = true;
		script = async (tools, name) => {
			if (name === "reducer") {
				await write(tools, path.join(ws, "merged.txt"), "BY REDUCER");
				return '```json\n{"done": ["merged"]}\n```';
			}
			await write(tools, path.join(ws, `${name}.txt`), `by ${name}`);
			return `\`\`\`json\n{"done": ["${name}"]}\n\`\`\``;
		};
		const output = await swarm().execute(tasks("w1", "w2"), {
			agentId: "lead",
			toolCallId: "call-1",
		});

		const merged = log.revisions(path.join(ws, "merged.txt")).at(-1);
		expect(merged?.by).toBe("agent:reducer");
		expect(output.digest).toContain(
			`merged.txt — revision #${merged?.index} (created by "reducer")`,
		);
		expect(output.digest).toContain('(created by "w1")');
		expect(output.digest).toContain('(created by "w2")');
		await expect(fs.access(path.join(ws, "merged.txt"))).rejects.toThrow();
		expect(await fs.readdir(overlays)).toEqual([]);
	});
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTool, createTool } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskGraphStore } from "../tools/task-graph/store";
import { appendJournal, foldJournal, readJournal } from "./journal";
import type { PipelineDefinition } from "./model";
import { PipelineSession, type PipelineSessionOptions } from "./session";
import { createPipelineTool } from "./tool";
import { validatePipeline } from "./validate";
import { approvePipeline, savePipeline } from "./workspace";

/** Pipelines phase 2: agents, http, sub-runs, failure handling, re-runs, pick-up. */

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pipelines-p2-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const calls: { name: string; input: unknown }[] = [];
const fake = (name: string, answer: (input: unknown) => unknown) =>
	createTool<unknown, unknown>({
		name,
		description: name,
		inputSchema: { type: "object" },
		execute: async (input) => {
			calls.push({ name, input });
			return answer(input);
		},
	}) as AgentTool;

const tools = [
	fake("spawn_agent", () => ({ text: 'Here: ```json\n{"n": 2}\n```' })),
	fake("subagent_reviewer", () => ({ text: "looks fine" })),
	fake("spawn_swarm", () => ({ reports: [{ worker: 1 }, { worker: 2 }] })),
];

function session(extra: Partial<PipelineSessionOptions> = {}) {
	calls.length = 0;
	return new PipelineSession({
		workspaceRoot: root,
		sessionId: "s1",
		tools: () => tools,
		pollMs: 5,
		...extra,
	});
}

/** Saved and approved, as the person would. */
function approved(definition: PipelineDefinition) {
	const saved = savePipeline(root, definition);
	if (!saved.ok) throw new Error(saved.errors.join("; "));
	approvePipeline(root, definition.name);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("failure handling", () => {
	it("retries a failing node, then goes on", async () => {
		approved({
			name: "flaky",
			nodes: [
				{
					id: "once",
					type: "command",
					// Fails the first time only.
					command: `node -e "const f=require('fs');if(!f.existsSync('done.flag')){f.writeFileSync('done.flag','');process.exit(3)}"`,
					retry: { max: 2, wait: 0 },
				},
			],
		});
		const run = session().run("flaky");
		const result = await run.result();
		expect(result.status).toBe("done");
		const events = readJournal(run.journalPath);
		expect(events.filter((event) => event.t === "retry")).toHaveLength(1);
		expect(run.view().nodes[0]?.attempts).toBe(2);
	});

	it("fails the run once the retries are spent, saying how many there were", async () => {
		approved({
			name: "broken",
			nodes: [
				{
					id: "no",
					type: "command",
					command: "exit 4",
					retry: { max: 1, wait: 0 },
				},
			],
		});
		const result = await session().run("broken").result();
		expect(result.status).toBe("failed");
		expect(result.error).toContain("exited 4");
		expect(result.error).toContain("(after 2 attempts)");
		expect(result.failedNode).toBe("no");
	});

	it("continue: the error is the node's item and the run goes on", async () => {
		approved({
			name: "goes-on",
			nodes: [
				{ id: "bad", type: "command", command: "exit 2", onError: "continue" },
				{
					id: "after",
					type: "set",
					after: ["bad"],
					fields: { saw: "{{ $json.error }}" },
				},
			],
		});
		const result = await session().run("goes-on").result();
		expect(result.status).toBe("done");
		expect(JSON.stringify(result.items)).toContain("exited 2");
	});

	it("route: a failure goes to the error output, and the normal path is skipped", async () => {
		const definition: PipelineDefinition = {
			name: "routed",
			nodes: [
				{ id: "bad", type: "command", command: "exit 5", onError: "route" },
				{ id: "ok", type: "set", after: ["bad"], fields: { path: "ok" } },
				{
					id: "handle",
					type: "set",
					after: ["bad.error"],
					fields: { path: "error", why: "{{ $json.error }}" },
				},
			],
		};
		expect(validatePipeline(definition).ok).toBe(true);
		expect(
			validatePipeline({
				...definition,
				nodes: [
					{ ...definition.nodes[0], onError: "stop" },
					...definition.nodes.slice(1),
				],
			}).errors.join(" "),
		).toContain('"bad" has no output "error"');
		approved(definition);
		const run = session().run("routed");
		const result = await run.result();
		expect(result.status).toBe("done");
		const nodes = run.view().nodes;
		expect(nodes.find((node) => node.id === "ok")?.status).toBe("skipped");
		expect(nodes.find((node) => node.id === "handle")?.status).toBe("done");
		expect(JSON.stringify(result.items)).toContain('"path":"error"');
	});

	it("onFailure starts its pipeline with what failed; never itself, never in a loop", async () => {
		approved({
			name: "report",
			inputs: { error: { type: "string" }, node: { type: "string" } },
			nodes: [
				{
					id: "note",
					type: "set",
					fields: { line: "{{ $vars.node }}: {{ $vars.error }}" },
				},
			],
		});
		approved({
			name: "main",
			onFailure: "report",
			nodes: [{ id: "step", type: "command", command: "exit 7" }],
		});
		const ended: string[] = [];
		const s = session({ onRunEnded: (_run, lines) => ended.push(...lines) });
		await s.run("main").result();
		await tick();
		const line = ended.find((entry) => entry.includes("onFailure"));
		expect(line).toMatch(
			/main-1 failed; its onFailure pipeline report started as report-1/,
		);
		const report = join(
			root,
			".cerebriline",
			"pipeline-runs",
			"report-1.jsonl",
		);
		for (
			let i = 0;
			i < 200 && foldJournal(readJournal(report)).status !== "done";
			i++
		)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(
			foldJournal(readJournal(report)).nodes.get("note")?.output?.items,
		).toEqual([{ line: 'step: node "step" failed: exited 7' }]);
		expect(
			validatePipeline({
				name: "x",
				onFailure: "X",
				nodes: [{ id: "a", type: "merge" }],
			}).errors,
		).toContain('"onFailure" names this pipeline itself');
	});
});

describe("agent, swarm, http and pipeline nodes", () => {
	it("an agent node calls spawn_agent, or a configured agent's tool, and reads JSON when asked", async () => {
		approved({
			name: "agents",
			nodes: [
				{ id: "count", type: "agent", task: "Count to {{ 2 }}", json: true },
				{
					id: "review",
					type: "agent",
					agent: "reviewer",
					after: ["count"],
					task: "Review n={{ $json.n }}",
				},
			],
		});
		const run = session().run("agents");
		const result = await run.result();
		expect(result.status).toBe("done");
		expect(calls[0]).toEqual({
			name: "spawn_agent",
			input: { task: "Count to 2", name: "count", wait: true },
		});
		expect(calls[1]).toEqual({
			name: "subagent_reviewer",
			input: { prompt: "Review n=2", wait: true },
		});
		expect(result.items).toEqual([{ text: "looks fine" }]);
	});

	it("a swarm node gives one item per worker", async () => {
		approved({
			name: "fan-out",
			inputs: { files: { type: "array", default: ["a.ts", "b.ts"] } },
			nodes: [
				{
					id: "read",
					type: "swarm",
					instructions: "You read one file.",
					tasks: "$vars.files",
				},
			],
		});
		const result = await session().run("fan-out").result();
		expect(result.items).toEqual([{ worker: 1 }, { worker: 2 }]);
		expect(calls[0]?.input).toEqual({
			systemPrompt: "You read one file.",
			tasks: [{ task: "a.ts" }, { task: "b.ts" }],
			wait: true,
		});
	});

	describe("http", () => {
		let server: Server;
		let base = "";
		beforeEach(async () => {
			server = createServer((request, response) => {
				let body = "";
				request.on("data", (chunk) => {
					body += chunk;
				});
				request.on("end", () => {
					if (request.url === "/missing") {
						response.writeHead(404).end("no such thing");
						return;
					}
					response.writeHead(200, { "content-type": "application/json" }).end(
						JSON.stringify({
							method: request.method,
							got: body ? JSON.parse(body) : null,
						}),
					);
				});
			});
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		});
		afterEach(async () => {
			await new Promise((resolve) => server.close(resolve));
		});

		it("asks the person unless the pipeline_http policy approves; a 404 fails it", async () => {
			approved({
				name: "web",
				inputs: { base: { type: "string" } },
				nodes: [
					{
						id: "post",
						type: "http",
						method: "post",
						url: "{{ $vars.base }}/things",
						body: { name: "{{ $vars.base }}" },
					},
				],
			});
			const asked: string[] = [];
			const denied = await session({
				requestApproval: async (request) => {
					asked.push(JSON.stringify(request.input));
					return { approved: false };
				},
			})
				.run("web", { base })
				.result();
			expect(asked[0]).toContain('"method":"POST"');
			expect(denied.error).toContain("the person did not approve POST");

			const allowed = await session({
				toolPolicies: { pipeline_http: { autoApprove: true } },
			})
				.run("web", { base })
				.result();
			expect(allowed.status).toBe("done");
			expect(allowed.items).toEqual([
				{
					status: 200,
					headers: expect.any(Object),
					body: { method: "POST", got: { name: base } },
				},
			]);

			approved({
				name: "missing",
				inputs: { base: { type: "string" } },
				nodes: [{ id: "get", type: "http", url: "{{ $vars.base }}/missing" }],
			});
			const missing = await session({
				toolPolicies: { pipeline_http: { autoApprove: true } },
			})
				.run("missing", { base })
				.result();
			expect(missing.error).toContain("GET returned 404: no such thing");
		});
	});

	it("a pipeline node runs another pipeline's approved version and takes its items", async () => {
		approved({
			name: "child",
			inputs: { n: { type: "number" } },
			nodes: [
				{ id: "double", type: "set", fields: { value: "{{ $vars.n * 2 }}" } },
			],
		});
		approved({
			name: "parent",
			nodes: [
				{ id: "call", type: "pipeline", pipeline: "child", inputs: { n: 21 } },
			],
		});
		const result = await session().run("parent").result();
		expect(result.status).toBe("done");
		expect(result.items).toEqual([{ value: 42 }]);
		const parentRun = foldJournal(
			readJournal(join(root, ".cerebriline", "pipeline-runs", "child-1.jsonl")),
		);
		expect(parentRun.run?.parent).toBe("parent-1");
	});

	it("refuses a pipeline inside itself, at save and through another one", async () => {
		expect(
			validatePipeline({
				name: "loop",
				nodes: [{ id: "again", type: "pipeline", pipeline: "Loop" }],
			}).errors.join(" "),
		).toContain("a pipeline does not run itself");
		approved({
			name: "ping",
			nodes: [{ id: "to", type: "pipeline", pipeline: "pong" }],
		});
		approved({
			name: "pong",
			nodes: [{ id: "back", type: "pipeline", pipeline: "ping" }],
		});
		const result = await session().run("ping").result();
		expect(result.status).toBe("failed");
		expect(result.error).toContain(
			"ping is already running above this node (ping → pong → ping)",
		);
	});
});

describe("tests and re-runs", () => {
	it("test until: stops after the node, and the run is done", async () => {
		const s = session();
		const tool = createPipelineTool(s, root);
		savePipeline(root, {
			name: "steps",
			nodes: [
				{ id: "a", type: "set", fields: { v: 1 } },
				{ id: "b", type: "set", after: ["a"], fields: { v: 2 } },
				{ id: "c", type: "set", after: ["b"], fields: { v: 3 } },
			],
		});
		const [answer] = (await tool.execute(
			{ action: "test", name: "steps", until: "b" },
			{ agentId: "lead", iteration: 1 } as never,
		)) as { result: string; success: boolean }[];
		expect(answer?.success).toBe(true);
		expect(answer?.result).toContain("- b: done");
		expect(answer?.result).toContain("- c: pending");
	});

	it("rerun from a node reuses what came before it and runs the rest", async () => {
		approved({
			name: "build",
			inputs: { fail: { type: "boolean", default: true } },
			nodes: [
				{
					id: "prepare",
					type: "command",
					command: `node -e "require('fs').appendFileSync('prepared.txt','x\\n')"`,
				},
				{
					id: "compile",
					type: "command",
					after: ["prepare"],
					command: `node -e "process.exit(require('fs').existsSync('broken.flag')?1:0)"`,
				},
				{
					id: "ship",
					type: "set",
					after: ["compile"],
					fields: { shipped: true },
				},
			],
		});
		writeFileSync(join(root, "broken.flag"), "");
		const s = session();
		const first = await s.run("build").result();
		expect(first.status).toBe("failed");
		rmSync(join(root, "broken.flag"));
		const again = s.rerun("build-1", "compile");
		const result = await again.result();
		expect(result.status).toBe("done");
		expect(result.items).toEqual([{ shipped: true }]);
		// `prepare` ran once: its output came from build-1.
		expect(readFileSync(join(root, "prepared.txt"), "utf8")).toBe("x\n");
		const fold = foldJournal(readJournal(again.journalPath));
		expect(fold.nodes.get("prepare")?.reused).toBe("build-1");
		expect(fold.run?.from).toBe("build-1");
	});
});

describe("picking runs up after a reload", () => {
	it("this session's interrupted runs are picked up; another session's and a sub-run's are not", async () => {
		const board = new TaskGraphStore();
		approved({
			name: "long",
			nodes: [
				{ id: "first", type: "set", fields: { v: 1 } },
				{
					id: "second",
					type: "command",
					after: ["first"],
					command: "echo second",
					onError: "continue",
				},
				{ id: "third", type: "set", after: ["second"], fields: { v: 3 } },
			],
		});
		const dir = join(root, ".cerebriline", "pipeline-runs");
		const hash = (await import("./workspace")).findPipeline(root, "long")
			?.hash as string;
		const journal = (id: string, extra: Record<string, unknown>) => {
			const path = join(dir, `${id}.jsonl`);
			appendJournal(path, {
				t: "run",
				ts: 1,
				run: id,
				pipeline: "long",
				hash,
				inputs: {},
				...extra,
			} as never);
			appendJournal(path, { t: "start", ts: 2, node: "first", attempt: 1 });
			appendJournal(path, {
				t: "end",
				ts: 3,
				node: "first",
				output: { items: [{ v: 1 }], port: "out" },
			});
			appendJournal(path, { t: "start", ts: 4, node: "second", attempt: 1 });
			return path;
		};
		const mine = journal("long-1", { session: "s1" });
		const theirs = journal("long-2", { session: "s2" });
		const child = journal("long-3", { session: "s1", parent: "other-1" });
		const s = session({ board });
		const lines = s.recoverInterrupted();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(
			"long-1 was running when the window closed; it was picked up",
		);
		await s.get("long-1")?.result();
		const fold = foldJournal(readJournal(mine));
		expect(fold.status).toBe("done");
		// Interrupted, and `onError: continue` said what a failure does.
		expect(JSON.stringify(fold.nodes.get("second")?.output)).toContain(
			"interrupted",
		);
		expect(foldJournal(readJournal(theirs)).status).toBe("running");
		expect(foldJournal(readJournal(child)).status).toBe("stopped");
	});
});

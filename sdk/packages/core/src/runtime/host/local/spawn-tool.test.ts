import { beforeEach, describe, expect, it, vi } from "vitest";

const built: Array<Record<string, unknown>> = [];

vi.mock("../../../extensions/tools/team/delegated-agent", () => ({
	createDelegatedAgent: (options: Record<string, unknown>) => {
		built.push(options);
		const result = {
			text: "done",
			finishReason: "stop",
			usage: { inputTokens: 1, outputTokens: 1 },
		};
		return {
			run: async () => result,
			runWithHead: async () => result,
		};
	},
}));

const { createSessionSwarmTool } = await import("./spawn-tool");

function swarmOn(providerId: string) {
	return createSessionSwarmTool(
		{
			getSession: () => undefined,
			subAgentStarts: {} as never,
			onAgentEvent: () => {},
			invokeBackendOptional: async () => {},
		},
		{
			providerId,
			modelId: "m",
			cwd: "/tmp",
			// Nothing listens here: the snapshot and the capacity read fail,
			// which is the lead-has-no-pool case.
			baseUrl: "http://127.0.0.1:9",
			enableTools: true,
		} as never,
		"lead-session",
		// The session's own executors, which is what puts `ask_question` in
		// a toolset at all.
		{ askQuestion: async () => "answer" } as never,
	);
}

describe("createSessionSwarmTool workers", () => {
	beforeEach(() => {
		built.length = 0;
	});

	it("gives each worker its own engine session and, on PolyKV with no lead pool, the pool tree", async () => {
		await (
			swarmOn("opencoti") as unknown as {
				execute: (i: unknown, c: unknown) => Promise<unknown>;
			}
		).execute(
			{ systemPrompt: "Check the syntax.", tasks: [{ task: "a" }] },
			{ agentId: "lead" },
		);
		const worker = built[0];
		expect(worker?.engineSessionId).toMatch(/^lead-session:swarm:worker-1:/);
		expect(worker?.polykvWorker).toEqual({ group: "lead-session", layers: 1 });
		expect(worker?.pinnedHead).toEqual(["# Your role\n\nCheck the syntax."]);
	});

	it("keeps an unpooled worker's prompt as written", async () => {
		await (
			swarmOn("ollama") as unknown as {
				execute: (i: unknown, c: unknown) => Promise<unknown>;
			}
		).execute(
			{ systemPrompt: "Check the syntax.", tasks: [{ task: "a" }] },
			{ agentId: "lead" },
		);
		const worker = built[0];
		expect(worker?.engineSessionId).toMatch(/^lead-session:swarm:worker-1:/);
		expect(worker?.polykvWorker).toBeUndefined();
		expect(worker?.prompt).toBe("Check the syntax.");
	});

	it("gives a configured agent's worker only that agent's tools", async () => {
		await (
			swarmOn("ollama") as unknown as {
				execute: (i: unknown, c: unknown) => Promise<unknown>;
			}
		).execute(
			{ systemPrompt: "s", tasks: [{ task: "a", tools: ["read_files"] }] },
			{ agentId: "lead" },
		);
		expect(
			(built[0]?.tools as Array<{ name: string }>).map((tool) => tool.name),
		).toEqual(["read_files"]);
	});

	it("gives a worker no way to ask the user a question", async () => {
		await (
			swarmOn("ollama") as unknown as {
				execute: (i: unknown, c: unknown) => Promise<unknown>;
			}
		).execute(
			{ systemPrompt: "s", tasks: [{ task: "a" }] },
			{ agentId: "lead" },
		);
		const names = (built[0]?.tools as Array<{ name: string }>).map(
			(tool) => tool.name,
		);
		expect(names.length).toBeGreaterThan(0);
		expect(names).not.toContain("ask_question");
	});
});

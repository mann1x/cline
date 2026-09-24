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

const { createSessionSwarmTool, appendHandbackNote } = await import(
	"./spawn-tool"
);

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
		const tools = built[0]?.tools as Array<{
			name: string;
			lifecycle?: { completesRun?: boolean };
		}>;
		expect(tools.length).toBeGreaterThan(0);
		// It may ask -- the lead, not the user: the call ends the worker and
		// the question is its report (`delegated-tools.ts`).
		for (const tool of tools.filter((entry) => entry.name === "ask_question")) {
			expect(tool.lifecycle?.completesRun).toBe(true);
		}
	});
});

// The failure this closes: an agent hands its work back as revisions the lead
// was never told about, so the lead judged the agent by its own untouched
// on-disk copy and called the (correct) agent a liar (pandorum 2026-09-24).
describe("the hand-back note on the agent's answer", () => {
	it("names each changed file and its revision, and says the workspace is unchanged", () => {
		const context = {
			subAgentId: "a",
			conversationId: "c",
			parentAgentId: "lead",
			input: { name: "qa-fixer" },
			result: { text: "Fixed manic_miner.html; harness reports ok:true." },
		} as never as Parameters<typeof appendHandbackNote>[0];

		appendHandbackNote(context, "qa-fixer", [
			{ rel: "manic_miner.html", index: 3, kind: "modified" },
		]);

		const text = (context as { result: { text: string } }).result.text;
		// The agent's own answer is preserved.
		expect(text).toContain("Fixed manic_miner.html");
		// And the lead is told exactly where the work went.
		expect(text).toContain("manic_miner.html — revision #3");
		expect(text).toContain('"qa-fixer"');
		expect(text).toContain("UNCHANGED");
		expect(text).toContain("restore_file");
		expect(text).toContain('revision: "#3"');
	});

	it("warns the handed-back changes are unvetted when the agent gave no answer", () => {
		const context = {
			input: { name: "fix-manic-miner" },
			// The swallowed-tool-call shape: empty answer, a normal "completed"
			// finish because the loop saw no tool call on the final turn.
			result: { text: "", finishReason: "completed" },
		} as never as Parameters<typeof appendHandbackNote>[0];

		appendHandbackNote(context, "fix-manic-miner", [
			{ rel: "manic_miner.html", index: 2, kind: "modified" },
		]);

		const text = (context as { result: { text: string } }).result.text;
		expect(text).toContain("without an answer of its own");
		expect(text).toContain("UNVETTED");
		// The revision is still named so the lead can go and inspect it.
		expect(text).toContain("manic_miner.html — revision #2");
		expect(text).toContain('revision: "#2"');
		// It must not read as a success, and must not use the confident wording.
		expect(text).toContain("Do not treat its run as successful");
		expect(text).not.toContain("Its changes are held for you as revisions");
	});

	it("flags an empty-answer run that changed nothing as possibly unfinished", () => {
		const context = {
			input: { name: "prober" },
			result: { text: "   ", finishReason: "completed" },
		} as never as Parameters<typeof appendHandbackNote>[0];

		appendHandbackNote(context, "prober", []);

		const text = (context as { result: { text: string } }).result.text;
		expect(text).toContain("without an answer of its own");
		expect(text).toContain("Do not treat its run as successful");
		// The confident "nothing to hand back" wording is for an agent that
		// actually answered; it must not be used for a silent, empty run.
		expect(text).not.toContain("recorded no file changes to hand back");
	});

	it("still tells the lead when the agent changed nothing", () => {
		const context = {
			input: { name: "checker" },
			result: { text: "Looked, nothing to fix." },
		} as never as Parameters<typeof appendHandbackNote>[0];

		appendHandbackNote(context, "checker", []);

		const text = (context as { result: { text: string } }).result.text;
		expect(text).toContain("Looked, nothing to fix.");
		expect(text).toContain("no file changes to hand back");
	});

	it("does nothing when there is no result to annotate", () => {
		const context = { input: { name: "x" } } as never as Parameters<
			typeof appendHandbackNote
		>[0];
		// Must not throw when a run ended in error with no result object.
		expect(() =>
			appendHandbackNote(context, "x", [
				{ rel: "a.txt", index: 2, kind: "created" },
			]),
		).not.toThrow();
	});
});

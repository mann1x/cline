import { beforeEach, describe, expect, it, vi } from "vitest";

const runMock = vi.fn();
const abortMock = vi.fn();
const constructed: Array<{
	onEvent?: (event: unknown) => void;
	tools: Array<{
		name: string;
		execute: (i: unknown, c: unknown) => Promise<unknown>;
	}>;
}> = [];

vi.mock("../../../runtime/orchestration/session-runtime-orchestrator", () => {
	return {
		SessionRuntime: class MockSessionRuntime {
			constructor(config: never) {
				constructed.push(config);
			}

			getAgentId(): string {
				return "sub-agent-1";
			}

			getConversationId(): string {
				return "conv-sub-1";
			}

			subscribeEvents(): () => void {
				return () => {};
			}

			async run(input: string): Promise<unknown> {
				return runMock(input);
			}

			abort(reason?: unknown): void {
				abortMock(reason);
			}
		},
	};
});

/**
 * The worker struggle supervisor watched only swarm workers. A configured
 * agent grinds the same way and gets the same layer: one nudge to commit a
 * SUMMARY, then a stop in the supervisor's words for the lead to decide on.
 */
describe("a configured agent's struggle supervisor", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		constructed.length = 0;
	});

	it("nudges a grinding agent on a tool result, then stops the run in its own words", async () => {
		const { createConfiguredAgentTools } = await import(
			"./configured-agent-tool.js"
		);
		const { isWorkerStruggleStop } = await import(
			"../../../runtime/safety/worker-struggle.js"
		);
		let nudged = "";
		runMock.mockImplementation(async () => {
			const config = constructed.at(-1);
			const spent = (iteration: number) => {
				config?.onEvent?.({ type: "iteration_start", iteration });
				config?.onEvent?.({
					type: "content_end",
					contentType: "reasoning",
					reasoning:
						"Let me probe once more.\n\nI have used my thinking budget. I must stop analysing now.",
				});
				config?.onEvent?.({
					type: "iteration_end",
					iteration,
					hadToolCalls: true,
					toolCallCount: 1,
				});
			};
			for (let iteration = 1; iteration <= 3; iteration += 1) {
				spent(iteration);
			}
			const probe = config?.tools.find((entry) => entry.name === "probe");
			nudged = String(await probe?.execute({}, {}));
			for (let iteration = 4; iteration <= 10; iteration += 1) {
				spent(iteration);
			}
			return {
				text: "so far",
				iterations: 10,
				finishReason: "completed",
				usage: { inputTokens: 1, outputTokens: 1 },
			};
		});
		const connection = {
			providerId: "ollama",
			modelId: "local-model",
			baseUrl: "http://127.0.0.1:11434",
		};
		const [tool] = createConfiguredAgentTools({
			configProvider: {
				getRuntimeConfig: () => connection as never,
				getConnectionConfig: () => connection,
				updateConnectionDefaults: () => {},
			},
			agents: [
				{
					name: "reviewer",
					description: "reviews code",
					systemPrompt: "You review code.",
				},
			],
			createSubAgentTools: () => [
				{
					name: "probe",
					description: "",
					inputSchema: { type: "object" },
					execute: async () => "probed",
				} as never,
			],
		});
		await (
			tool as { execute: (i: unknown, c: unknown) => Promise<unknown> }
		).execute({ prompt: "go" }, { agentId: "lead" });
		expect(nudged).toContain("probed");
		expect(nudged).toContain("SUMMARY");
		expect(abortMock).toHaveBeenCalledTimes(1);
		const reason = abortMock.mock.calls[0]?.[0] as Error;
		expect(isWorkerStruggleStop(reason.message)).toBe(true);
	});
});

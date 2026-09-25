import { beforeEach, describe, expect, it, vi } from "vitest";

const runMock = vi.fn();

vi.mock("../../../runtime/orchestration/session-runtime-orchestrator", () => {
	return {
		SessionRuntime: class MockSessionRuntime {
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
		},
	};
});

/**
 * #78: a configured agent's file may name a provider and a model of its own,
 * which is exactly when the row should say which -- and it said so only once
 * the agent was done.
 */
describe("a configured agent's model, while it runs", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("is reported before the agent finishes", async () => {
		const { createConfiguredAgentTools } = await import(
			"./configured-agent-tool.js"
		);
		const updates: unknown[] = [];
		let updatesWhileRunning: unknown[] = [];
		runMock.mockImplementation(async () => {
			updatesWhileRunning = [...updates];
			return {
				text: "report",
				iterations: 1,
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
					modelId: "reviewer-model",
				},
			],
		});

		await (
			tool as { execute: (i: unknown, c: unknown) => Promise<unknown> }
		).execute(
			{ prompt: "go" },
			{
				agentId: "lead",
				emitUpdate: (update: unknown) => updates.push(update),
			},
		);

		expect(updatesWhileRunning).toContainEqual({
			providerId: "ollama",
			modelId: "reviewer-model",
		});
	});
});

import { describe, expect, it } from "vitest";
import {
	buildConfiguredAgentToolName,
	createConfiguredAgentTools,
} from "./configured-agent-tool";

describe("configured agent tools", () => {
	it("builds stable subagent tool names", () => {
		expect(buildConfiguredAgentToolName("Code Reviewer")).toBe(
			"subagent_code_reviewer",
		);
		expect(buildConfiguredAgentToolName("___")).toBe("subagent_agent");
	});

	it("matches spawn_agent timeout and retry policy", () => {
		const [tool] = createConfiguredAgentTools({
			configProvider: {
				getRuntimeConfig: () => ({
					providerId: "anthropic",
					modelId: "claude-sonnet-4-6",
					apiKey: "key",
				}),
				getConnectionConfig: () => ({
					providerId: "anthropic",
					modelId: "claude-sonnet-4-6",
					apiKey: "key",
				}),
				updateConnectionDefaults: () => {},
			},
			agents: [
				{
					name: "code-reviewer",
					description: "Reviews code",
					systemPrompt: "You are a code reviewer.",
				},
			],
		});

		expect(tool?.name).toBe("subagent_code_reviewer");
		expect(tool?.timeoutMs).toBe(300000);
		expect(tool?.retryable).toBe(false);
	});
});

/**
 * The gate, stubbed so the sub-agent never runs.
 *
 * `run` returns a result of its own instead of invoking the task: the point
 * under test is which endpoint the agent was gated against, and actually
 * running the sub-agent would stand up a session runtime and talk to a
 * provider to learn nothing more.
 */
function recordingGates(): {
	keys: string[];
	slotGates: {
		for: (key: string) => {
			run: <T>(task: () => Promise<T>) => Promise<T>;
			active: () => number;
		};
	};
} {
	const keys: string[] = [];
	return {
		keys,
		slotGates: {
			for: (key: string) => {
				keys.push(key);
				return {
					run: (async () => ({
						text: "gated",
						iterations: 1,
						finishReason: "stop",
						usage: { inputTokens: 0, outputTokens: 0 },
					})) as never,
					active: () => 0,
				};
			},
		},
	};
}

function runAgent(input: {
	agent: Parameters<typeof createConfiguredAgentTools>[0]["agents"][number];
	sessionProvider?: string;
	sessionBaseUrl?: string;
	resolveProviderConnection?: (providerId: string) => never;
}): { keys: string[]; execute: () => Promise<unknown> } {
	const { keys, slotGates } = recordingGates();
	const connection = {
		providerId: input.sessionProvider ?? "ollama",
		modelId: "local-model",
		baseUrl: input.sessionBaseUrl ?? "http://127.0.0.1:11434",
	};
	const [tool] = createConfiguredAgentTools({
		configProvider: {
			getRuntimeConfig: () => ({ ...connection, slotGates }) as never,
			getConnectionConfig: () => connection,
			updateConnectionDefaults: () => {},
		},
		agents: [input.agent],
		...(input.resolveProviderConnection
			? { resolveProviderConnection: input.resolveProviderConnection }
			: {}),
	});
	return {
		keys,
		execute: () =>
			(
				tool as { execute: (i: unknown, c: unknown) => Promise<unknown> }
			).execute({ prompt: "go" }, { agentId: "lead" }),
	};
}

/**
 * Configured agents ran ungated until now, while `spawn_agent` was gated. That
 * is backwards: `spawn_agent` sub-agents all share the session's connection,
 * and configured agents are the only ones that can name another.
 */
describe("holding configured agents to their own endpoint", () => {
	it("gates an agent that inherits the session connection against that endpoint", async () => {
		const { keys, execute } = runAgent({
			agent: {
				name: "reviewer",
				description: "reviews code",
				systemPrompt: "You review code.",
			},
		});

		await execute();

		expect(keys).toEqual(["ollama http://127.0.0.1:11434"]);
	});

	// The tester's case: local agents and cloud agents in one turn. Different
	// keys is what lets them run at once instead of queueing behind each other.
	it("gates an agent naming another provider against that provider instead", async () => {
		const { keys, execute } = runAgent({
			agent: {
				name: "auditor",
				description: "audits code",
				systemPrompt: "You audit code.",
				providerId: "anthropic",
			},
			resolveProviderConnection: (() => ({
				apiKey: "key",
				baseUrl: "https://api.anthropic.com",
			})) as never,
		});

		await execute();

		expect(keys).toEqual(["anthropic https://api.anthropic.com"]);
	});
});

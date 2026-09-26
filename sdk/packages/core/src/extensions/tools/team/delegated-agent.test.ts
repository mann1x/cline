import type { AgentEvent, AgentTool } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { createWorkerStruggleSupervisor } from "../../../runtime/safety/worker-struggle";
import {
	buildDelegatedAgentConfig,
	createDelegatedAgentCheck,
	createDelegatedAgentConfigProvider,
} from "./delegated-agent";

function provider(
	pinned?: Parameters<typeof createDelegatedAgentConfigProvider>[1],
) {
	return createDelegatedAgentConfigProvider(
		{
			providerId: "ollama",
			modelId: "small",
			apiKey: "",
			baseUrl: "http://localhost:11434",
			providerConfig: { contextWindow: 8_192 },
			temperature: 0.2,
		},
		pinned,
	);
}

describe("createDelegatedAgentConfigProvider", () => {
	it("follows the session when nothing is pinned", () => {
		const config = provider();
		config.updateConnectionDefaults({ modelId: "large", apiKey: "refreshed" });
		expect(config.getConnectionConfig()).toMatchObject({
			modelId: "large",
			apiKey: "refreshed",
		});
	});

	// The agents have a connection of their own, and the host still pushes the
	// session's model at them on a mid-run switch. Taking that push would put
	// them back on the lead's model with the lead's context window, which is the
	// one window between four scopes that having their own configuration exists
	// to end.
	it("holds the fields the agents were given", () => {
		const config = provider(["modelId", "providerConfig"]);
		config.updateConnectionDefaults({
			modelId: "large",
			providerConfig: { contextWindow: 262_144 },
		});
		expect(config.getConnectionConfig()).toMatchObject({
			modelId: "small",
			providerConfig: { contextWindow: 8_192 },
		});
	});

	// Only the pinned fields. A refreshed key for a provider the agents do share
	// with the session still has to reach them, or an expired token ends their
	// runs with a raw 401.
	it("still takes what the override did not name", () => {
		const config = provider(["modelId"]);
		config.updateConnectionDefaults({
			modelId: "large",
			apiKey: "refreshed",
			baseUrl: "http://elsewhere:11434",
		});
		expect(config.getConnectionConfig()).toMatchObject({
			modelId: "small",
			apiKey: "refreshed",
			baseUrl: "http://elsewhere:11434",
		});
	});
});

describe("buildDelegatedAgentConfig", () => {
	// The lead's check is judged where the change protocol's approved check
	// is: the runtime's completion boundary, so a fail keeps the agent in the
	// same run instead of ending it.
	it("judges the lead's check at the agent's completion boundary", async () => {
		const check = createDelegatedAgentCheck({
			check: { command: "x", expect: "ok" },
			cwd: "/w",
			wrapSpawn: (spec) => spec,
			run: async () => ({
				passed: false,
				exitCode: 1,
				output: "boom",
				timedOut: false,
			}),
		});
		const config = buildDelegatedAgentConfig({
			kind: "subagent",
			prompt: "fix it",
			tools: [],
			configProvider: provider(),
			check,
		});
		const message = await config.completionPolicy?.onCompletionAttempt?.({
			text: "done",
		});
		expect(message).toContain("Your check did not pass");
		expect(check.result()?.status).toBe("fail");
	});

	it("leaves the completion boundary alone without a check", () => {
		const config = buildDelegatedAgentConfig({
			kind: "subagent",
			prompt: "fix it",
			tools: [],
			configProvider: provider(),
		});
		expect(config.completionPolicy).toBeUndefined();
	});

	it("inherits the parent distinctId and sessionId for telemetry grouping", () => {
		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-5",
			distinctId: "user-123",
			sessionId: "sess-parent",
		});

		const config = buildDelegatedAgentConfig({
			kind: "subagent",
			prompt: "review the diff",
			tools: [],
			configProvider,
			parentAgentId: "agent-lead",
		});

		expect(config.distinctId).toBe("user-123");
		expect(config.sessionId).toBe("sess-parent");
		expect(config.parentAgentId).toBe("agent-lead");
	});

	it("leaves identity fields undefined when the parent has none", () => {
		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-5",
		});

		const config = buildDelegatedAgentConfig({
			kind: "subagent",
			prompt: "review the diff",
			tools: [],
			configProvider,
		});

		expect(config.distinctId).toBeUndefined();
		expect(config.sessionId).toBeUndefined();
	});

	// 1tmrl: 41 of 75 agents ended on a server restart or an admission
	// refusal. Every delegated agent now waits those out by default.
	it("waits out a server restart or a refusal by default", async () => {
		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
		});
		const passed = async () => true;
		const byDefault = buildDelegatedAgentConfig({
			kind: "subagent",
			prompt: "review the diff",
			tools: [],
			configProvider,
		});
		const given = buildDelegatedAgentConfig({
			kind: "subagent",
			prompt: "review the diff",
			tools: [],
			configProvider,
			recoverTurnFault: passed,
		});

		expect(typeof byDefault.recoverTurnFault).toBe("function");
		expect(given.recoverTurnFault).toBe(passed);
		// A stopped agent is never held.
		const controller = new AbortController();
		controller.abort();
		expect(
			await byDefault.recoverTurnFault?.({
				kind: "transport",
				message: "server is shutting down",
				attempt: 1,
				iteration: 1,
				signal: controller.signal,
			}),
		).toBe(false);
	});

	// A delegated agent with no `prepareTurn` compacts never, and nothing says
	// so: the transcript just grows until the provider truncates the prompt. A
	// reported session reached 491,454 input tokens against a 262,144 window,
	// 34 requests in a row over the limit, while the lead on the same model
	// compacted normally at its peak of 237,191.
	it("gives the agent a context pipeline", () => {
		const prepareTurn = async () => undefined;
		const condenseDiscardedReasoning = async () => undefined;
		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "ollama",
			modelId: "small",
			createPrepareTurn: () => prepareTurn,
			condenseDiscardedReasoning,
		});

		const config = buildDelegatedAgentConfig({
			kind: "subagent",
			prompt: "review the diff",
			tools: [],
			configProvider,
		});

		expect(config.prepareTurn).toBe(prepareTurn);
		expect(config.condenseDiscardedReasoning).toBe(condenseDiscardedReasoning);
	});

	// Built per agent rather than handed down, because compaction carries
	// state: two agents sharing one pipeline would compact against each
	// other's summaries.
	it("builds a pipeline per agent, not one for all of them", () => {
		let built = 0;
		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "ollama",
			modelId: "small",
			createPrepareTurn: () => {
				built += 1;
				return async () => undefined;
			},
		});

		const options = {
			kind: "subagent" as const,
			prompt: "review the diff",
			tools: [],
			configProvider,
		};
		const first = buildDelegatedAgentConfig(options);
		const second = buildDelegatedAgentConfig(options);

		expect(built).toBe(2);
		expect(first.prepareTurn).not.toBe(second.prepareTurn);
	});

	// A delegated worker gets no execution tuning of its own until now: the
	// runtime's loop-detection and mistake thresholds are the lead's, and a
	// swarm worker that needs a tighter mistake budget than the lead has no way
	// to carry one. The passthrough is what a worker-struggle supervisor rides
	// in on -- see `worker-struggle.ts`.
	it("carries execution tuning from the runtime config", () => {
		const execution = { maxConsecutiveMistakes: 3 } as const;
		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "ollama",
			modelId: "small",
			execution,
		});

		const config = buildDelegatedAgentConfig({
			kind: "subagent",
			prompt: "review the diff",
			tools: [],
			configProvider,
		});

		expect(config.execution).toBe(execution);
	});

	// A per-spawn override beats the runtime default: the swarm path tightens a
	// worker's budget without disturbing the shared runtime config every other
	// delegation reads.
	it("lets a per-build execution override the runtime default", () => {
		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "ollama",
			modelId: "small",
			execution: { maxConsecutiveMistakes: 6 },
		});

		const override = { maxConsecutiveMistakes: 2 } as const;
		const config = buildDelegatedAgentConfig({
			kind: "subagent",
			prompt: "review the diff",
			tools: [],
			configProvider,
			execution: override,
		});

		expect(config.execution).toBe(override);
	});

	it("leaves execution unset when neither runtime nor build supplies one", () => {
		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "ollama",
			modelId: "small",
		});

		const config = buildDelegatedAgentConfig({
			kind: "subagent",
			prompt: "review the diff",
			tools: [],
			configProvider,
		});

		expect(config.execution).toBeUndefined();
	});

	// The struggle supervisor rides in on the one funnel both spawn paths pass
	// through, so wiring it here reaches `spawn_agent` and the swarm without
	// either duplicating the composition.
	describe("with a worker-struggle supervisor", () => {
		function build(
			supervisor: ReturnType<typeof createWorkerStruggleSupervisor>,
		) {
			const events: AgentEvent[] = [];
			const configProvider = createDelegatedAgentConfigProvider({
				providerId: "ollama",
				modelId: "small",
			});
			const grep = {
				name: "grep",
				description: "",
				inputSchema: { type: "object" },
				execute: async () => "found 3 matches",
			} as unknown as AgentTool<unknown, unknown>;
			const outer = new AbortController();
			const config = buildDelegatedAgentConfig({
				kind: "subagent",
				prompt: "gather",
				tools: [grep],
				configProvider,
				onEvent: (event) => events.push(event),
				abortSignal: outer.signal,
				struggle: supervisor,
			});
			return { config, events, outer };
		}

		const iter = (n: number): AgentEvent[] => [
			{ type: "iteration_start", iteration: n },
			{
				type: "iteration_end",
				iteration: n,
				hadToolCalls: true,
				toolCallCount: 1,
			},
		];

		it("forwards events to the supervisor and preserves the original onEvent", () => {
			const supervisor = createWorkerStruggleSupervisor({
				nudgeAfterIterations: 4,
			});
			const { config, events } = build(supervisor);
			for (let n = 1; n <= 4; n += 1) {
				for (const event of iter(n)) {
					config.onEvent?.(event);
				}
			}
			// The composed onEvent both fed the supervisor and kept the caller's.
			expect(supervisor.phase).toBe("nudged");
			expect(events).toHaveLength(8);
		});

		it("wraps the tools so the held nudge lands on the next result", async () => {
			const supervisor = createWorkerStruggleSupervisor({
				nudgeAfterIterations: 4,
				nudgeMessage: "COMMIT NOW",
			});
			const { config } = build(supervisor);
			for (let n = 1; n <= 4; n += 1) {
				for (const event of iter(n)) {
					config.onEvent?.(event);
				}
			}
			const result = await config.tools[0].execute({}, {} as never);
			expect(result).toContain("found 3 matches");
			expect(result).toContain("COMMIT NOW");
		});

		// A stop comes only from thinking that keeps running out its budget, so
		// drive exactly that: each turn's reasoning ends on the engine's marker.
		const spentTurn = (n: number): AgentEvent[] => [
			{ type: "iteration_start", iteration: n },
			{
				type: "content_end",
				contentType: "reasoning",
				reasoning:
					"…\n\nI have used my thinking budget. I must stop analysing now.",
			},
			{
				type: "iteration_end",
				iteration: n,
				hadToolCalls: true,
				toolCallCount: 1,
			},
		];

		it("composes the abort signal so a supervisor stop reaches the runtime", () => {
			const supervisor = createWorkerStruggleSupervisor({ graceIterations: 0 });
			const { config } = build(supervisor);
			expect(config.abortSignal?.aborted).toBe(false);
			for (let n = 1; n <= 5; n += 1) {
				for (const event of spentTurn(n)) {
					config.onEvent?.(event);
				}
			}
			expect(supervisor.phase).toBe("stopped");
			expect(config.abortSignal?.aborted).toBe(true);
		});

		it("the composed abort signal still fires on the outer cancellation", () => {
			const supervisor = createWorkerStruggleSupervisor();
			const { config, outer } = build(supervisor);
			outer.abort();
			expect(config.abortSignal?.aborted).toBe(true);
		});
	});

	// The host may have auto-compaction switched off entirely, and a teammate
	// is not the place to discover that a missing factory throws.
	it("leaves the pipeline unset when the host supplies none", () => {
		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "ollama",
			modelId: "small",
		});

		const config = buildDelegatedAgentConfig({
			kind: "teammate",
			prompt: "review the diff",
			tools: [],
			configProvider,
		});

		expect(config.prepareTurn).toBeUndefined();
		expect(config.condenseDiscardedReasoning).toBeUndefined();
	});
});

describe("a tab that turns thinking off", () => {
	// pandorum, 2026-09-23: the lead ran thinking `high` and the Agents tab
	// thinking off. The tab's override is spread over the session's runtime
	// config and its keys pinned, so a present key -- even one whose value is
	// undefined -- must beat the lead's, now and after every session push.
	it("keeps thinking off and drops the lead's budget and cap", () => {
		const lead = {
			providerId: "ollama",
			modelId: "lead",
			thinking: true,
			reasoningEffort: "high" as const,
			thinkingBudgetTokens: 32_000,
			maxTokensPerTurn: 64_000,
		};
		const tab = {
			providerId: "opencoti",
			modelId: "agent",
			thinking: false,
			thinkingBudgetTokens: undefined,
			maxTokensPerTurn: undefined,
		};
		const provider = createDelegatedAgentConfigProvider(
			{ ...lead, ...tab } as never,
			Object.keys(tab) as never,
		);
		provider.updateConnectionDefaults(lead as never);

		const connection = provider.getConnectionConfig();
		expect(connection.thinking).toBe(false);
		expect(connection.thinkingBudgetTokens).toBeUndefined();
		expect(connection.maxTokensPerTurn).toBeUndefined();
		expect(connection.modelId).toBe("agent");
	});
});

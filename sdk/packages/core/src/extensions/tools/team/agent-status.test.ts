import { noteOpencotiPressure, resetOpencotiPressure } from "@cline/llms";
import { afterEach, describe, expect, it } from "vitest";
import { __resetAgentRounds, roundsFor } from "./agent-rounds";
import {
	createAgentsStatusTool,
	RETRY_POLICY_TEXT,
	renderAgentsStatus,
	STATUS_MAX_CHARS,
} from "./agent-status";
import type { DelegatedAgentConfigProvider } from "./delegated-agent";
import {
	__resetSubagentCancellations,
	registerSubagentCancellation,
} from "./subagent-cancellation";

afterEach(() => {
	__resetAgentRounds();
	__resetSubagentCancellations();
	resetOpencotiPressure();
});

const NOW = Date.parse("2026-09-26T10:00:00Z");
const context = { agentId: "lead", iteration: 1, sessionId: "s1" } as never;

/** A session with two nodes, one of them PolyKV with an enforced floor. */
function nodes(): () => DelegatedAgentConfigProvider {
	const provider = {
		getRuntimeConfig: () => ({
			nodePlacement: {
				waiting: 2,
				describe: () => [
					{
						nodeId: "node-a",
						label: "Node1",
						priority: 1,
						providerId: "opencoti",
						modelId: "qwen3.6",
						baseUrl: "http://engine:8241/v1",
						providerConfig: {
							polykv: { targetTpsPerSession: 20, mode: "enforced" },
						},
						capacity: 4,
						running: 4,
					},
					{
						nodeId: "node-b",
						label: "Node2",
						priority: 2,
						providerId: "ollama",
						modelId: "glm",
						capacity: 2,
						running: 0,
						downUntil: NOW + 30_000,
					},
				],
			},
		}),
		getConnectionConfig: () => ({}),
	};
	return () => provider as unknown as DelegatedAgentConfigProvider;
}

/** One round of three: running, refused by the floor, stopped at its cap. */
async function swarmRound() {
	const rounds = roundsFor("s1");
	const handle = rounds.open({
		kind: "spawn_agent",
		tool: "spawn_agent",
		background: true,
		agents: [
			{ name: "fixer-1", task: "fix a.js" },
			{ name: "fixer-2", task: "fix b.js" },
			{ name: "fixer-3", task: "fix c.js" },
		],
	});
	void handle.run(0, context, (ctx) => {
		ctx.emitUpdate?.({
			nodeId: "node-a",
			nodeLabel: "Node1",
			providerId: "opencoti",
			modelId: "qwen3.6",
		});
		ctx.emitUpdate?.({ activity: { text: "Ran npm test" } });
		return new Promise(() => {});
	});
	void handle.run(1, context, (ctx) => {
		ctx.emitUpdate?.({
			waiting: {
				kind: "refusal",
				where: "Node1",
				detail: "projected mean tps below floor (18.2 < 20)",
			},
		});
		return new Promise(() => {});
	});
	await handle.run(2, context, async (ctx) => {
		ctx.emitUpdate?.({
			nodeId: "node-a",
			nodeLabel: "Node1",
			providerId: "opencoti",
			modelId: "qwen3.6",
			contextWindow: 65_536,
			maxIterations: 40,
		});
		ctx.emitUpdate?.({
			compactions: 2,
			compactionsByCause: { pressure: 1, threshold: 1 },
		});
		ctx.emitUpdate?.({ latestOutput: "x".repeat(5_000) });
		return {
			text: "I got as far as the parser.",
			finishReason: "max_iterations",
			iterations: 40,
			usage: { inputTokens: 250_000, outputTokens: 9_000 },
		};
	});
	handle.close();
	return { rounds, handle };
}

describe("agents_status with no arguments", () => {
	it("counts each round's agents by state and says why the failed ones failed", async () => {
		await swarmRound();
		const text = renderAgentsStatus({}, { sessionId: "s1", now: () => NOW });
		expect(text).toContain("r1 spawn_agent (background)");
		expect(text).toContain("3 agents: running 1, waiting-infra 1, failed 1");
		expect(text).toContain("(failed: iteration_cap 1)");
	});

	it("states each node's reach, slots, admission floor and recent refusals", async () => {
		noteOpencotiPressure(
			"http://engine:8241",
			{ windowS: 60, refused60s: 3, lastRefusalAgeS: 4, refusalsTotal: 377 },
			NOW - 2_000,
		);
		const text = renderAgentsStatus(
			{},
			{ sessionId: "s1", configProvider: nodes(), now: () => NOW },
		);
		expect(text).toContain("Nodes (2 agents waiting in the placement queue)");
		expect(text).toMatch(
			/Node1 \[node-a\].*opencoti\/qwen3\.6.*reachable.*4\/4 slots in use/,
		);
		expect(text).toContain("admission: floor 20 tok/s per session, enforced");
		expect(text).toContain(
			"refusals: 3 in the last 60 s, the last 4 s before the read, 377 since boot (read 2s ago)",
		);
		expect(text).toMatch(/Node2 \[node-b\].*out of rotation until 10:00:30Z/);
		// Not a PolyKV node: no admission lines under it.
		expect(text.split("Node2")[1]).not.toContain("admission:");
	});

	it("states the retry policy in words, so the lead does not route by hand", () => {
		const text = renderAgentsStatus({}, { sessionId: "s1", now: () => NOW });
		expect(text).toContain(RETRY_POLICY_TEXT);
		expect(RETRY_POLICY_TEXT).toContain("Agents never fail on infrastructure");
		expect(RETRY_POLICY_TEXT).toContain("requeue it");
	});

	it("stays short however many rounds there were", async () => {
		const rounds = roundsFor("s1");
		for (let i = 0; i < 60; i += 1) {
			const handle = rounds.open({
				kind: "spawn_agent",
				tool: "spawn_agent",
				background: false,
				agents: Array.from({ length: 20 }, (_, n) => ({
					name: `agent-${i}-${n}`,
					task: "t".repeat(2_000),
				})),
			});
			handle.close();
		}
		const text = renderAgentsStatus({}, { sessionId: "s1", now: () => NOW });
		expect(text.length).toBeLessThanOrEqual(STATUS_MAX_CHARS);
		expect(text).toContain("r60 spawn_agent");
		expect(text).toContain("and 52 older rounds");
	});
});

describe("agents_status for one agent", () => {
	it("says which node refused it and why, and since when", async () => {
		await swarmRound();
		const text = renderAgentsStatus(
			{ agent_id: "fixer-2" },
			{ sessionId: "s1", now: () => NOW },
		);
		expect(text).toContain(
			"r1-2 fixer-2 (round r1, spawn_agent) -- waiting_infra",
		);
		expect(text).toContain(
			'refused by Node1 (the admission floor: "projected mean tps below floor (18.2 < 20)"), retrying since',
		);
		expect(text).toContain("task: fix b.js");
	});

	it("gives the stop, the cap, compactions by cause and a bounded tail", async () => {
		await swarmRound();
		const text = renderAgentsStatus(
			{ agent_id: "r1-3" },
			{ sessionId: "s1", now: () => NOW },
		);
		expect(text).toContain("failed: reached its 40-iteration cap");
		expect(text).toContain("iterations: 40 / 40");
		expect(text).toContain("compactions: 2 (pressure 1, threshold 1)");
		expect(text).toContain("model: opencoti/qwen3.6");
		expect(text).toContain("tokens: 250,000 in / 9,000 out");
		expect(text).toContain("I got as far as the parser.");
		expect(text).not.toContain("x".repeat(1_600));
	});

	it("shows an agent held at its cap as awaiting the lead", async () => {
		const rounds = roundsFor("s1");
		const handle = rounds.open({
			kind: "spawn_agent",
			tool: "spawn_agent",
			background: true,
			agents: [{ name: "slow", task: "t" }],
		});
		void handle.run(0, context, (ctx) => {
			const control = registerSubagentCancellation("s1::c1", undefined, "slow");
			ctx.emitUpdate?.({ cancelId: "s1::c1", maxIterations: 30 });
			void control.awaitLead();
			return new Promise(() => {});
		});
		const text = renderAgentsStatus(
			{ agent_id: "slow" },
			{ sessionId: "s1", now: () => NOW },
		);
		expect(text).toContain(
			"awaiting_lead: stopped at its 30-iteration cap with its work kept; resume_agent to continue",
		);
		expect(
			renderAgentsStatus({}, { sessionId: "s1", now: () => NOW }),
		).toContain("awaiting-lead 1");
	});

	it("says so when there is no such agent", () => {
		expect(renderAgentsStatus({ agent_id: "r9-9" }, { sessionId: "s1" })).toBe(
			"r9-9: no agent by that id or name in this session.",
		);
	});

	it("covers a teammate by its id", () => {
		const text = renderAgentsStatus(
			{ agent_id: "reviewer" },
			{
				sessionId: "s1",
				now: () => NOW,
				teammates: () => ({
					members: [
						{ agentId: "reviewer", role: "teammate", status: "running" },
					],
					runs: [
						{
							id: "run-1",
							agentId: "reviewer",
							status: "running",
							message: "review",
							priority: 0,
							retryCount: 0,
							maxRetries: 0,
							startedAt: new Date(NOW - 65_000),
							currentActivity: "reading src/a.ts",
						},
					],
				}),
			},
		);
		expect(text).toContain("reviewer (teammate) -- running");
		expect(text).toContain(
			"run run-1: running, started 09:58:55Z (1m05s ago), reading src/a.ts",
		);
	});
});

describe("agents_status for a round", () => {
	it("lists one line per agent", async () => {
		await swarmRound();
		const tool = createAgentsStatusTool({ sessionId: "s1", now: () => NOW });
		const text = String(
			await tool.execute({ round_id: "r1" }, context as never),
		);
		const lines = text.split("\n");
		expect(lines).toHaveLength(4);
		expect(lines[1]).toMatch(
			/^- r1-1 fixer-1: running · Node1 -- last: Ran npm test$/,
		);
		expect(lines[2]).toMatch(
			/^- r1-2 fixer-2: waiting_infra -- waiting on infrastructure: refused by Node1/,
		);
		expect(lines[3]).toMatch(
			/^- r1-3 fixer-3: failed · Node1 · 40\/40 it · 250k\/9\.0k tok · 2 compactions -- reached its 40-iteration cap/,
		);
	});

	it("names the rounds there are when asked for one that is not", async () => {
		await swarmRound();
		expect(renderAgentsStatus({ round_id: "r7" }, { sessionId: "s1" })).toBe(
			"No round r7. Rounds: r1.",
		);
	});
});

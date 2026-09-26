import { afterEach, describe, expect, it } from "vitest";
import { clearAgentReports, readAgentReport } from "./agent-reports";
import {
	buildSpawnBatchReport,
	failureClassOf,
	SPAWN_BATCH_RESULT_BUDGET_CHARS,
	type SpawnBatchMemberResult,
} from "./batch-report";

const FOOTER =
	"\n\n---\nThis agent worked on a private copy of the workspace and left your files unchanged; it recorded no file changes to hand back.";

/** 1tmrl's round, in shape: 75 agents of five kinds, 41 of them infra errors. */
function round1tmrl(): SpawnBatchMemberResult[] {
	const kinds = [
		"code-correctness",
		"security",
		"performance",
		"style",
		"tests",
	];
	const out: SpawnBatchMemberResult[] = [];
	for (let i = 0; i < 75; i += 1) {
		const name = `${kinds[i % 5]}-${Math.floor(i / 5) + 1}`;
		if (i < 13) {
			out.push({
				name,
				text: `pool 5 admission rejected: projected mean tps below floor${FOOTER}`,
				finishReason: "error",
				iterations: 0,
				usage: { inputTokens: 0, outputTokens: 0 },
			});
		} else if (i < 31) {
			out.push({
				name,
				text: `pool 2 admission rejected: projected mean tps below floor${FOOTER}`,
				finishReason: "error",
				iterations: 8,
				usage: { inputTokens: 104_544, outputTokens: 3_387 },
			});
		} else if (i < 41) {
			out.push({
				name,
				text: `server is shutting down${FOOTER}`,
				finishReason: "error",
				iterations: 5,
				usage: { inputTokens: 50_000, outputTokens: 2_000 },
			});
		} else {
			out.push({
				name,
				text: `**Verdict:** DO NOT SHIP (${name}). ${"Line 82: setupLevel() is called but never defined. ".repeat(18)}`.slice(
					0,
					1_000,
				),
				finishReason: "completed",
				iterations: 3,
				usage: { inputTokens: 24_375, outputTokens: 4_936 },
			});
		}
	}
	return out;
}

afterEach(() => clearAgentReports("lead"));

describe("an `agents` call's result", () => {
	it("fits well under the 32,000-character cap for a round of 75, and names every agent", () => {
		const round = round1tmrl();
		const report = buildSpawnBatchReport(round, "lead");
		const json = JSON.stringify(report);

		expect(json.length).toBeLessThanOrEqual(SPAWN_BATCH_RESULT_BUDGET_CHARS);
		expect(json.length).toBeLessThan(32_000);
		expect(
			report.agents.map((entry) =>
				typeof entry === "string" ? entry.split("|")[0] : entry.name,
			),
		).toEqual(round.map((entry) => entry.name));
		expect(report.agents[0]).toMatchObject({
			name: "code-correctness-1",
			status: "errored",
			failureClass: "infra",
		});
		// Every agent's report is either shown or named as not shown.
		const shown = new Set(report.reports.map((entry) => entry.name));
		const notShown = new Set(report.notShown?.names ?? []);
		for (const entry of round) {
			expect(shown.has(entry.name) || notShown.has(entry.name)).toBe(true);
		}
		expect(notShown.size).toBeGreaterThan(0);
		expect(report.notShown?.note).toContain("read_agent_report");
	});

	it("starts with the aggregate block", () => {
		const report = buildSpawnBatchReport(round1tmrl(), "lead");
		expect(JSON.stringify(report).startsWith('{"summary":{"total":75,')).toBe(
			true,
		);
		expect(report.summary).toMatchObject({
			total: 75,
			completed: 34,
			errored: 41,
			cancelled: 0,
			byFailureClass: { infra: 41, task: 0 },
			totalIterations: 13 * 0 + 18 * 8 + 10 * 5 + 34 * 3,
		});
		expect(report.summary.byType["code-correctness"]).toEqual({
			total: 15,
			completed: 6,
			errored: 9,
			cancelled: 0,
		});
		expect(report.summary.totalTokens.output).toBe(
			18 * 3_387 + 10 * 2_000 + 34 * 4_936,
		);
	});

	it("keeps a report it could not show readable, by the name it gives", () => {
		const report = buildSpawnBatchReport(round1tmrl(), "lead");
		const name = report.notShown?.names.at(-1) as string;
		expect(readAgentReport("lead", name)).toContain("DO NOT SHIP");
	});

	it("never cuts a report from the middle: each shown report is whole", () => {
		const round = round1tmrl();
		const report = buildSpawnBatchReport(round, "lead");
		for (const shown of report.reports) {
			const original = round.find((entry) => entry.name === shown.name);
			expect(shown.text).toBe(original?.text?.trim());
		}
	});

	it("shows every report when they fit", () => {
		const report = buildSpawnBatchReport(
			[
				{ name: "a", text: "fine", finishReason: "completed" },
				{ name: "b", text: "also fine", finishReason: "completed" },
			],
			"lead",
		);
		expect(report.reports).toHaveLength(2);
		expect(report.notShown).toBeUndefined();
	});

	it("still fits and names everyone at 300 agents", () => {
		const round = Array.from({ length: 300 }, (_entry, index) => ({
			name: `reviewer-with-a-long-name-${index + 1}`,
			text: "x".repeat(1_000),
			finishReason: "completed",
		}));
		const report = buildSpawnBatchReport(round, "lead");
		expect(JSON.stringify(report).length).toBeLessThanOrEqual(
			SPAWN_BATCH_RESULT_BUDGET_CHARS,
		);
		expect(report.agents).toHaveLength(300);
	});
});

describe("whose failure it was", () => {
	it("is infra for the server, the transport or a refusal", () => {
		for (const text of [
			"server is shutting down",
			"pool 2 admission rejected: projected mean tps below floor",
			"Bad Gateway",
			"fetch failed",
			"No agent node can take an agent: every node has a capacity of 0.",
			'Type validation failed: Value: null.\nError message: [{"expected":"object","code":"invalid_type","path":[],"message":"Invalid input: expected object, received null"}]',
			// Verbatim from opencoti b108 on 8244 (swarm 0926): the engine's
			// partial eviction, its speculative sub-batch throw, and the batch it
			// failed to decode. 15 agents ended on the first two as "task".
			"Evicted to keep other in-flight requests alive: the KV cache could not fit another token and this was the largest live sequence. Context size has been exceeded.",
			"got exception: speculative batch index 32 is not inside the current sub-batch [0, 32)",
			"Invalid input batch.",
		]) {
			expect(
				failureClassOf({ name: "a", text, finishReason: "error" }),
				text,
			).toBe("infra");
		}
	});

	it("reads the runtime's loop guard as the agent's failure, not a cancellation", () => {
		// 9 agents of swarm 0926 were stopped by the repeated-call guard and
		// the round showed them as "cancelled", which reads like a stop by
		// the lead or the user.
		const result = {
			name: "js-syntax-01",
			text: "",
			error:
				"AgentRuntimeAbortError: repeated-call loop guard stopped the run at iteration 21",
		};
		const report = buildSpawnBatchReport([result], "lead");
		expect(report.summary.cancelled).toBe(0);
		expect(report.summary.errored).toBe(1);
		expect(failureClassOf(result)).toBe("task");
	});

	it("is task for the model, a tool or the iteration budget", () => {
		expect(
			failureClassOf({
				name: "a",
				text: "Agent runtime exceeded maxIterations (40)",
				finishReason: "max_iterations",
			}),
		).toBe("task");
		expect(
			failureClassOf({
				name: "a",
				text: "Model returned empty response",
				finishReason: "error",
			}),
		).toBe("task");
		expect(
			failureClassOf({ name: "a", text: "ok", finishReason: "completed" }),
		).toBeUndefined();
	});
});

describe("the iteration cap and the check in a round's result", () => {
	afterEach(() => clearAgentReports("lead"));

	it("names an agent waiting at its cap, with the id to resume it by", () => {
		const report = buildSpawnBatchReport(
			[
				{
					name: "fixer-1",
					agentId: "agent_42",
					text: "halfway",
					finishReason: "max_iterations",
					iterations: 4,
					maxIterations: 4,
					stopReason: "iteration_cap",
					state: "awaiting_lead",
				},
				{
					name: "fixer-2",
					text: "done",
					finishReason: "completed",
					iterations: 2,
				},
			],
			"lead",
		);
		expect(report.summary.awaitingLead).toBe(1);
		expect(report.agents[0]).toMatchObject({
			name: "fixer-1",
			status: "awaiting_lead",
			agentId: "agent_42",
			iterations: 4,
			maxIterations: 4,
		});
		expect(report.summary.errored).toBe(0);
	});

	it("says the cap stopped an agent, with its iterations used and max", () => {
		const report = buildSpawnBatchReport(
			[
				{
					name: "a",
					text: "partial",
					finishReason: "max_iterations",
					iterations: 10,
					maxIterations: 10,
					stopReason: "iteration_cap",
				},
			],
			"lead",
		);
		expect(report.agents[0]).toMatchObject({
			status: "errored",
			failureClass: "task",
			stopReason: "iteration_cap",
			iterations: 10,
			maxIterations: 10,
		});
	});

	it("carries each agent's check verdict: status in the index, output with its report", () => {
		const oracle = {
			status: "fail" as const,
			command: "node t.js",
			expect: "ok",
			must: "match" as const,
			exitCode: 1,
			output: "SyntaxError at 12",
			runs: 3,
		};
		const report = buildSpawnBatchReport(
			[
				{
					name: "a",
					text: "done",
					finishReason: "completed",
					iterations: 2,
					oracle,
				},
			],
			"lead",
		);
		expect(report.agents[0]).toMatchObject({ oracle: "fail (exit 1)" });
		expect(report.reports[0]).toMatchObject({
			name: "a",
			oracle: { status: "fail", exitCode: 1, output: "SyntaxError at 12" },
		});
	});
});

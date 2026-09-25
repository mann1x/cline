import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A swarm worker's sampler is drawn and realized by the runner, not the tool:
// the tool hands each worker the lead's request ("random" and all), and the
// runner builds it on whichever node took it. So the row and the report can
// only carry what was built if the runner reports it -- which is what this
// drives, through the real `buildDelegatedAgentConfig`.

/** Every config a worker was built with. */
const built: AgentConfig[] = [];

vi.mock(
	"../../../extensions/tools/team/delegated-agent",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../extensions/tools/team/delegated-agent")
			>();
		return {
			...actual,
			createDelegatedAgent: (
				options: Parameters<typeof actual.buildDelegatedAgentConfig>[0],
			) => {
				built.push(actual.buildDelegatedAgentConfig(options));
				const run = async () => ({
					text: "done",
					finishReason: "completed",
					iterations: 1,
					usage: { inputTokens: 1, outputTokens: 1 },
				});
				return { run, runWithHead: run };
			},
		};
	},
);

vi.mock(
	"../../../extensions/context/polykv-session",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../extensions/context/polykv-session")
		>()),
		snapshotPolykvSession: async () => undefined,
		readPolykvCapacity: async () => undefined,
	}),
);

const { createSessionSwarmTool } = await import("./spawn-tool");

describe("a swarm worker's random sampler", () => {
	let ws: string;

	beforeEach(async () => {
		built.length = 0;
		ws = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-sampling-"));
	});

	afterEach(async () => {
		await fs.rm(ws, { recursive: true, force: true });
	});

	function swarmTool(providerConfig?: Record<string, unknown>) {
		return createSessionSwarmTool(
			{
				getSession: () => ({ runtime: {} }) as never,
				subAgentStarts: new Map(),
				onAgentEvent: () => {},
				invokeBackendOptional: async () => {},
			} as never,
			{
				providerId: "openai-compatible",
				modelId: "m",
				cwd: ws,
				baseUrl: "http://127.0.0.1:9/v1",
				enableTools: false,
				...(providerConfig ? { providerConfig } : {}),
			} as never,
			"lead-session",
		) as unknown as {
			execute: (input: unknown, context: unknown) => Promise<unknown>;
		};
	}

	it("is drawn per worker, built, and reported on its row and report", async () => {
		const tool = swarmTool({
			providerId: "openai-compatible",
			modelId: "m",
			sampling: { temperature: 0.7 },
		});
		const updates: Array<Record<string, unknown>> = [];
		const output = (await tool.execute(
			{
				systemPrompt: "s",
				seed: "random",
				temperature: "random",
				tasks: [
					{ name: "w1", task: "a" },
					{ name: "w2", task: "b" },
					{ name: "w3", task: "c" },
				],
			},
			{
				agentId: "lead",
				conversationId: "c",
				iteration: 1,
				toolCallId: "call",
				emitUpdate: (update: unknown) =>
					updates.push(update as Record<string, unknown>),
			},
		)) as {
			results?: Array<{
				name: string;
				sampling?: { seed: number; temperature: number };
			}>;
		};

		expect(built).toHaveLength(3);
		const rows = updates.filter((update) => update.sampling);
		expect(rows.map((row) => row.member).sort()).toEqual([0, 1, 2]);
		const reports = output.results ?? [];
		expect(reports).toHaveLength(3);
		const seeds = new Set(reports.map((entry) => entry.sampling?.seed));
		expect(seeds.size).toBe(3);
		for (const report of reports) {
			expect(report.sampling).toMatchObject({
				seedRandom: true,
				temperatureBase: 0.7,
				temperatureRange: 2,
			});
			expect(report.sampling?.temperature).toBeGreaterThanOrEqual(0.686 - 5e-4);
			expect(report.sampling?.temperature).toBeLessThanOrEqual(0.714 + 5e-4);
		}
		// What was built is what was reported.
		expect(
			new Set(
				built.map(
					(config) =>
						(config.providerConfig as { sampling?: { seed?: number } })
							?.sampling?.seed,
				),
			),
		).toEqual(seeds);
	});

	it("keeps the model's sampler when its temperature is unknown", async () => {
		const tool = swarmTool();
		const updates: Array<Record<string, unknown>> = [];
		const output = (await tool.execute(
			{
				systemPrompt: "s",
				temperature: "random",
				tasks: [{ name: "w1", task: "a" }],
			},
			{
				agentId: "lead",
				conversationId: "c",
				iteration: 1,
				toolCallId: "call",
				emitUpdate: (update: unknown) =>
					updates.push(update as Record<string, unknown>),
			},
		)) as { results?: Array<{ sampling?: unknown }> };
		expect(built[0]?.temperature).toBeUndefined();
		expect(output.results?.[0]?.sampling).toEqual({
			temperatureRange: 2,
			note: "model temperature unknown; kept the model's sampler",
		});
		const info = updates.find((update) => update.activity);
		expect(info?.activity).toEqual({
			text: "model temperature unknown; kept the model's sampler",
		});
	});
});

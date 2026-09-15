import type { AgentResult } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import {
	createSpawnSwarmTool,
	type SpawnSwarmInput,
	type SwarmPoolSnapshot,
} from "./spawn-swarm-tool";

function agentResult(
	text: string,
	overrides: Partial<AgentResult> = {},
): AgentResult {
	return {
		text,
		usage: { inputTokens: 1, outputTokens: 1 } as AgentResult["usage"],
		messages: [],
		toolCalls: [],
		iterations: 1,
		finishReason: "stop",
		model: { id: "lfm2.5", provider: "opencoti" },
		startedAt: new Date(0),
		endedAt: new Date(1),
		durationMs: 1,
		...overrides,
	} as AgentResult;
}

/** A control plane whose answers a test drives, and whose calls it can read. */
function stubPools(
	options: { headroom?: number; snapshotFails?: boolean } = {},
) {
	const released: string[] = [];
	let created = 0;
	const source = {
		snapshot: vi.fn(async (): Promise<SwarmPoolSnapshot | undefined> => {
			if (options.snapshotFails) {
				return undefined;
			}
			created += 1;
			const poolId = `pool-${created}`;
			return {
				poolId,
				release: async () => {
					released.push(poolId);
				},
			};
		}),
		headroom: vi.fn(async () => options.headroom),
	};
	return { source, released, createdCount: () => created };
}

function toolWith(
	run: (task: string, poolId: string | undefined) => Promise<AgentResult>,
	pools = stubPools(),
	extra: Record<string, unknown> = {},
) {
	const tool = createSpawnSwarmTool({
		pools: pools.source,
		runWorker: async ({ task, poolId }: { task: string; poolId?: string }) =>
			run(task, poolId),
		...extra,
	} as never);
	return { tool, pools };
}

const context = { agentId: "lead" } as never;

async function call(
	tool: ReturnType<typeof toolWith>["tool"],
	input: SpawnSwarmInput,
) {
	return tool.execute(input, context);
}

describe("spawn_swarm", () => {
	it("runs one worker per task, all on the lead's snapshot", async () => {
		const seen: Array<{ task: string; poolId?: string }> = [];
		const { tool, pools } = toolWith(async (task, poolId) => {
			seen.push({ task, ...(poolId ? { poolId } : {}) });
			return agentResult('```json\n{"done":["ok"]}\n```');
		});

		await call(tool, {
			systemPrompt: "you are a worker",
			tasks: [{ task: "a" }, { task: "b" }],
		});

		expect(seen.map((entry) => entry.task)).toEqual(["a", "b"]);
		// One snapshot for the whole round: the workers SHARE a prefix, which
		// is the entire reason to spawn them this way.
		expect(pools.createdCount()).toBe(1);
		expect(new Set(seen.map((entry) => entry.poolId))).toEqual(
			new Set(["pool-1"]),
		);
	});

	// "as many agents as possible" needs no parser: the model reads it and
	// passes "max", and the runtime resolves it from what the engine says it
	// will take right now.
	it('resolves "max" from the engine, not from a guess', async () => {
		const pools = stubPools({ headroom: 3 });
		const { tool } = toolWith(async () => agentResult("done"), pools);

		const result = await call(tool, {
			systemPrompt: "p",
			task: "search the repo",
			count: "max",
		});

		expect(result.workers).toBe(3);
	});

	// A pool that says nothing is not a pool that says none. One worker is the
	// floor, because a swarm of zero is a request the model made and nobody
	// answered.
	it('runs one for "max" when the engine will not say', async () => {
		const pools = stubPools({ headroom: undefined });
		const { tool } = toolWith(async () => agentResult("done"), pools);
		expect(
			(await call(tool, { systemPrompt: "p", task: "t", count: "max" }))
				.workers,
		).toBe(1);
	});

	it("bounds an explicit count by what the engine will take", async () => {
		const pools = stubPools({ headroom: 2 });
		const { tool } = toolWith(async () => agentResult("done"), pools);
		expect(
			(await call(tool, { systemPrompt: "p", task: "t", count: 8 })).workers,
		).toBe(2);
	});

	// One worker is nothing to reduce. A model call there costs a round trip to
	// rewrite the report it was handed.
	it("makes no reducer call for a single worker", async () => {
		const reduce = vi.fn();
		const { tool } = toolWith(
			async () => agentResult('```json\n{"done":["only"]}\n```'),
			stubPools(),
			{ reduce },
		);

		const result = await call(tool, { systemPrompt: "p", task: "t", count: 1 });

		expect(reduce).not.toHaveBeenCalled();
		expect(result.digest).toContain("only");
	});

	it("reduces several workers into one block", async () => {
		let n = 0;
		const { tool } = toolWith(async () => {
			n += 1;
			return agentResult(`\`\`\`json\n{"done":["worker ${n}"]}\n\`\`\``);
		});

		const result = await call(tool, {
			systemPrompt: "p",
			tasks: [
				{ name: "w1", task: "a" },
				{ name: "w2", task: "b" },
			],
		});

		expect(result.digest).toContain("worker 1");
		expect(result.digest).toContain("worker 2");
		expect(result.digest).toContain("w1");
	});

	// A worker that spends its whole budget thinking returns empty content and
	// a full reasoning channel. Its transcript is discarded when the pool is
	// released, so the reasoning tail goes in the digest or it is gone.
	it("recovers a worker that produced no answer from its reasoning", async () => {
		const { tool } = toolWith(async () =>
			agentResult("", {
				finishReason: "max_iterations",
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "reasoning",
								text: "The second fence is the one that fails.",
							},
						],
					},
				] as never,
			}),
		);

		const result = await call(tool, { systemPrompt: "p", task: "t", count: 1 });
		expect(result.digest).toContain("second fence");
	});

	// The reducer cannot tell "nothing to report" from "lost". A worker that
	// threw is named, with what it said.
	it("represents a worker that failed outright", async () => {
		let n = 0;
		const { tool } = toolWith(async () => {
			n += 1;
			if (n === 1) {
				throw new Error("worker exploded");
			}
			return agentResult('```json\n{"done":["fine"]}\n```');
		});

		const result = await call(tool, {
			systemPrompt: "p",
			tasks: [
				{ name: "w1", task: "a" },
				{ name: "w2", task: "b" },
			],
		});

		expect(result.digest).toContain("worker exploded");
		expect(result.digest).toContain("fine");
	});

	// The leak test. Every pool this round created has to be gone by the time
	// the tool returns, on the failure paths too -- the 60-second ephemeral
	// sweep is the crash net, not the plan.
	it("releases every pool it created, on success and on failure", async () => {
		const ok = stubPools();
		const { tool } = toolWith(async () => agentResult("done"), ok);
		await call(tool, {
			systemPrompt: "p",
			tasks: [{ task: "a" }, { task: "b" }],
		});
		expect(ok.released).toEqual(["pool-1"]);

		const bad = stubPools();
		const { tool: failing } = toolWith(async () => {
			throw new Error("all of them failed");
		}, bad);
		await call(failing, { systemPrompt: "p", tasks: [{ task: "a" }] });
		expect(bad.released).toEqual(["pool-1"]);
	});

	// A snapshot that fails holds the round rather than running workers on a
	// bad pool: they would each pay a full prefill and share nothing, which is
	// slower than not fanning out at all.
	it("runs without a pool rather than on a bad one", async () => {
		const pools = stubPools({ snapshotFails: true });
		const seen: Array<string | undefined> = [];
		const { tool } = toolWith(async (_task, poolId) => {
			seen.push(poolId);
			return agentResult('```json\n{"done":["ok"]}\n```');
		}, pools);

		const result = await call(tool, { systemPrompt: "p", task: "t", count: 1 });

		expect(seen).toEqual([undefined]);
		expect(result.pooled).toBe(false);
	});
});

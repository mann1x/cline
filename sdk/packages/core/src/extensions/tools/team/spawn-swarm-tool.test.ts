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
	// A model choosing between a swarm and a team reads only these two
	// descriptions. A swarm is one round of disposable workers; a teammate is
	// durable and takes task after task. The description has to say which
	// shape this is, or the two tools read as synonyms.
	it("says the round is disposable and that a durable roster is the other thing", () => {
		const { tool } = toolWith(async () => agentResult("{}"));
		const description = tool.description ?? "";

		expect(description).toMatch(/one round/i);
		expect(description).toMatch(/\bteam\b/i);
	});

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

describe("what the round cost", () => {
	it("adds up the workers' tokens, which nothing else can recover", () => {
		// The workers' transcripts are discarded when their pool is released,
		// so a swarm that does not carry its usage out spends N runs' worth of
		// tokens that are counted nowhere -- the task header included.
		// `spawn_agent` reports its own for exactly this reason.
		return (async () => {
			const { tool } = toolWith(async (task) =>
				agentResult(`did ${task}`, {
					usage: {
						inputTokens: 100,
						outputTokens: 20,
					} as AgentResult["usage"],
				}),
			);
			const result = await call(tool, {
				systemPrompt: "p",
				task: "look",
				count: 3,
			});
			expect(result.workers).toBe(3);
			expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 60 });
		})();
	});

	it("still counts the workers that did answer when one throws", () => {
		// A failed worker is represented in the digest rather than dropped, and
		// its siblings' tokens were spent either way.
		return (async () => {
			let calls = 0;
			const { tool } = toolWith(async (task) => {
				calls += 1;
				if (calls === 2) {
					throw new Error("worker died");
				}
				return agentResult(`did ${task}`, {
					usage: {
						inputTokens: 10,
						outputTokens: 5,
					} as AgentResult["usage"],
				});
			});
			const result = await call(tool, {
				systemPrompt: "p",
				task: "look",
				count: 3,
			});
			expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
		})();
	});
});

/**
 * A swarm is not sized once at launch.
 *
 * The old shape read `headroom` once, computed a worker count from it, built an
 * array and `Promise.all`ed it. Two things were wrong with that, and both were
 * silent. `headroom` is a point-in-time *status* — the question that needs
 * asking is "may I start one more?", which is a different question and has to
 * be asked again after each spawn. And a small live headroom capped the round
 * at that number **for its whole life**, even as workers finished and the
 * engine would happily have taken more.
 *
 * So the round grows: launch while the engine says yes, stop at the first no,
 * and keep asking as workers finish. `headroom` is demoted to an opening hint.
 */
function growingPools(
	answers: Array<boolean>,
	options: { headroom?: number } = {},
) {
	const asked: number[] = [];
	let admitted = 0;
	let index = 0;
	const source = {
		snapshot: vi.fn(async () => ({
			poolId: "pool-1",
			release: async () => {},
		})),
		headroom: vi.fn(async () => options.headroom),
		// Non-consuming, like the real one: it answers, the worker's own gate
		// does the acquiring.
		admit: vi.fn(async () => {
			asked.push(admitted);
			const answer = answers[Math.min(index, answers.length - 1)] ?? false;
			index += 1;
			if (answer) {
				admitted += 1;
			}
			return answer;
		}),
	};
	return { source, asked, admittedCount: () => admitted };
}

describe("a swarm that grows while it runs", () => {
	// R1: the old constant was 8 and it was the number that decided how wide a
	// round got. The bound is the engine's answer now, and nothing else.
	it("goes past the old fixed ceiling when the engine keeps saying yes", async () => {
		const pools = growingPools([
			...Array.from({ length: 12 }, () => true),
			false,
		]);
		const { tool } = toolWith(async () => agentResult("done"), pools as never);

		const result = await call(tool, {
			systemPrompt: "p",
			task: "sweep",
			count: "max",
		});

		expect(result.workers).toBe(12);
	});

	it("stops at the first refusal rather than queueing behind it", async () => {
		const pools = growingPools([true, true, false]);
		const { tool } = toolWith(async () => agentResult("done"), pools as never);

		const result = await call(tool, {
			systemPrompt: "p",
			task: "sweep",
			count: "max",
		});

		expect(result.workers).toBe(2);
	});

	// The reason the probe repeats at all: a slot that frees mid-round belongs
	// to this swarm as much as one that was free at the start.
	it("takes a slot that frees while it is running", async () => {
		// Two in, refused, then yes again once something has finished.
		const pools = growingPools([true, true, false, true, false]);
		const { tool } = toolWith(async () => agentResult("done"), pools as never);

		const result = await call(
			tool,
			{ systemPrompt: "p", task: "sweep", count: "max" },
			// No real waiting: the tick is a seam.
		);

		expect(result.workers).toBe(3);
	});

	// A worker that throws is still a worker that ran: it is counted, and its
	// failure is reported rather than dropped, because the lead cannot tell an
	// empty round from a lost one otherwise.
	it("counts and reports a worker that threw", async () => {
		const pools = growingPools([true, true, false]);
		let started = 0;
		const { tool } = toolWith(async () => {
			started += 1;
			if (started === 1) {
				throw new Error("worker died");
			}
			return agentResult("done");
		}, pools as never);

		const result = await call(tool, {
			systemPrompt: "p",
			task: "sweep",
			count: "max",
		});

		expect(result.workers).toBe(2);
		expect(result.digest).toContain("worker died");
	});

	// An explicit task list is the work, so the round cannot grow past it
	// however much room the engine has.
	it("never runs more workers than there are tasks", async () => {
		const pools = growingPools(Array.from({ length: 10 }, () => true));
		const { tool } = toolWith(async () => agentResult("done"), pools as never);

		const result = await call(tool, {
			systemPrompt: "p",
			tasks: [{ task: "a" }, { task: "b" }],
		});

		expect(result.workers).toBe(2);
	});

	// A guard, not a policy. An engine that answers yes forever would otherwise
	// spin this loop until something else broke.
	it("stops at the runaway guard when the engine never says no", async () => {
		const pools = growingPools([true]);
		const { tool } = toolWith(async () => agentResult("done"), pools as never);

		const result = await call(tool, {
			systemPrompt: "p",
			task: "sweep",
			count: "max",
			// biome-ignore lint/suspicious/noExplicitAny: test seam
		} as any);

		expect(result.workers).toBeLessThanOrEqual(64);
		expect(result.workers).toBeGreaterThan(8);
	});

	// A source that cannot be asked keeps the old behaviour rather than
	// growing blind: no probe means no evidence that one more would be taken.
	it("falls back to the opening hint when there is no probe", async () => {
		const pools = stubPools({ headroom: 3 });
		const { tool } = toolWith(async () => agentResult("done"), pools);

		const result = await call(tool, {
			systemPrompt: "p",
			task: "sweep",
			count: "max",
		});

		expect(result.workers).toBe(3);
	});
});

describe("spawn_swarm worker rows", () => {
	const rowContext = (updates: unknown[]) =>
		({
			agentId: "lead",
			sessionId: "s1",
			toolCallId: "call-1",
			emitUpdate: (update: unknown) => updates.push(update),
		}) as never;

	it("reports each worker on its own row: queued, progress, and how it ended", async () => {
		const updates: unknown[] = [];
		const tool = createSpawnSwarmTool({
			pools: stubPools({ snapshotFails: true }).source,
			runWorker: async ({ task, emitUpdate }) => {
				emitUpdate?.({ toolCalls: 1 });
				return task === "bad"
					? agentResult("admission rejected: context allocation exhausted", {
							finishReason: "error",
						})
					: {
							...agentResult('```json\n{"done":["ok"]}\n```'),
							placed: { nodeId: "n2", nodeLabel: "Node2" },
						};
			},
		});
		const output = (await tool.execute(
			{
				systemPrompt: "s",
				tasks: [
					{ name: "a", task: "good" },
					{ name: "b", task: "bad" },
				],
			},
			rowContext(updates),
		)) as { results?: Array<Record<string, unknown>> };

		expect(updates).toContainEqual({
			cancelId: "s1::call-1#0",
			queued: true,
			member: 0,
		});
		expect(updates).toContainEqual({ toolCalls: 1, member: 1 });
		expect(output.results?.[0]).toMatchObject({
			name: "a",
			nodeLabel: "Node2",
		});
		expect(output.results?.[0]?.error).toBeUndefined();
		expect(output.results?.[1]).toMatchObject({
			name: "b",
			error: "admission rejected: context allocation exhausted",
		});
	});

	// A done worker's row stayed "running" until the slowest worker ended:
	// sixteen rows running on pandorum while the server processed one.
	it("finishes a worker's row when that worker ends, not with the round", async () => {
		const updates: unknown[] = [];
		let releaseSlow: () => void = () => {};
		const slow = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const tool = createSpawnSwarmTool({
			pools: stubPools({ snapshotFails: true }).source,
			runWorker: async ({ task }) => {
				if (task === "slow") await slow;
				return agentResult('```json\n{"done":["ok"]}\n```');
			},
		});
		const running = tool.execute(
			{
				systemPrompt: "s",
				tasks: [
					{ name: "fast", task: "fast" },
					{ name: "slow", task: "slow" },
				],
			},
			rowContext(updates),
		);
		await vi.waitFor(() =>
			expect(updates).toContainEqual(
				expect.objectContaining({
					member: 0,
					finished: expect.objectContaining({ name: "fast" }),
				}),
			),
		);
		expect(
			updates.some(
				(u) =>
					(u as { member?: number; finished?: unknown }).member === 1 &&
					(u as { finished?: unknown }).finished,
			),
		).toBe(false);
		releaseSlow();
		await running;
		expect(updates).toContainEqual(
			expect.objectContaining({
				member: 1,
				finished: expect.objectContaining({ name: "slow" }),
			}),
		);
	});

	it("gives a counted swarm a row per worker, not one for the call", async () => {
		const updates: Array<Record<string, unknown>> = [];
		const tool = createSpawnSwarmTool({
			pools: stubPools({ snapshotFails: true }).source,
			runWorker: async () => agentResult('```json\n{"done":["ok"]}\n```'),
		});
		const output = (await tool.execute(
			{ systemPrompt: "s", task: "t", count: 3 },
			rowContext(updates as unknown[]),
		)) as { results?: unknown[] };
		expect(
			updates.filter((update) => update.queued === true).map((u) => u.member),
		).toEqual([0, 1, 2]);
		expect(output.results).toHaveLength(3);
	});

	it("names a worker that never started as never started", async () => {
		const tool = createSpawnSwarmTool({
			pools: {
				...stubPools({ snapshotFails: true }).source,
				admit: async () => false,
			},
			runWorker: async () => agentResult("unused"),
		});
		const output = (await tool.execute(
			{ systemPrompt: "s", tasks: [{ name: "a", task: "t" }] },
			rowContext([]),
		)) as { results?: Array<Record<string, unknown>>; digest: string };
		expect(output.results?.[0]?.error).toMatch(/never started/);
		expect(output.digest).toMatch(/never started/);
	});

	it("does not start a worker whose row was stopped while it waited", async () => {
		const run = vi.fn(async () => agentResult("x"));
		const controller = new AbortController();
		controller.abort();
		const tool = createSpawnSwarmTool({
			pools: stubPools({ snapshotFails: true }).source,
			runWorker: run,
		});
		const output = (await tool.execute(
			{ systemPrompt: "s", tasks: [{ name: "a", task: "t" }] },
			{
				agentId: "lead",
				sessionId: "s1",
				toolCallId: "call-1",
				signal: controller.signal,
			} as never,
		)) as { results?: Array<Record<string, unknown>> };
		expect(run).not.toHaveBeenCalled();
		expect(output.results?.[0]?.error).toBe("stopped before it started");
	});
});

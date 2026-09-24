import type { AgentResult } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import type {
	AgentNodePlacement,
	PlacedAgentNode,
} from "./agent-node-placement";
import {
	admissionHeadroom,
	isDurableRefusal,
	isRefusedSpawn,
	MAX_STALLED_DURABLE_REFUSALS,
	runPlacedAgent,
} from "./placed-run";

/** A placement that hands out the named nodes in turn, recording what it is told. */
function fakePlacement(nodeIds: string[]) {
	const log: string[] = [];
	const placeOptions: Array<{ front?: boolean } | undefined> = [];
	let next = 0;
	const placement = {
		base: {} as never,
		waiting: 0,
		occupancy: () => new Map(),
		place: async (_signal?: AbortSignal, options?: { front?: boolean }) => {
			placeOptions.push(options);
			const nodeId = nodeIds[Math.min(next, nodeIds.length - 1)];
			next += 1;
			const placed: PlacedAgentNode = {
				nodeId,
				configProvider: {} as never,
				run: async (fn) => await fn(),
				release: () => log.push(`release ${nodeId}`),
				admitted: () => log.push(`admitted ${nodeId}`),
				refused: () => log.push(`refused ${nodeId}`),
				markUnreachable: () => log.push(`unreachable ${nodeId}`),
			};
			return placed;
		},
	} satisfies AgentNodePlacement;
	return { placement, log, placeOptions };
}

const ok = (text: string): AgentResult =>
	({
		text,
		finishReason: "completed",
		iterations: 1,
		usage: { inputTokens: 10, outputTokens: 5 },
	}) as AgentResult;

describe("an agent through the spawn queue", () => {
	// The failure the queue exists for: refused before it started, so nothing
	// has happened that a second try would repeat.
	it("goes back to the front when the engine refuses it before admitting it", async () => {
		const { placement, log, placeOptions } = fakePlacement(["oc", "ollama"]);
		const run = vi
			.fn()
			.mockRejectedValueOnce(
				Object.assign(new Error("Too Many Requests"), { status: 429 }),
			)
			.mockImplementationOnce(async (_node, admitted: () => void) => {
				admitted();
				return ok("done");
			});

		const outcome = await runPlacedAgent({ placement, label: "a", run });

		expect(outcome.result.text).toBe("done");
		expect(outcome.placed.nodeId).toBe("ollama");
		expect(placeOptions).toEqual([undefined, { front: true }]);
		expect(log).toEqual(["refused oc", "admitted ollama", "release ollama"]);
	});

	// pandorum 2026-09-23 (qjryk): the route to bs2 went, and Node1 answered
	// every agent with a zero-token `Bad Gateway` run. It stayed in rotation
	// and 13 agents were lost to it while Node2 had room.
	it("takes a node whose gateway has nothing behind it out, and places the agent elsewhere", async () => {
		const { placement, log } = fakePlacement(["oc", "ollama"]);
		const updates: unknown[] = [];
		const run = vi
			.fn()
			.mockResolvedValueOnce({
				text: "Bad Gateway",
				finishReason: "error",
				iterations: 0,
				usage: { inputTokens: 0, outputTokens: 0 },
			} as AgentResult)
			.mockImplementationOnce(async (_node, admitted: () => void) => {
				admitted();
				return ok("done");
			});

		const outcome = await runPlacedAgent({
			placement,
			label: "a",
			run,
			emitUpdate: (update) => updates.push(update),
		});

		expect(outcome.placed.nodeId).toBe("ollama");
		expect(log.slice(0, 2)).toEqual(["unreachable oc", "release oc"]);
		expect(JSON.stringify(updates)).toContain("the node is not answering");
	});

	// Re-running an agent that has started would redo whatever it did.
	it("does not re-run an agent that failed after it was admitted", async () => {
		const { placement, log } = fakePlacement(["oc"]);
		const run = vi.fn(async (_node, admitted: () => void) => {
			admitted();
			throw Object.assign(new Error("Too Many Requests"), { status: 429 });
		});

		await expect(
			runPlacedAgent({ placement, label: "a", run }),
		).rejects.toThrow("Too Many Requests");
		expect(run).toHaveBeenCalledTimes(1);
		expect(log).toEqual(["admitted oc", "release oc"]);
	});

	it("moves off a node that does not have the model, to the front again", async () => {
		const { placement, log, placeOptions } = fakePlacement(["bad", "good"]);
		const run = vi
			.fn()
			.mockResolvedValueOnce({
				text: 'model "ornith" not found, try pulling it first',
				finishReason: "error",
				iterations: 0,
				usage: { inputTokens: 0, outputTokens: 0 },
			} as AgentResult)
			.mockImplementationOnce(async (_node, admitted: () => void) => {
				admitted();
				return ok("done");
			});

		const outcome = await runPlacedAgent({ placement, label: "a", run });

		expect(outcome.placed.nodeId).toBe("good");
		expect(placeOptions[1]).toEqual({ front: true });
		expect(log.slice(0, 2)).toEqual(["unreachable bad", "release bad"]);
	});

	it("closes the failed attempt's engine session before the next one", async () => {
		const { placement } = fakePlacement(["oc", "oc"]);
		const order: string[] = [];
		const run = vi
			.fn()
			.mockImplementationOnce(async () => {
				order.push("attempt 1");
				throw new Error("admission rejected: session allocation full");
			})
			.mockImplementationOnce(async (_node, admitted: () => void) => {
				order.push("attempt 2");
				admitted();
				return ok("done");
			});

		await runPlacedAgent({
			placement,
			label: "a",
			run,
			beforeRetry: async () => {
				order.push("close session");
			},
		});

		expect(order).toEqual(["attempt 1", "close session", "attempt 2"]);
	});

	// pandorum 2026-09-23 (Node1): the opencoti pool deadlocked — every worker
	// holds nothing and waits, so nothing finishes to free the cells the next
	// one needs. The gate answered 126 agents with "largest admissible 160",
	// the figure never moving, and each was re-queued to the front. It spun for
	// twelve hours. A durable refusal whose stated headroom does not grow must
	// be reported to the lead, not retried forever.
	it("stops re-queuing a durable refusal whose headroom never grows, and reports it", async () => {
		const { placement } = fakePlacement(["oc"]);
		const run = vi.fn(async () => {
			throw new Error(
				"admission rejected: context allocation exhausted (largest admissible 160 < peak 70000)",
			);
		});

		await expect(
			runPlacedAgent({ placement, label: "a", run }),
		).rejects.toThrow("context allocation exhausted");
		// One climb to 160, then the guard's worth of flat refusals before it
		// gives up — far short of MAX_REFUSED_REQUEUES.
		expect(run).toHaveBeenCalledTimes(MAX_STALLED_DURABLE_REFUSALS + 1);
	});

	// The other side of the guard: while the admissible figure keeps climbing,
	// siblings are finishing and space is opening, so waiting is still worth it.
	it("keeps re-queuing a durable refusal while its admissible headroom is still climbing", async () => {
		const { placement } = fakePlacement(["oc"]);
		const run = vi.fn();
		for (const admissible of [160, 200, 320]) {
			run.mockImplementationOnce(async () => {
				throw new Error(
					`admission rejected: context allocation exhausted (largest admissible ${admissible} < peak 70000)`,
				);
			});
		}
		run.mockImplementationOnce(async (_node, admitted: () => void) => {
			admitted();
			return ok("done");
		});

		const outcome = await runPlacedAgent({ placement, label: "a", run });

		expect(outcome.result.text).toBe("done");
		expect(run).toHaveBeenCalledTimes(4);
	});
});

describe("telling a refusal from the agent's own failure", () => {
	it("reads the admission gate's 429 and a full pool owner as refusals", () => {
		expect(isRefusedSpawn(Object.assign(new Error("x"), { status: 429 }))).toBe(
			true,
		);
		expect(
			isRefusedSpawn(
				new Error(
					"admission rejected: session allocation full (worker of 'lead')",
				),
			),
		).toBe(true);
		expect(
			isRefusedSpawn({
				text: "429 Too Many Requests",
				finishReason: "error",
				usage: { inputTokens: 0, outputTokens: 0 },
			}),
		).toBe(true);
	});

	it("does not read an overflow, a 400 or a finished run as one", () => {
		expect(
			isRefusedSpawn(
				new Error("input (300000 tokens) is larger than the max context size"),
			),
		).toBe(false);
		expect(
			isRefusedSpawn(Object.assign(new Error("bad"), { status: 400 })),
		).toBe(false);
		// Output was produced: whatever it says, the engine took it.
		expect(
			isRefusedSpawn({
				text: "the rate limit on line 4 is wrong",
				finishReason: "error",
				usage: { inputTokens: 10, outputTokens: 40 },
			}),
		).toBe(false);
	});

	it("reads a durable admission refusal and its headroom, and a 429 as neither", () => {
		const durable = new Error(
			"admission rejected: context allocation exhausted (largest admissible 160 < peak 70000)",
		);
		expect(isDurableRefusal(durable)).toBe(true);
		expect(admissionHeadroom(durable)).toBe(160);
		expect(
			isDurableRefusal(new Error("projected mean tps below floor (0.4 < 1)")),
		).toBe(true);
		// A 429 or a full window frees when a sibling finishes: a refusal, but
		// not a durable one, and it states no admissible figure.
		expect(
			isDurableRefusal(
				Object.assign(new Error("Too Many Requests"), { status: 429 }),
			),
		).toBe(false);
		expect(admissionHeadroom(new Error("Too Many Requests"))).toBeUndefined();
	});
});

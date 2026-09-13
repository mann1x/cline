import type { AgentEvent, AgentResult } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { createExpertSession, type ExpertRuntime } from "./expert-session";

/**
 * A runtime that answers immediately and reports whatever timings the test
 * hands it, so the accounting can be checked without a provider.
 */
function stubRuntime(
	options: {
		replies?: string[];
		/** Per-call finish reason, so a test can stage a run that failed. */
		finishReasons?: Array<AgentResult["finishReason"]>;
		timings?: Array<{
			inputTokens: number;
			outputTokens: number;
			generateTokens?: number;
			generateMs?: number;
		}>;
	} = {},
) {
	let onEvent: ((event: AgentEvent) => void) | undefined;
	let call = 0;
	const runtime: ExpertRuntime = {
		run: vi.fn(async (_prompt: string): Promise<AgentResult> => {
			const index = call++;
			const turn = options.timings?.[index];
			if (turn) {
				onEvent?.({
					type: "usage",
					inputTokens: turn.inputTokens,
					outputTokens: turn.outputTokens,
					totalInputTokens: turn.inputTokens,
					totalOutputTokens: turn.outputTokens,
					...(turn.generateTokens !== undefined
						? {
								timings: {
									engine: "ollama",
									generateTokens: turn.generateTokens,
									generateMs: turn.generateMs,
								},
							}
						: {}),
				} as AgentEvent);
			}
			return {
				text: options.replies?.[index] ?? `reply ${index + 1}`,
				iterations: 1,
				finishReason: options.finishReasons?.[index] ?? "completed",
				usage: {
					inputTokens: turn?.inputTokens ?? 0,
					outputTokens: turn?.outputTokens ?? 0,
				},
			} as AgentResult;
		}),
		shutdown: vi.fn(async () => {}),
	};
	return {
		runtime,
		subscribe: (listener: (event: AgentEvent) => void) => {
			onEvent = listener;
		},
	};
}

function sessionWith(stub: ReturnType<typeof stubRuntime>, maxFollowUps = 20) {
	return createExpertSession({
		maxFollowUps,
		open: async ({ onEvent }) => {
			stub.subscribe(onEvent);
			return stub.runtime;
		},
	});
}

describe("createExpertSession", () => {
	it("answers the first brief and reports what the expert said", async () => {
		const stub = stubRuntime({ replies: ["the bug is on line 90"] });
		const session = sessionWith(stub);

		const reply = await session.ask("goal: make the check pass");

		expect(reply.text).toBe("the bug is on line 90");
		expect(stub.runtime.run).toHaveBeenCalledWith("goal: make the check pass");
	});

	// The expert is usually the metered one, so what it spent has to be
	// separable from the session's own -- a total that folds the two together
	// cannot answer the only question a paid account raises.
	it("accounts tokens and the provider's own generation time per escalation", async () => {
		const stub = stubRuntime({
			timings: [
				{
					inputTokens: 1_000,
					outputTokens: 200,
					generateTokens: 200,
					generateMs: 4_000,
				},
				{
					inputTokens: 1_500,
					outputTokens: 100,
					generateTokens: 100,
					generateMs: 2_000,
				},
			],
		});
		const session = sessionWith(stub);

		await session.ask("first");
		await session.ask("second");

		expect(session.usage.inputTokens).toBe(2_500);
		expect(session.usage.outputTokens).toBe(300);
		expect(session.usage.generateTokens).toBe(300);
		expect(session.usage.generateMs).toBe(6_000);
		expect(session.usage.requests).toBe(2);
	});

	// Wall time is the other half of a cloud bill, and it is not the provider's
	// generation time: a request that queues for a minute costs that minute.
	it("measures the wall time the expert was running", async () => {
		const stub = stubRuntime();
		const session = sessionWith(stub);

		await session.ask("first");

		expect(session.usage.wallMs).toBeGreaterThanOrEqual(0);
		expect(Number.isFinite(session.usage.wallMs)).toBe(true);
	});

	// The first ask is the escalation itself. Counting it as a follow-up would
	// spend one of the twenty before the expert had said anything.
	it("counts follow-ups from the second ask", async () => {
		const stub = stubRuntime();
		const session = sessionWith(stub);

		await session.ask("first");
		expect(session.followUps).toBe(0);

		await session.ask("second");
		expect(session.followUps).toBe(1);
	});

	// The cap exists to stop two models talking to each other indefinitely on a
	// metered account. It bounds follow-ups, not the escalation.
	it("refuses a follow-up past the cap, naming the cap", async () => {
		const stub = stubRuntime();
		const session = sessionWith(stub, 1);

		await session.ask("first");
		await session.ask("follow-up");

		await expect(session.ask("one too many")).rejects.toThrow(/follow-up/i);
		expect(stub.runtime.run).toHaveBeenCalledTimes(2);
	});

	// Held, not reopened: the point of holding is that the expert still has the
	// exchange in its context and a hosted provider's prompt cache is still
	// warm. Opening a second runtime would pay for the whole conversation again.
	it("holds one conversation across follow-ups", async () => {
		const stub = stubRuntime();
		const open = vi.fn(
			async ({ onEvent }: { onEvent: (event: AgentEvent) => void }) => {
				stub.subscribe(onEvent);
				return stub.runtime;
			},
		);
		const session = createExpertSession({ maxFollowUps: 20, open });

		await session.ask("first");
		await session.ask("second");

		expect(open).toHaveBeenCalledTimes(1);
	});

	// Closing is what frees a local server's slot. After it, the session is
	// spent: a caller that asks again has a bug, and silently reopening would
	// hide it behind a second model load.
	it("shuts the runtime down on close and refuses to be reused", async () => {
		const stub = stubRuntime();
		const session = sessionWith(stub);

		await session.ask("first");
		await session.close();

		expect(stub.runtime.shutdown).toHaveBeenCalled();
		expect(session.closed).toBe(true);
		await expect(session.ask("again")).rejects.toThrow(/closed/i);
	});

	// Closing twice is not an error -- a caller that closes on the way out and
	// again on session teardown is the ordinary case, and the second close must
	// not shut a runtime down twice.
	it("is safe to close twice", async () => {
		const stub = stubRuntime();
		const session = sessionWith(stub);

		await session.ask("first");
		await session.close();
		await session.close();

		expect(stub.runtime.shutdown).toHaveBeenCalledTimes(1);
	});

	// Nothing was opened, so there is nothing to shut down. Worth pinning: the
	// alternative is opening a runtime in order to close it, which on a local
	// server means loading a model to unload it.
	it("closes an expert that was never asked anything without opening one", async () => {
		const open = vi.fn();
		const session = createExpertSession({ maxFollowUps: 20, open });

		await session.close();

		expect(open).not.toHaveBeenCalled();
		expect(session.closed).toBe(true);
	});

	// A local endpoint queues the request that finds no free slot rather than
	// refusing it, so an ungated expert call reads as a slow run. Gated around
	// the run alone: holding a slot across the brief-building would book a slot
	// the server could have been serving with.
	it("runs inside the slot gate when one is given", async () => {
		const stub = stubRuntime();
		const order: string[] = [];
		const session = createExpertSession({
			maxFollowUps: 20,
			open: async ({ onEvent }) => {
				stub.subscribe(onEvent);
				return stub.runtime;
			},
			gate: {
				run: async (task) => {
					order.push("enter");
					const result = await task();
					order.push("exit");
					return result;
				},
				active: () => 0,
			},
		});

		await session.ask("first");

		expect(order).toEqual(["enter", "exit"]);
	});

	// The failure this exists for: ollama answered "ollama cloud is disabled"
	// 31ms after a hand-over, the run finished with `error`, and its message was
	// handed to the base model wrapped in "THIS IS A DELIVERY, NOT A VERDICT".
	// The model read it as an empty delivery and carried on alone, an escalation
	// the poorer. A run that failed has no answer in it; saying so is the only
	// honest thing the session can do with one.
	it("refuses to pass a failed run off as the expert's answer", async () => {
		const stub = stubRuntime({
			replies: ["ollama cloud is disabled: remote model is unavailable"],
			finishReasons: ["error"],
		});
		const session = sessionWith(stub);

		await expect(session.ask("goal: fix line 90")).rejects.toThrow(
			/ollama cloud is disabled/,
		);
	});

	it("does not count a failed run as a delivery", async () => {
		const stub = stubRuntime({
			replies: ["upstream is down", "the bug is on line 90"],
			finishReasons: ["error", "completed"],
		});
		const session = sessionWith(stub);

		await expect(session.ask("goal: fix line 90")).rejects.toThrow();
		expect(session.deliveries).toBe(0);

		const reply = await session.ask("goal: fix line 90");

		expect(reply.text).toBe("the bug is on line 90");
		expect(session.deliveries).toBe(1);
		expect(session.followUps).toBe(0);
	});

	// A run that stopped for any other reason did produce something. A model
	// that hit its iteration cap mid-repair has a partial answer worth reading,
	// and turning that into an exception would throw the spend away with it.
	it("still delivers a run that stopped for a reason other than error", async () => {
		const stub = stubRuntime({
			replies: ["I got as far as line 90"],
			finishReasons: ["max_iterations"],
		});
		const session = sessionWith(stub);

		const reply = await session.ask("goal: fix line 90");

		expect(reply.text).toBe("I got as far as line 90");
		expect(reply.finishReason).toBe("max_iterations");
	});
});

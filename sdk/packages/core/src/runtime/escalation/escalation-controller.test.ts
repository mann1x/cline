import { describe, expect, it, vi } from "vitest";
import { createEscalationController } from "./escalation-controller";
import type { ExpertSession, ExpertUsage } from "./expert-session";

function fakeSession(usage: Partial<ExpertUsage> = {}): ExpertSession & {
	closeCalls: number;
} {
	let closed = false;
	const state = {
		inputTokens: 0,
		outputTokens: 0,
		generateTokens: 0,
		generateMs: 0,
		wallMs: 0,
		requests: 0,
		...usage,
	};
	return {
		closeCalls: 0,
		get followUps() {
			return 0;
		},
		get closed() {
			return closed;
		},
		get usage() {
			return { ...state };
		},
		ask: vi.fn(async () => ({
			text: "ok",
			iterations: 1,
			usage: { ...state },
		})),
		close: vi.fn(async function (this: { closeCalls: number }) {
			this.closeCalls += 1;
			closed = true;
		}),
	} as unknown as ExpertSession & { closeCalls: number };
}

describe("createEscalationController", () => {
	it("spends one escalation per hand-over", () => {
		const controller = createEscalationController({
			maxEscalations: 3,
			closeAfterEscalation: false,
			createSession: () => fakeSession(),
		});

		expect(controller.remaining).toBe(3);
		controller.begin();
		expect(controller.remaining).toBe(2);
		expect(controller.used).toBe(1);
	});

	// The budget is what stops a stuck model spending a metered account on a
	// problem it is not going to solve. When it is gone the guards stop the run
	// exactly as they did before the feature existed, and the message says so
	// rather than leaving the model to guess.
	it("refuses past the budget, naming the limit and what happens instead", () => {
		const controller = createEscalationController({
			maxEscalations: 1,
			closeAfterEscalation: false,
			createSession: () => fakeSession(),
		});

		controller.begin();
		controller.end();

		expect(() => controller.begin()).toThrow(
			/already escalated 1 time, which is the limit/i,
		);
		expect(controller.remaining).toBe(0);
	});

	// Held by default. The expert still has the exchange in its context and a
	// hosted provider's prompt cache is still warm, so the second escalation
	// sends a message rather than a conversation.
	it("holds one expert across escalations when told to hold", async () => {
		const created: ExpertSession[] = [];
		const controller = createEscalationController({
			maxEscalations: 3,
			closeAfterEscalation: false,
			createSession: () => {
				const session = fakeSession();
				created.push(session);
				return session;
			},
		});

		const first = controller.begin();
		await controller.end();
		const second = controller.begin();

		expect(created).toHaveLength(1);
		expect(second).toBe(first);
		expect(first.closed).toBe(false);
	});

	// And released when told to release. A single-slot local server cannot load
	// another model while the expert is holding one, so on that hardware the
	// hold is the thing that breaks the next request.
	it("releases the expert after each escalation when told to close", async () => {
		const created: ExpertSession[] = [];
		const controller = createEscalationController({
			maxEscalations: 3,
			closeAfterEscalation: true,
			createSession: () => {
				const session = fakeSession();
				created.push(session);
				return session;
			},
		});

		const first = controller.begin();
		await controller.end();
		const second = controller.begin();

		expect(first.closed).toBe(true);
		expect(created).toHaveLength(2);
		expect(second).not.toBe(first);
	});

	// The whole point of accounting the expert separately: a task that escalated
	// three times has spent three times, and closing a conversation must not
	// take its cost with it.
	it("keeps the task's expert spend across closed conversations", async () => {
		const usages = [
			{
				inputTokens: 1_000,
				outputTokens: 100,
				generateTokens: 100,
				generateMs: 2_000,
				requests: 1,
			},
			{
				inputTokens: 2_000,
				outputTokens: 300,
				generateTokens: 300,
				generateMs: 3_000,
				requests: 2,
			},
		];
		let index = 0;
		const controller = createEscalationController({
			maxEscalations: 3,
			closeAfterEscalation: true,
			createSession: () => fakeSession(usages[index++]),
		});

		controller.begin();
		await controller.end();
		controller.begin();
		await controller.end();

		expect(controller.usage.inputTokens).toBe(3_000);
		expect(controller.usage.outputTokens).toBe(400);
		expect(controller.usage.generateTokens).toBe(400);
		expect(controller.usage.generateMs).toBe(5_000);
		expect(controller.usage.requests).toBe(3);
	});

	// A held conversation's spend counts while it is still open, or the figure
	// on screen would jump only when a conversation was closed.
	it("counts a held conversation's spend while it is still open", async () => {
		const controller = createEscalationController({
			maxEscalations: 3,
			closeAfterEscalation: false,
			createSession: () =>
				fakeSession({ inputTokens: 500, outputTokens: 50, requests: 1 }),
		});

		controller.begin();
		await controller.end();

		expect(controller.usage.inputTokens).toBe(500);
		expect(controller.usage.requests).toBe(1);
	});

	// Teardown releases whatever is held, whatever the setting says: a task that
	// ends with an expert held would leave a local slot booked by a session
	// nothing can reach any more.
	it("releases a held expert on teardown", async () => {
		const session = fakeSession();
		const controller = createEscalationController({
			maxEscalations: 3,
			closeAfterEscalation: false,
			createSession: () => session,
		});

		controller.begin();
		await controller.end();
		await controller.dispose();

		expect(session.closed).toBe(true);
	});
});

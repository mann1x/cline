import type {
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
	AgentTool,
} from "@cline/shared";
import { NON_CONVERGENCE_NUDGE_PREFIX } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./agent-runtime";

/**
 * A model that plays a fixed script of turns and then repeats its last one.
 *
 * Repeating rather than throwing on exhaustion is deliberate: these runs end
 * when the runtime decides they do, and a script that runs out would make the
 * test assert on its own length instead of on the guard.
 */
class ScriptModel implements AgentModel {
	public requests = 0;

	constructor(private readonly steps: Array<() => Iterable<AgentModelEvent>>) {}

	async stream(
		_request: AgentModelRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
		const step = this.steps[Math.min(this.requests, this.steps.length - 1)];
		this.requests += 1;
		return (async function* () {
			for (const event of step()) {
				yield event;
			}
		})();
	}
}

/** A turn that reasons at length and calls nothing — the failure itself. */
function* thinkingOnlyTurn(): Iterable<AgentModelEvent> {
	// Comfortably past NON_CONVERGENCE_MIN_REASONING_CHARS, so the tests below
	// exercise the streak rather than sitting on the floor's edge.
	for (let i = 0; i < 100; i++) {
		yield {
			type: "reasoning-delta",
			text: `Considering approach ${i}, which differs from the last one.\n`,
		};
	}
	yield { type: "finish", reason: "stop" };
}

/** A turn that thinks briefly and answers — a model being nagged, not stuck. */
function* briefAnswerTurn(): Iterable<AgentModelEvent> {
	yield { type: "reasoning-delta", text: "Already done; nothing left to do." };
	yield { type: "text-delta", text: "The task is complete." };
	yield { type: "finish", reason: "stop" };
}

function* toolCallTurn(): Iterable<AgentModelEvent> {
	yield {
		type: "tool-call-delta",
		toolCallId: `call_${Math.random().toString(36).slice(2, 8)}`,
		toolName: "echo",
		inputText: '{"text":"hi"}',
	};
	yield { type: "finish", reason: "tool-calls" };
}

const echoTool = (): AgentTool<{ text: string }, { echoed: string }> => ({
	name: "echo",
	description: "Echo input text",
	inputSchema: { type: "object" },
	async execute(input) {
		return { echoed: input.text };
	},
});

function nudgeCount(
	messages: Array<{ role: string; content: unknown }>,
): number {
	return messages.filter(
		(message) =>
			message.role === "user" &&
			JSON.stringify(message.content).includes(NON_CONVERGENCE_NUDGE_PREFIX),
	).length;
}

describe("the non-convergence nudge", () => {
	it("fires on a streak the nudge counter cannot see", async () => {
		// The shape measured on run 0007: every silent turn is answered by a
		// completion-boundary message rather than by a nudge, so
		// `consecutiveNoToolCallNudges` never gets past one and the run goes on
		// thinking. Six turns and ~226,000 characters of reasoning came out of
		// this in the field, with no tool call in any of them.
		const boundaryReplies = [
			"TX-01 discarded — the check ran and did not pass.",
			"You changed this file and have not checked it since.",
			"TX-02 was submitted with nothing changed.",
		];
		let boundaryCalls = 0;
		const model = new ScriptModel([thinkingOnlyTurn]);
		const runtime = new AgentRuntime({
			model,
			maxIterations: 20,
			completionPolicy: {
				maxNoToolCallNudges: 1,
				onCompletionAttempt: async () => boundaryReplies[boundaryCalls++],
			},
		});

		const result = await runtime.run("go");

		expect(nudgeCount(result.messages)).toBe(1);
	});

	it("never ends the run: the model keeps its turn afterwards", async () => {
		const model = new ScriptModel([
			thinkingOnlyTurn,
			thinkingOnlyTurn,
			thinkingOnlyTurn,
			// The nudge lands here, and the run must still have somewhere to go.
			toolCallTurn,
			function* () {
				yield { type: "text-delta", text: "fixed" };
				yield { type: "finish", reason: "stop" };
			},
		]);
		let boundaryCalls = 0;
		const runtime = new AgentRuntime({
			model,
			tools: [echoTool()],
			// Bounded, unlike the field: a boundary that answers forever and a
			// model that answers it forever is a test that never returns.
			maxIterations: 20,
			completionPolicy: {
				maxNoToolCallNudges: 1,
				onCompletionAttempt: async () =>
					boundaryCalls++ < 3 ? "keep going" : undefined,
			},
		});

		const result = await runtime.run("go");

		expect(result.status).toBe("completed");
		expect(nudgeCount(result.messages)).toBe(1);
		// The run reached the turn after the nudge and did the work.
		expect(
			result.messages.filter((message) => message.role === "tool"),
		).toHaveLength(1);
	});

	it("is spent once per run", async () => {
		let boundaryCalls = 0;
		const model = new ScriptModel([thinkingOnlyTurn]);
		const runtime = new AgentRuntime({
			model,
			maxIterations: 20,
			completionPolicy: {
				maxNoToolCallNudges: 1,
				onCompletionAttempt: async () =>
					boundaryCalls++ < 8 ? "keep going" : undefined,
			},
		});

		const result = await runtime.run("go");

		// Eight further chances to fire, and it takes none of them: an unbounded
		// nudge is what makes a run immortal.
		expect(nudgeCount(result.messages)).toBe(1);
	});

	it("does not fire on a run that keeps calling tools", async () => {
		// The false positive that matters. A thinking turn between two working
		// ones is how a healthy run of this model looks — 87 of 106 measured
		// turns did exactly this — and the streak must reset on each.
		let boundaryCalls = 0;
		const model = new ScriptModel([
			thinkingOnlyTurn,
			toolCallTurn,
			thinkingOnlyTurn,
			toolCallTurn,
			thinkingOnlyTurn,
			toolCallTurn,
			function* () {
				yield { type: "text-delta", text: "done" };
				yield { type: "finish", reason: "stop" };
			},
		]);
		const runtime = new AgentRuntime({
			model,
			tools: [echoTool()],
			maxIterations: 20,
			completionPolicy: {
				maxNoToolCallNudges: 1,
				// Kept alive past the point a streak of three would have formed,
				// so the test proves the reset rather than an early exit.
				onCompletionAttempt: async () =>
					boundaryCalls++ < 4 ? "keep going" : undefined,
			},
		});

		const result = await runtime.run("go");

		expect(result.status).toBe("completed");
		expect(nudgeCount(result.messages)).toBe(0);
	});

	it("does not fire on a finished model answering the boundary again", async () => {
		// The false positive this floor exists for, and the one the first draft
		// of this guard had: a model that is done, answers in one sentence, is
		// asked again by the completion boundary, and answers again. Telling
		// that run to stop analysing and call something is exactly backwards.
		let boundaryCalls = 0;
		const model = new ScriptModel([briefAnswerTurn]);
		const runtime = new AgentRuntime({
			model,
			maxIterations: 20,
			completionPolicy: {
				maxNoToolCallNudges: 1,
				onCompletionAttempt: async () =>
					boundaryCalls++ < 6 ? "are you sure?" : undefined,
			},
		});

		const result = await runtime.run("go");

		expect(nudgeCount(result.messages)).toBe(0);
	});

	it("stays off for a host that disabled nudges altogether", async () => {
		// A host with the budget at zero has said a silent turn ends the run.
		// This must not be a second door into the same room.
		const model = new ScriptModel([thinkingOnlyTurn]);
		const runtime = new AgentRuntime({
			model,
			maxIterations: 20,
			completionPolicy: { maxNoToolCallNudges: 0 },
		});

		const result = await runtime.run("go");

		expect(nudgeCount(result.messages)).toBe(0);
	});

	it("can be turned off on its own with a zero limit", async () => {
		let boundaryCalls = 0;
		const model = new ScriptModel([thinkingOnlyTurn]);
		const runtime = new AgentRuntime({
			model,
			maxIterations: 20,
			completionPolicy: {
				maxNoToolCallNudges: 1,
				noToolCallTurnStreakLimit: 0,
				onCompletionAttempt: async () =>
					boundaryCalls++ < 5 ? "keep going" : undefined,
			},
		});

		const result = await runtime.run("go");

		expect(nudgeCount(result.messages)).toBe(0);
	});

	it("names the streak and the reasoning it spent", async () => {
		let boundaryCalls = 0;
		const model = new ScriptModel([thinkingOnlyTurn]);
		const runtime = new AgentRuntime({
			model,
			maxIterations: 20,
			completionPolicy: {
				maxNoToolCallNudges: 1,
				onCompletionAttempt: async () =>
					boundaryCalls++ < 3 ? "keep going" : undefined,
			},
		});

		const result = await runtime.run("go");

		const nudge = result.messages
			.filter(
				(message) =>
					message.role === "user" &&
					JSON.stringify(message.content).includes(
						NON_CONVERGENCE_NUDGE_PREFIX,
					),
			)
			.at(0);
		const text = JSON.stringify(nudge?.content);
		expect(text).toContain("3 turns in a row");
		// Three turns of the scripted reasoning, rounded to thousands.
		expect(text).toMatch(/characters of reasoning/);
	});
});

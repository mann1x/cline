import type {
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
	AgentRuntimeEvent,
} from "@cline/shared";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./agent-runtime";

class CountingModel implements AgentModel {
	/** Events actually pulled from the script, per request. */
	public readonly yielded: number[] = [];

	constructor(private readonly steps: Array<() => Iterable<AgentModelEvent>>) {}

	async stream(
		_request: AgentModelRequest,
	): Promise<AsyncIterable<AgentModelEvent>> {
		const step = this.steps.shift();
		if (!step) {
			throw new Error("No scripted step available");
		}
		const index = this.yielded.push(0) - 1;
		const self = this;
		return (async function* () {
			for (const event of step()) {
				self.yielded[index] += 1;
				yield event;
			}
		})();
	}
}

/** A turn whose reasoning collapses, followed by a normal ending. */
function* collapsingTurn(): Iterable<AgentModelEvent> {
	for (let i = 0; i < 4000; i++) {
		yield { type: "reasoning-delta", text: "- [x] Create a new file\n" };
	}
	yield { type: "text-delta", text: "done" };
	yield { type: "finish", reason: "stop" };
}

function* healthyTurn(): Iterable<AgentModelEvent> {
	yield { type: "reasoning-delta", text: "let me look at the file" };
	yield { type: "text-delta", text: "done" };
	yield { type: "finish", reason: "stop" };
}

function notices(events: AgentRuntimeEvent[]): Array<Record<string, unknown>> {
	return events
		.filter((event) => event.type === "status-notice")
		.map(
			(event) =>
				(event as { metadata?: Record<string, unknown> }).metadata ?? {},
		)
		.filter((metadata) => metadata.kind === "reasoning_loop");
}

describe("the reasoning loop guard, inside the runtime", () => {
	it("cuts the request instead of streaming the whole collapse", async () => {
		// The cut turn is not the answer: the run asks again, with a reminder
		// about the cut, and ends on the turn after it.
		const model = new CountingModel([collapsingTurn, healthyTurn]);
		const events: AgentRuntimeEvent[] = [];
		const runtime = new AgentRuntime({ model });
		runtime.subscribe((event) => {
			events.push(event);
		});

		const result = await runtime.run("go");

		expect(result.status).toBe("completed");
		// The cut is the whole point: the provider stops being billed for a
		// degenerate draw long before it reaches the context window.
		expect(model.yielded[0]).toBeLessThan(500);

		const seen = notices(events);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.phase).toBe("cut");
		expect(seen[0]?.consecutiveTrips).toBe(1);

		const [cut, reminder] = result.messages.slice(1, 3);
		expect(
			(cut?.metadata as { reasoningLoop?: { kind: string } } | undefined)
				?.reasoningLoop?.kind,
		).toBe("low-uniqueness");
		expect(JSON.stringify(reminder?.content)).toContain(
			"Your thinking was cut while you were writing it",
		);
	});

	it("streams the whole collapse when the guard is turned off", async () => {
		const model = new CountingModel([collapsingTurn]);
		const events: AgentRuntimeEvent[] = [];
		const runtime = new AgentRuntime({ model, reasoningLoopDetection: false });
		runtime.subscribe((event) => {
			events.push(event);
		});

		const result = await runtime.run("go");

		expect(result.status).toBe("completed");
		expect(model.yielded[0]).toBe(4002);
		expect(notices(events)).toHaveLength(0);
	});

	it("ends the run once the model redraws the same collapse too often", async () => {
		const model = new CountingModel([collapsingTurn, collapsingTurn]);
		const events: AgentRuntimeEvent[] = [];
		const runtime = new AgentRuntime({
			model,
			reasoningLoopDetection: { maxConsecutiveTrips: 2 },
			// Without nudges a turn carrying no tool call ends the run on its own,
			// and the streak would never get a second turn to count.
			completionPolicy: { maxNoToolCallNudges: 5 },
		});
		runtime.subscribe((event) => {
			events.push(event);
		});

		const result = await runtime.run("go");

		expect(result.status).toBe("aborted");
		expect(result.abortReason).toContain("distinct lines");
		const seen = notices(events);
		expect(seen.map((n) => n.phase)).toEqual(["cut", "aborted"]);
		// The limit that applied rides with each count, so a reader need not
		// assume the default of 3.
		expect(seen.map((n) => n.maxConsecutiveTrips)).toEqual([2, 2]);
	});

	// The seam the mistake limit has had since it was written, given to the
	// other terminal guard. A host that answers `continue` gets one more turn.
	it("lets a host answer the streak with one more turn", async () => {
		// A cut turn is answered by its own reminder and spends none of the
		// five no-tool-call nudges, so each healthy turn after it spends one.
		const model = new CountingModel([
			collapsingTurn,
			collapsingTurn,
			healthyTurn,
			healthyTurn,
			healthyTurn,
			healthyTurn,
			healthyTurn,
			healthyTurn,
		]);
		const events: AgentRuntimeEvent[] = [];
		const asked: number[] = [];
		const runtime = new AgentRuntime({
			model,
			reasoningLoopDetection: { maxConsecutiveTrips: 2 },
			completionPolicy: { maxNoToolCallNudges: 5 },
			onReasoningLoopLimitReached: (context) => {
				asked.push(context.consecutiveTrips);
				return { action: "continue", guidance: "hand this over instead" };
			},
		});
		runtime.subscribe((event) => {
			events.push(event);
		});

		const result = await runtime.run("go");

		expect(asked).toEqual([2]);
		expect(result.status).toBe("completed");
		// After the turn it answers, with that turn's reminder: it was sent
		// ahead of it, between the first cut's reminder and the second cut.
		const roles = result.messages.map((message) => message.role);
		const guided = result.messages.findIndex((message) =>
			JSON.stringify(message.content).includes("hand this over instead"),
		);
		expect(roles.slice(1, 5)).toEqual([
			"assistant",
			"user",
			"assistant",
			"user",
		]);
		expect(guided).toBe(4);
		expect(JSON.stringify(result.messages[4]?.content)).toContain(
			"Your thinking was cut while you were writing it",
		);
	});

	// Deferred, never removed: the streak is not forgiven, so the next turn cut
	// the same way arrives back at the limit with the decision already spent.
	it("ends the run on the next collapse after a host said continue", async () => {
		const model = new CountingModel([
			collapsingTurn,
			collapsingTurn,
			collapsingTurn,
		]);
		let answered = 0;
		const runtime = new AgentRuntime({
			model,
			reasoningLoopDetection: { maxConsecutiveTrips: 2 },
			completionPolicy: { maxNoToolCallNudges: 5 },
			onReasoningLoopLimitReached: () => {
				answered += 1;
				return answered === 1
					? { action: "continue", guidance: "one more turn" }
					: { action: "stop" };
			},
		});

		const result = await runtime.run("go");

		expect(answered).toBe(2);
		expect(result.status).toBe("aborted");
	});

	it("forgets the streak after a turn that streams cleanly", async () => {
		const model = new CountingModel([
			collapsingTurn,
			healthyTurn,
			collapsingTurn,
		]);
		const events: AgentRuntimeEvent[] = [];
		const runtime = new AgentRuntime({
			model,
			reasoningLoopDetection: { maxConsecutiveTrips: 2 },
			completionPolicy: { maxNoToolCallNudges: 5 },
		});
		runtime.subscribe((event) => {
			events.push(event);
		});

		const result = await runtime.run("go");

		// The healthy turn in the middle resets the count, so the third turn is
		// the first of a new streak rather than the last of the old one.
		expect(result.status).not.toBe("aborted");
		expect(notices(events).map((n) => n.consecutiveTrips)).toEqual([1, 1]);
	});
});

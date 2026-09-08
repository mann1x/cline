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
		const model = new CountingModel([collapsingTurn]);
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

		const assistant = result.messages
			.filter((m) => m.role === "assistant")
			.at(-1);
		expect(
			(assistant?.metadata as { reasoningLoop?: { kind: string } } | undefined)
				?.reasoningLoop?.kind,
		).toBe("low-uniqueness");
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

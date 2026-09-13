import type { ConsecutiveMistakeLimitContext } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { MistakeTracker } from "./mistake-tracker";

function makeTracker(maxConsecutiveMistakes = 6) {
	const limits: ConsecutiveMistakeLimitContext[] = [];
	const tracker = new MistakeTracker({
		maxConsecutiveMistakes,
		emit: () => undefined,
		log: () => undefined,
		agentId: "agent",
		getConversationId: () => "conversation",
		getActiveRunId: () => "run",
		appendRecoveryNotice: () => undefined,
		onLimitReached: (context) => {
			limits.push(context);
			return { action: "stop" as const };
		},
	});
	return { tracker, limits };
}

describe("MistakeTracker", () => {
	it("stops once the count reaches the limit", async () => {
		const { tracker, limits } = makeTracker(3);

		expect(
			(await tracker.record({ iteration: 1, reason: "api_error" })).action,
		).toBe("continue");
		expect(
			(await tracker.record({ iteration: 2, reason: "api_error" })).action,
		).toBe("continue");
		expect(
			(await tracker.record({ iteration: 3, reason: "api_error" })).action,
		).toBe("stop");
		expect(limits[0].consecutiveMistakes).toBe(3);
		expect(limits[0].forced).toBeUndefined();
	});

	// `forceAtLimit` used to jump the counter to the limit to get the stop, and
	// the host then reported that number as a count of errors: a repeated-call
	// loop with two failures behind it -- and two successful edits among the
	// turns it was counting -- was announced as "6 errors in a row".
	it("forces a stop without inventing the mistakes it did not have", async () => {
		const { tracker, limits } = makeTracker(6);

		await tracker.record({ iteration: 1, reason: "tool_execution_failed" });
		const outcome = await tracker.record({
			iteration: 2,
			reason: "tool_execution_failed",
			forceAtLimit: true,
			details: "repeated identical call",
		});

		expect(outcome.action).toBe("stop");
		expect(limits).toHaveLength(1);
		expect(limits[0].consecutiveMistakes).toBe(2);
		expect(limits[0].forced).toBe(true);
		if (outcome.action === "stop") {
			expect(outcome.message).toContain("2/6");
			expect(outcome.message).not.toContain("Stopped after 6/6");
		}
	});

	it("resets on a productive turn", async () => {
		const { tracker } = makeTracker(3);

		await tracker.record({ iteration: 1, reason: "api_error" });
		await tracker.record({ iteration: 2, reason: "api_error" });
		tracker.reset();
		expect(tracker.value).toBe(0);
		expect(
			(await tracker.record({ iteration: 3, reason: "api_error" })).action,
		).toBe("continue");
	});
});

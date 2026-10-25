import { describe, expect, it, vi } from "vitest";
import {
	createHubClientContributionRuntime,
	defaultClientContributionCapabilityName,
	HUB_REASONING_LOOP_LIMIT_CAPABILITY,
	parseHubClientContributions,
} from "./hub-client-contributions";

/**
 * The reasoning-loop decision across a hub, on the mistake limit's terms: the
 * client registers the capability, and the hub's session asks it when the
 * streak is about to end the run.
 */
describe("the reasoning-loop limit as a hub client contribution", () => {
	const context = {
		iteration: 4,
		consecutiveTrips: 3,
		maxConsecutiveTrips: 3,
		diagnosis: "The same plan, a third time.",
	};

	it("survives parsing and names its capability", () => {
		expect(
			parseHubClientContributions([
				{
					kind: "reasoningLoopLimit",
					capabilityName: HUB_REASONING_LOOP_LIMIT_CAPABILITY,
				},
			]),
		).toEqual([
			{
				kind: "reasoningLoopLimit",
				capabilityName: HUB_REASONING_LOOP_LIMIT_CAPABILITY,
			},
		]);
		expect(
			defaultClientContributionCapabilityName({
				kind: "reasoningLoopLimit",
			} as never),
		).toBe(HUB_REASONING_LOOP_LIMIT_CAPABILITY);
	});

	it("asks the client and returns its answer", async () => {
		const requestCapability = vi.fn(async () => ({
			result: { action: "continue" },
		}));
		const runtime = createHubClientContributionRuntime({
			sessionId: "session-1",
			targetClientId: "client-1",
			contributions: [
				{
					kind: "reasoningLoopLimit",
					capabilityName: HUB_REASONING_LOOP_LIMIT_CAPABILITY,
				},
			],
			requestCapability: requestCapability as never,
		});

		await expect(
			runtime.localRuntime.onReasoningLoopLimitReached?.(context),
		).resolves.toEqual({ action: "continue" });
		expect(requestCapability).toHaveBeenCalledWith(
			"session-1",
			HUB_REASONING_LOOP_LIMIT_CAPABILITY,
			{ context },
			"client-1",
		);
	});

	it("adds no decision for a client that registered none", () => {
		const runtime = createHubClientContributionRuntime({
			sessionId: "session-1",
			targetClientId: "client-1",
			contributions: [],
			requestCapability: vi.fn() as never,
		});
		expect(runtime.localRuntime.onReasoningLoopLimitReached).toBeUndefined();
	});
});

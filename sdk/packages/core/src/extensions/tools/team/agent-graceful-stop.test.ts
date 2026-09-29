import type { AgentResult } from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewOnlyCheckWarning } from "./agent-check";
import {
	runWrapUpReport,
	stopSubagent,
	wrapUpNote,
} from "./agent-iteration-cap";
import {
	__resetSubagentCancellations,
	registerSubagentCancellation,
	subagentCancellation,
} from "./subagent-cancellation";

/**
 * A stop that aborted a running agent outright left the lead its file changes
 * and no word of what they were: 13 of 15 agents in swarm czbnh. A graceful
 * stop lets it finish its step and report.
 */
describe("a graceful stop", () => {
	afterEach(() => {
		__resetSubagentCancellations();
	});

	it("ends the segment at the next boundary and carries the transcript to a report", async () => {
		const agent = registerSubagentCancellation("s::c", undefined, "a");
		const carried: unknown[] = [];
		const result = await agent.continuable(async (carry) => {
			carried.push(carry);
			if (!carry) {
				agent.track({ getMessages: () => ["turn-1", "turn-2"] });
				expect(subagentCancellation.wrapUp("s::c", "lead")).toBe(true);
				expect(subagentCancellation.wrappingUp("s::c")).toBe(true);
				// Not before the boundary: the step it is in finishes.
				expect(agent.signal?.aborted).toBe(false);
				expect(agent.takeMessage()).toBeUndefined();
				expect(agent.signal?.aborted).toBe(true);
				throw new DOMException("aborted", "AbortError");
			}
			return "reported";
		});
		expect(result).toBe("reported");
		expect(carried[1]).toMatchObject({
			messages: ["turn-1", "turn-2"],
			wrapUp: "lead",
		});
		expect(subagentCancellation.stoppedBy("s::c")).toBe("lead");
	});

	it("is not replaced by a requeue asked while it is pending", () => {
		const agent = registerSubagentCancellation("s::c", undefined, "a");
		void agent.continuable(
			() => new Promise(() => {}), // a segment that is running
		);
		expect(subagentCancellation.wrapUp("s::c")).toBe(true);
		expect(subagentCancellation.requeue("s::c", { reason: "slow" })).toBe(
			false,
		);
	});

	it("is one reply with no tools, marked as partial work", async () => {
		const agent = {
			getAgentId: () => "a",
			restore: vi.fn(),
			setMaxIterations: vi.fn(),
			continue: vi.fn(
				async () =>
					({
						text: "Changed line 32; the game still fails at frame 3.",
						finishReason: "completed",
						iterations: 1,
						usage: { inputTokens: 10, outputTokens: 5 },
						messages: [],
						toolCalls: [],
					}) as unknown as AgentResult,
			),
		};
		const outcome = await runWrapUpReport({
			agent,
			messages: ["turn-1"],
			by: "user",
		});
		expect(agent.restore).toHaveBeenCalledWith(["turn-1"]);
		expect(agent.setMaxIterations).toHaveBeenCalledWith(1);
		expect(agent.continue).toHaveBeenCalledWith(wrapUpNote("user"));
		expect(outcome.stopReason).toBe("wrap_up");
		expect(outcome.result.text).toMatch(
			/^\[Stopped by the user before it finished/,
		);
		expect(outcome.result.text).toContain("Changed line 32");
	});

	it("reads as stopped with no answer when the report turn wrote nothing", async () => {
		const agent = {
			getAgentId: () => "a",
			restore: vi.fn(),
			continue: vi.fn(
				async () =>
					({
						text: "",
						finishReason: "max_iterations",
						iterations: 1,
						usage: { inputTokens: 10, outputTokens: 5 },
						messages: [],
						toolCalls: [],
					}) as unknown as AgentResult,
			),
		};
		const outcome = await runWrapUpReport({
			agent,
			messages: ["turn-1"],
			by: "lead",
		});
		expect(outcome.result.finishReason).toBe("aborted");
	});
});

describe("the one stop every control uses", () => {
	afterEach(() => {
		__resetSubagentCancellations();
	});

	it("is graceful by default, and immediate cuts a graceful stop short", () => {
		const agent = registerSubagentCancellation("s::c", undefined, "a");
		void agent.continuable(() => new Promise(() => {}));

		expect(stopSubagent({ cancelId: "s::c", by: "user" })).toBe("graceful");
		expect(agent.signal?.aborted).toBe(false);
		expect(
			stopSubagent({ cancelId: "s::c", by: "user", immediate: true }),
		).toBe("stopped");
		expect(agent.signal?.aborted).toBe(true);
	});

	it("stops at once an agent with no segment to take a report turn", () => {
		const agent = registerSubagentCancellation("s::c", undefined, "a");
		expect(stopSubagent({ cancelId: "s::c", by: "lead" })).toBe("stopped");
		expect(agent.signal?.aborted).toBe(true);
	});

	it("says when there is nothing to stop", () => {
		expect(stopSubagent({ cancelId: "s::gone", by: "user" })).toBe(
			"not_running",
		);
	});
});

describe("a check on a review-only agent", () => {
	const check = {
		command: "node run_game.js manic_miner.html",
		expect: '"ok":\\s*true',
	};

	// swarm czbnh: nine reviewers given the game's check; six ended on it
	// failing, after editing the file they were told to review.
	it("is warned about at spawn", () => {
		const warning = reviewOnlyCheckWarning([
			{
				name: "code-review-1",
				task: "Review manic_miner.html for correctness issues. Report all bugs found.",
				instructions: "You are a code reviewer. Provide a detailed report.",
				check,
			},
			{
				name: "brace-fixer-1",
				task: "Fix the unbalanced braces in manic_miner.html.",
				check,
			},
			{ name: "game-review-1", task: "Review the game logic." },
		]);
		expect(warning).toContain("code-review-1");
		expect(warning).not.toContain("brace-fixer-1");
		expect(warning).not.toContain("game-review-1");
		expect(warning).toContain("node run_game.js manic_miner.html");
	});

	it("says nothing when every checked agent is asked to change something", () => {
		expect(
			reviewOnlyCheckWarning([
				{
					name: "fixer",
					task: "Review the file, then fix every bug you find.",
					check,
				},
			]),
		).toBeUndefined();
	});
});

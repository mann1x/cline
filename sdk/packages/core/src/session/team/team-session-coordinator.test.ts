import { TeamMessageType } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import {
	dispatchTeamEventToBackend,
	emitTeamProgress,
} from "./team-session-coordinator";

describe("dispatchTeamEventToBackend", () => {
	it("persists intentionally aborted teammate tasks as cancelled", async () => {
		const invokeOptional = vi.fn(async () => {});
		const error = new DOMException("This operation was aborted", "AbortError");

		await dispatchTeamEventToBackend(
			"root-session",
			{
				type: TeamMessageType.TaskEnd,
				agentId: "teammate-1",
				status: "cancelled",
				error,
				messages: [],
			},
			invokeOptional,
		);

		expect(invokeOptional).toHaveBeenCalledWith(
			"onTeamTaskEnd",
			"root-session",
			"teammate-1",
			"cancelled",
			"[done] aborted",
			undefined,
			[],
		);
	});
});

describe("emitTeamProgress", () => {
	// What a teammate's row draws: every teammate, with its counts.
	it("carries every teammate with what it has done, and not the lead", () => {
		const helper = {
			agentId: "helper",
			role: "teammate" as const,
			status: "running" as const,
			activity: { toolCalls: 5, compactions: 1 },
			taskActivity: { toolCalls: 2, compactions: 0 },
		};
		const state = {
			teamId: "t1",
			teamName: "team",
			members: [
				{ agentId: "lead", role: "lead" as const, status: "idle" as const },
				helper,
			],
			tasks: [],
			mailbox: [],
			missionLog: [],
			runs: [],
			outcomes: [],
			outcomeFragments: [],
		};
		const emit = vi.fn();
		emitTeamProgress(
			{
				runtime: {
					teamRuntime: {
						getTeamName: () => "team",
						exportState: () => state,
					},
				},
			} as never,
			"root-session",
			{ type: TeamMessageType.TaskStart, agentId: "helper", message: "go" },
			emit,
		);
		expect(emit.mock.calls[0]?.[0].payload.teammates).toEqual([helper]);
	});
});

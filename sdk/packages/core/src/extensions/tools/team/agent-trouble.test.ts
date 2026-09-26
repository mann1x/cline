import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createAgentTroubleWatch,
	LEAD_NUDGE_AFTER_MS,
	LEAD_NUDGE_BATCH_MS,
	onLeadNudge,
	roomWaitTrouble,
	sendLeadNudge,
} from "./agent-trouble";

const TPS = "pool 5 admission rejected: projected mean tps below floor";

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-25T05:16:25Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

function watchFor(name: string, sent: string[], sessionId = "lead-1") {
	return createAgentTroubleWatch({
		sessionId,
		name,
		send: (_id, text) => {
			sent.push(text);
			return true;
		},
	});
}

/**
 * The user's ruling after 1tmrl: agents retry and never fail; after very
 * extended retries and refusals, tell the lead and let it consider taking
 * the tasks back. The user can always stop the agents from the UI.
 */
describe("telling the lead about agents stuck for a long time", () => {
	it("says nothing before ten minutes of continuous waiting", async () => {
		const sent: string[] = [];
		const watch = watchFor("reviewer-1", sent);
		watch.waiting({ kind: "refusal", where: "Node1", detail: TPS });
		await vi.advanceTimersByTimeAsync(LEAD_NUDGE_AFTER_MS - 1_000);
		expect(sent).toEqual([]);
		watch.dispose();
	});

	it("reports an agent refused for ten minutes, why, and what the lead may do", async () => {
		const sent: string[] = [];
		const watch = watchFor("code-correctness-2", sent);
		for (let i = 0; i < 14; i += 1) {
			watch.waiting({ kind: "refusal", where: "Node1", detail: TPS });
			await vi.advanceTimersByTimeAsync(45_000);
		}
		await vi.advanceTimersByTimeAsync(LEAD_NUDGE_BATCH_MS);

		expect(sent).toHaveLength(1);
		const text = sent[0] ?? "";
		expect(text).toContain(
			`code-correctness-2: refused 14 times by Node1: "${TPS}"`,
		);
		expect(text).toContain("waiting since 2026-09-25T05:16:25Z");
		expect(text).toContain("still retrying");
		expect(text).toContain("nothing has been stopped");
		expect(text).toContain("stop them (`stop_agents`)");
		expect(text).toContain("do those tasks yourself");
		watch.dispose();
	});

	it("names an unreachable node and since when", async () => {
		const sent: string[] = [];
		const watch = watchFor("review-7", sent);
		watch.waiting({
			kind: "transport",
			where: "Node1",
			detail: "server restarted",
		});
		await vi.advanceTimersByTimeAsync(
			LEAD_NUDGE_AFTER_MS + LEAD_NUDGE_BATCH_MS,
		);
		expect(sent[0]).toContain(
			"review-7: Node1 unreachable since 2026-09-25T05:16:25Z (server restarted",
		);
		watch.dispose();
	});

	it("does not call a node that failed the batch unreachable", async () => {
		// Swarm 0926: bug-3650's "Invalid input batch." reached the lead as
		// "Node1 unreachable", and the lead stopped agents on a node that was
		// serving every other request.
		const sent: string[] = [];
		const watch = watchFor("brace-fix-02", sent);
		watch.waiting({
			kind: "transport",
			where: "Node1",
			detail: "it failed the batch this turn was in",
		});
		await vi.advanceTimersByTimeAsync(
			LEAD_NUDGE_AFTER_MS + LEAD_NUDGE_BATCH_MS,
		);
		expect(sent[0]).toContain(
			"brace-fix-02: Node1 answering, but failing its turns since 2026-09-25T05:16:25Z (it failed the batch this turn was in",
		);
		expect(sent[0]).not.toContain("unreachable");
		watch.dispose();
	});

	it("puts agents that cross the line together in one report", async () => {
		const sent: string[] = [];
		const a = watchFor("a", sent);
		const b = watchFor("b", sent);
		a.waiting({ kind: "refusal", where: "Node1", detail: TPS });
		await vi.advanceTimersByTimeAsync(10_000);
		b.waiting({ kind: "refusal", where: "Node1", detail: TPS });
		await vi.advanceTimersByTimeAsync(
			LEAD_NUDGE_AFTER_MS + LEAD_NUDGE_BATCH_MS,
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("2 agents have been waiting");
		expect(sent[0]).toContain("- a:");
		expect(sent[0]).toContain("- b:");
		a.dispose();
		b.dispose();
	});

	it("tells the lead about an agent once, however long it goes on", async () => {
		const sent: string[] = [];
		const watch = watchFor("once", sent);
		for (let i = 0; i < 60; i += 1) {
			watch.waiting({ kind: "refusal", where: "Node1", detail: TPS });
			await vi.advanceTimersByTimeAsync(60_000);
		}
		// Out of it and back in: still once.
		watch.progressed();
		watch.waiting({ kind: "refusal", where: "Node1", detail: TPS });
		await vi.advanceTimersByTimeAsync(2 * LEAD_NUDGE_AFTER_MS);
		expect(sent).toHaveLength(1);
		watch.dispose();
	});

	it("starts over when the agent makes progress", async () => {
		const sent: string[] = [];
		const watch = watchFor("flaky", sent);
		watch.waiting({ kind: "refusal", where: "Node1", detail: TPS });
		await vi.advanceTimersByTimeAsync(LEAD_NUDGE_AFTER_MS - 60_000);
		watch.progressed();
		watch.waiting({ kind: "refusal", where: "Node1", detail: TPS });
		await vi.advanceTimersByTimeAsync(LEAD_NUDGE_AFTER_MS - 60_000);
		expect(sent).toEqual([]);
		watch.dispose();
	});

	it("reaches the lead through the session's listener", () => {
		const heard: string[] = [];
		const stop = onLeadNudge("lead-x", (text) => heard.push(text));
		expect(sendLeadNudge("lead-x", "status")).toBe(true);
		stop();
		expect(sendLeadNudge("lead-x", "status")).toBe(false);
		expect(heard).toEqual(["status"]);
	});

	it("reads the engine fetch's own waits", () => {
		expect(
			roomWaitTrouble("Waiting for the server to come back (it answered 503)")
				.kind,
		).toBe("transport");
		expect(roomWaitTrouble("Waiting for room on the server").kind).toBe(
			"refusal",
		);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createAgentTroubleWatch,
	LEAD_NUDGE_AFTER_MS,
	LEAD_NUDGE_BATCH_MS,
	NO_NODE_AFTER_MS,
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
		expect(text).toMatch(/^\[SYSTEM MESSAGE\] /);
		expect(text).toContain(
			`code-correctness-2: queued by Node1, 14 retries: "pool 5 admission queued: projected mean tps below floor" (`,
		);
		expect(text).toContain("still retrying");
		expect(text).toContain("nothing stopped");
		// Swarm ra0as: "refused 13x ... rejected" read as a broken node.
		expect(text).not.toMatch(/refus|reject/i);
		// wlafh: a queued agent is paced, not broken, and stopping it throws
		// its work away. Taking the tasks back is not offered for a queue.
		expect(text).toContain("queued, not broken");
		expect(text).not.toContain("do their tasks yourself");
		watch.dispose();
	});

	it("offers to take the tasks back only when a server is gone", async () => {
		const sent: string[] = [];
		const gone = watchFor("review-1", sent);
		const queued = watchFor("review-2", sent);
		gone.waiting({
			kind: "transport",
			where: "the server",
			detail: "not answering",
		});
		queued.waiting({ kind: "refusal", where: "Node1", detail: TPS });
		await vi.advanceTimersByTimeAsync(
			LEAD_NUDGE_AFTER_MS + LEAD_NUDGE_BATCH_MS,
		);

		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("stop_agents and do their tasks yourself");
		expect(sent[0]).toContain("The queued ones are placed");
		gone.dispose();
		queued.dispose();
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
			"review-7: Node1 unreachable (server restarted, ",
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
			"brace-fix-02: Node1 answers, its turns fail (it failed the batch this turn was in",
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
		expect(sent[0]).toContain("2 agents waiting");
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

/**
 * Pandorum's wlafh run: the server died, ten agents waited for it for six
 * hours and the lead sat in `await_agents` after its one ten-minute report.
 * The user's ruling: an agent with nowhere to run for two hours is a second
 * report, asking the lead to ask the user or to do the work itself when that
 * fits the request.
 */
describe("telling the lead again when agents have had no node for two hours", () => {
	it("asks the lead to ask the user or do the work itself", async () => {
		const sent: string[] = [];
		const watch = watchFor("gamelogic-2", sent);
		watch.waiting({
			kind: "transport",
			where: "the server",
			detail: "not answering",
		});
		await vi.advanceTimersByTimeAsync(NO_NODE_AFTER_MS - 60_000);
		expect(sent).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(60_000 + LEAD_NUDGE_BATCH_MS);

		expect(sent).toHaveLength(2);
		const text = sent[1] ?? "";
		expect(text).toMatch(/^\[SYSTEM MESSAGE\] 1 agent with no node/);
		expect(text).toContain(">120 min");
		expect(text).toContain("- gamelogic-2: the server unreachable");
		expect(text).toContain("ask_question");
		expect(text).toContain("stop_agents");
		expect(text).toContain("only if that fits what the user asked");
		watch.dispose();
	});

	it("puts every agent that crossed two hours into one report", async () => {
		const sent: string[] = [];
		const first = watchFor("syntax-2", sent);
		const second = watchFor("braces-1", sent);
		first.waiting({ kind: "refusal", where: "Node1", detail: TPS });
		second.waiting({
			kind: "transport",
			where: "the server",
			detail: "not answering",
		});
		await vi.advanceTimersByTimeAsync(NO_NODE_AFTER_MS + LEAD_NUDGE_BATCH_MS);

		expect(sent).toHaveLength(2);
		expect(sent[1]).toMatch(/^\[SYSTEM MESSAGE\] 2 agents with no node/);
		expect(sent[1]).toContain("- syntax-2:");
		expect(sent[1]).toContain("- braces-1:");
		first.dispose();
		second.dispose();
	});

	it("reports the agents left when the first one to cross ten minutes has ended", async () => {
		const sent: string[] = [];
		const first = watchFor("syntax-2", sent);
		const second = watchFor("braces-1", sent);
		const down = {
			kind: "transport" as const,
			where: "the server",
			detail: "not answering",
		};
		first.waiting(down);
		second.waiting(down);
		await vi.advanceTimersByTimeAsync(
			LEAD_NUDGE_AFTER_MS + LEAD_NUDGE_BATCH_MS,
		);
		first.dispose();
		await vi.advanceTimersByTimeAsync(NO_NODE_AFTER_MS);

		expect(sent).toHaveLength(2);
		expect(sent[1]).toMatch(/^\[SYSTEM MESSAGE\] 1 agent with no node/);
		expect(sent[1]).toContain("- braces-1:");
		second.dispose();
	});

	it("says nothing more when the agent got a turn through in between", async () => {
		const sent: string[] = [];
		const watch = watchFor("htmldom-1", sent);
		watch.waiting({ kind: "refusal", where: "Node1", detail: TPS });
		await vi.advanceTimersByTimeAsync(NO_NODE_AFTER_MS - 60_000);
		watch.progressed();
		watch.waiting({ kind: "refusal", where: "Node1", detail: TPS });
		await vi.advanceTimersByTimeAsync(NO_NODE_AFTER_MS - 60_000);

		expect(sent).toHaveLength(1);
		watch.dispose();
	});

	it("still reports two hours without a node for an agent already reported at ten minutes of an earlier wait", async () => {
		const sent: string[] = [];
		const watch = watchFor("correctness-3", sent);
		watch.waiting({ kind: "refusal", where: "Node1", detail: TPS });
		await vi.advanceTimersByTimeAsync(
			LEAD_NUDGE_AFTER_MS + LEAD_NUDGE_BATCH_MS,
		);
		watch.progressed();
		expect(sent).toHaveLength(1);

		watch.waiting({
			kind: "transport",
			where: "the server",
			detail: "not answering",
		});
		await vi.advanceTimersByTimeAsync(NO_NODE_AFTER_MS + LEAD_NUDGE_BATCH_MS);

		expect(sent).toHaveLength(2);
		expect(sent[1]).toContain("with no node");
		watch.dispose();
	});

	it("reports it once per agent", async () => {
		const sent: string[] = [];
		const watch = watchFor("syntax-1", sent);
		watch.waiting({
			kind: "transport",
			where: "the server",
			detail: "not answering",
		});
		await vi.advanceTimersByTimeAsync(3 * NO_NODE_AFTER_MS);

		expect(sent).toHaveLength(2);
		watch.dispose();
	});
});

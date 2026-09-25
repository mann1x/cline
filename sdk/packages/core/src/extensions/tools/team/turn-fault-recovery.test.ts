import type { TurnFault } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import {
	createTurnFaultRecovery,
	REFUSAL_BACKOFF_MAX_MS,
	refusalBackoffMs,
} from "./turn-fault-recovery";

const fault = (overrides: Partial<TurnFault> = {}): TurnFault => ({
	kind: "transport",
	message: "server is shutting down",
	attempt: 1,
	iteration: 3,
	...overrides,
});

describe("waiting out a turn the server dropped", () => {
	it("waits for the node's /health, says so on the row, and sends the turn again", async () => {
		const probes: string[] = [];
		let answers = 0;
		const updates: Array<{ latestOutput?: string }> = [];
		const unreachable = vi.fn();
		const recover = createTurnFaultRecovery({
			label: "reviewer-1",
			where: () => "Node1",
			baseUrl: () => "http://192.168.178.2:8241/v1",
			emitUpdate: (update) => updates.push(update as never),
			onTransportFault: unreachable,
			probe: async (root) => {
				probes.push(root);
				return ++answers > 2;
			},
			sleep: async () => {},
		});

		expect(await recover(fault())).toBe(true);

		expect(probes).toEqual([
			"http://192.168.178.2:8241",
			"http://192.168.178.2:8241",
			"http://192.168.178.2:8241",
		]);
		expect(unreachable).toHaveBeenCalledTimes(1);
		expect(updates[0]?.latestOutput).toContain(
			"Waiting for Node1 to come back (server restarted)",
		);
	});

	it("declines before the engine admitted a placed agent, so the queue re-places it", async () => {
		const probe = vi.fn(async () => true);
		const recover = createTurnFaultRecovery({
			label: "a",
			isAdmitted: () => false,
			baseUrl: () => "http://h:1/v1",
			probe,
		});

		expect(await recover(fault())).toBe(false);
		expect(probe).not.toHaveBeenCalled();
	});

	it("backs off on a provider with no address to ask", async () => {
		const waits: number[] = [];
		const recover = createTurnFaultRecovery({
			label: "a",
			sleep: async (ms) => {
				waits.push(ms);
			},
		});

		expect(await recover(fault({ message: "fetch failed", attempt: 3 }))).toBe(
			true,
		);
		expect(waits).toEqual([refusalBackoffMs(3)]);
	});

	it("stops at once when the user stops the agent", async () => {
		const controller = new AbortController();
		const recover = createTurnFaultRecovery({
			label: "a",
			baseUrl: () => "http://h:1/v1",
			signal: controller.signal,
			probe: async () => {
				controller.abort();
				return false;
			},
		});

		expect(await recover(fault())).toBe(false);
	});
});

describe("waiting out a refused turn", () => {
	it("backs off, growing to a minute between attempts and never past it", async () => {
		expect(
			[1, 2, 3, 4, 5, 6, 7, 40].map((attempt) => refusalBackoffMs(attempt)),
		).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
		expect(REFUSAL_BACKOFF_MAX_MS).toBe(60_000);
	});

	it("names the refusal on the row and sends the turn again", async () => {
		const updates: Array<{
			latestOutput?: string;
			activity?: { severity?: string };
		}> = [];
		const waits: number[] = [];
		const recover = createTurnFaultRecovery({
			label: "a",
			where: () => "Node1",
			emitUpdate: (update) => updates.push(update as never),
			sleep: async (ms) => {
				waits.push(ms);
			},
		});

		expect(
			await recover(
				fault({
					kind: "refusal",
					message: "pool 5 admission rejected: projected mean tps below floor",
					attempt: 2,
				}),
			),
		).toBe(true);
		expect(waits).toEqual([4_000]);
		expect(updates[0]?.latestOutput).toContain(
			"Node1 refused the turn (pool 5 admission rejected: projected mean tps below floor)",
		);
		// A refusal is the engine pacing its load: never a warning.
		expect(updates[0]?.activity?.severity).not.toBe("warn");
	});
});

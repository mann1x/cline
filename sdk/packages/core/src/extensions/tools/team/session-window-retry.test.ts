import { describe, expect, it, vi } from "vitest";
import {
	isSessionAllocationFull,
	retryWhileSessionFull,
} from "./session-window-retry";

/** The engine's own words, from a live refusal on 8240. */
const REFUSAL =
	"admission rejected: session allocation full (worker of '1790075513269_ndhxh': 39653 of 65536 cells free, needs 40252) — compact the session (base 969004 free of 1048576 cells, needs 0; swa 126976 free of 131072 cells, needs 1024; largest window admissible now 262144)";

describe("a worker refused because the lead's window is full", () => {
	it("recognises the engine's refusal", () => {
		expect(isSessionAllocationFull(new Error(REFUSAL))).toBe(true);
		expect(isSessionAllocationFull(REFUSAL)).toBe(true);
	});

	// Every other failure is the worker's own and must travel untouched --
	// retrying a bad tool call three times is three times the cost and the
	// same answer.
	it("is not any other failure", () => {
		expect(isSessionAllocationFull(new Error("429 rate limited"))).toBe(false);
		expect(isSessionAllocationFull(new Error("ECONNREFUSED"))).toBe(false);
		expect(isSessionAllocationFull(undefined)).toBe(false);
	});

	it("waits and runs again, because a worker finishing is what frees the room", async () => {
		const sleep = vi.fn(async (_ms: number) => {});
		let attempts = 0;
		const result = await retryWhileSessionFull(
			async () => {
				attempts += 1;
				if (attempts < 3) {
					throw new Error(REFUSAL);
				}
				return "done";
			},
			{ attempts: 4, sleep },
		);

		expect(result).toBe("done");
		expect(attempts).toBe(3);
		// Backing off rather than spinning: the room appears when another
		// worker finishes, which is seconds away, not microseconds.
		expect(sleep.mock.calls.map((call) => call[0])).toEqual([2000, 4000]);
	});

	it("gives up with the engine's own message, which names what to do", async () => {
		const sleep = vi.fn(async (_ms: number) => {});
		await expect(
			retryWhileSessionFull(
				async () => {
					throw new Error(REFUSAL);
				},
				{ attempts: 2, sleep },
			),
		).rejects.toThrow(/session allocation full/);
		expect(sleep).toHaveBeenCalledTimes(1);
	});

	it("runs once and returns when nothing is refused", async () => {
		const run = vi.fn(async () => 7);
		expect(await retryWhileSessionFull(run, { sleep: async () => {} })).toBe(7);
		expect(run).toHaveBeenCalledTimes(1);
	});
});

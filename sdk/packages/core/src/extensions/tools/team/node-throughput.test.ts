import { afterEach, describe, expect, it } from "vitest";
import {
	__resetNodeThroughput,
	nodeKeyOf,
	nodeRate,
	noteNodeTokens,
} from "./node-throughput";

afterEach(() => {
	__resetNodeThroughput();
});

const T0 = Date.parse("2026-09-27T10:00:00Z");
const minute = 60_000;

describe("a node's throughput", () => {
	it("is too early to trust over a couple of minutes", () => {
		noteNodeTokens("n", 600, T0);
		noteNodeTokens("n", 600, T0 + minute);
		expect(nodeRate("n", T0 + 2 * minute)?.reliability).toBe("too early");
	});

	it("is reliable when the last five minutes match its history", () => {
		for (let i = 0; i < 20; i++) {
			noteNodeTokens("n", 1_200, T0 + i * minute);
		}
		const rate = nodeRate("n", T0 + 20 * minute);
		expect(rate?.recentTps).toBe(20);
		expect(rate?.historicalTps).toBe(20);
		expect(rate?.activeMinutes).toBe(20);
		expect(rate?.reliability).toBe("high");
	});

	// A compaction wave: the node goes quiet, and its history says it should not be.
	it("says an ETA is unreliable when the recent rate has fallen far from its history", () => {
		for (let i = 0; i < 15; i++) {
			noteNodeTokens("n", 1_200, T0 + i * minute);
		}
		for (let i = 15; i < 20; i++) {
			noteNodeTokens("n", 60, T0 + i * minute);
		}
		expect(nodeRate("n", T0 + 20 * minute)?.reliability).toBe("low");
	});

	it("does not count idle minutes between rounds as history", () => {
		noteNodeTokens("n", 1_200, T0);
		noteNodeTokens("n", 1_200, T0 + 120 * minute);
		expect(nodeRate("n", T0 + 121 * minute)?.historicalTps).toBe(20);
	});

	it("keys an agent by its node, else by its model", () => {
		expect(nodeKeyOf({ nodeId: "node-a", providerId: "p" })).toBe("node-a");
		expect(nodeKeyOf({ providerId: "p", modelId: "m" })).toBe("p/m");
	});
});

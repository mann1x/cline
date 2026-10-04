import { describe, expect, it } from "vitest";
import { onPolykvPoolShare, reportPolykvPoolShare } from "./polykv-swarm";

describe("pool share reports", () => {
	it("reach the session's listener and nobody else's", () => {
		const mine: number[] = [];
		const other: number[] = [];
		const stop = onPolykvPoolShare("lead~agent-1", (n) => mine.push(n));
		const stopOther = onPolykvPoolShare("lead~agent-2", (n) => other.push(n));
		reportPolykvPoolShare("lead~agent-1", 5627);
		reportPolykvPoolShare("lead~agent-1", 0);
		expect(mine).toEqual([5627]);
		expect(other).toEqual([]);
		stop();
		reportPolykvPoolShare("lead~agent-1", 5627);
		expect(mine).toEqual([5627]);
		stopOther();
	});
});

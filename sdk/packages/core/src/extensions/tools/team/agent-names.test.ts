import { describe, expect, it } from "vitest";
import { describeRenamedAgents, uniqueAgentNames } from "./agent-names";

describe("uniqueAgentNames", () => {
	it("numbers a name used more than once, in the order given", () => {
		expect(uniqueAgentNames(["review", "fix", "review", "review"])).toEqual({
			names: ["review-1", "fix", "review-2", "review-3"],
			renamed: [{ from: "review", to: ["review-1", "review-2", "review-3"] }],
		});
	});

	it("leaves names used once alone and skips a number already taken", () => {
		expect(uniqueAgentNames(["a", "a-1", "a"]).names).toEqual([
			"a-2",
			"a-1",
			"a-3",
		]);
		expect(uniqueAgentNames(["x", "y"])).toEqual({
			names: ["x", "y"],
			renamed: [],
		});
	});

	it("tells the lead what was renamed, and nothing when nothing was", () => {
		const { renamed } = uniqueAgentNames(["r", "r"]);
		expect(describeRenamedAgents(renamed)).toContain('"r" x2 -> r-1 ... r-2');
		expect(describeRenamedAgents([])).toBeUndefined();
	});
});

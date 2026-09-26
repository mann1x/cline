import { describe, expect, it } from "vitest"
import { subagentCapText, subagentOracleText, subagentOracleTitle } from "./subagentControls"

describe("the iteration cap on a sub-agent's row", () => {
	it("says it is waiting for the lead, and at what cap", () => {
		expect(subagentCapText({ awaitingLead: { iterations: 4, maxIterations: 4 }, maxIterations: 4 })).toEqual({
			text: "awaiting lead (iteration cap 4)",
			warn: true,
		})
	})

	it("says the cap ended it, once the lead stopped it there", () => {
		expect(subagentCapText({ stopReason: "iteration_cap", maxIterations: 6 })).toEqual({
			text: "stopped at iteration cap 6",
			warn: true,
		})
	})

	it("says it was looping when the loop guard stopped it, waiting or ended there", () => {
		expect(
			subagentCapText({ awaitingLead: { iterations: 12, maxIterations: 30, reason: "looping" }, maxIterations: 30 }),
		).toEqual({ text: "looping: stopped by the loop guard, awaiting lead", warn: true })
		expect(subagentCapText({ stopReason: "loop_guard" })).toEqual({
			text: "stopped by the loop guard (looping)",
			warn: true,
		})
	})

	it("says nothing for an agent the cap never touched", () => {
		expect(subagentCapText({ maxIterations: 10 })).toBeUndefined()
		expect(subagentCapText({})).toBeUndefined()
	})
})

describe("the lead's check on a sub-agent's row", () => {
	it("states a pass, a fail with its exit code, and a check never run", () => {
		expect(subagentOracleText({ status: "pass", exitCode: 0, output: "ok" })).toBe("check: pass")
		expect(subagentOracleText({ status: "fail", exitCode: 1, output: "TypeError" })).toBe("check: FAIL (exit 1)")
		expect(subagentOracleText({ status: "fail", exitCode: null, output: "" })).toBe("check: FAIL (did not run to an exit)")
		expect(subagentOracleText({ status: "not_run", exitCode: null, output: "", reason: "no command sandbox" })).toBe(
			"check: not run (no command sandbox)",
		)
		expect(subagentOracleText(undefined)).toBeUndefined()
	})

	it("puts the command, the pattern and the output's end in the tooltip", () => {
		const title = subagentOracleTitle({
			status: "fail",
			command: "node t.js",
			expect: "ok",
			must: "not_match",
			exitCode: 1,
			output: "TypeError: x",
			runs: 2,
		})
		expect(title).toContain("node t.js")
		expect(title).toContain("must not match /ok/")
		expect(title).toContain("TypeError: x")
		expect(title).toContain("2 runs")
	})
})

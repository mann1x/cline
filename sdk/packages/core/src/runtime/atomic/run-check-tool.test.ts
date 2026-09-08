import { describe, expect, it } from "vitest";
import type { Oracle, OracleVerdict } from "./oracle";
import {
	createRunCheckTool,
	MAX_CHECKS_PER_TRANSACTION,
} from "./run-check-tool";

const oracle = {
	label: "run the game",
	reason: "asked for",
} as unknown as Oracle;

function controller(
	verdict: OracleVerdict,
	options: { oracle?: Oracle; transaction?: number } = {},
) {
	let runs = 0;
	const state = {
		oracle: "oracle" in options ? options.oracle : oracle,
		transaction: options.transaction ?? 1,
		runCheck: async () => {
			runs += 1;
			return verdict;
		},
		get runs() {
			return runs;
		},
	};
	return state;
}

const passing = { passed: true, output: "ok" } as OracleVerdict;
const failing = {
	passed: false,
	output: "SyntaxError: Unexpected token '{'",
} as OracleVerdict;

describe("run_check", () => {
	it("gives the failure back in the check's own words", async () => {
		const tool = createRunCheckTool({ controller: controller(failing) });

		const said = String(await tool.execute?.({}, {} as never));
		expect(said).toContain("The check failed");
		expect(said).toContain("SyntaxError: Unexpected token '{'");
		// The point of the whole tool: it is information, not a verdict.
		expect(said).toContain("Nothing was rolled back");
	});

	it("does not let a pass read as the run being over", async () => {
		const tool = createRunCheckTool({ controller: controller(passing) });

		expect(String(await tool.execute?.({}, {} as never))).toContain(
			"run once more when you do",
		);
	});

	it("says there is no check, and where one could come from", async () => {
		const withProposal = createRunCheckTool({
			controller: controller(passing, { oracle: undefined }),
			canProposeCheck: true,
		});
		const without = createRunCheckTool({
			controller: controller(passing, { oracle: undefined }),
		});

		expect(String(await withProposal.execute?.({}, {} as never))).toContain(
			"propose_check",
		);
		expect(String(await without.execute?.({}, {} as never))).toContain(
			"no check to run",
		);
	});

	it("stops a model that checks instead of editing, per transaction", async () => {
		const state = controller(failing);
		const tool = createRunCheckTool({ controller: state });

		for (let i = 0; i < MAX_CHECKS_PER_TRANSACTION; i += 1) {
			expect(String(await tool.execute?.({}, {} as never))).toContain(
				"The check failed",
			);
		}
		expect(String(await tool.execute?.({}, {} as never))).toContain(
			"will not tell you anything",
		);
		expect(state.runs).toBe(MAX_CHECKS_PER_TRANSACTION);

		// A discarded transaction has to be able to see the failure it died on,
		// so the count starts again with the next one.
		state.transaction = 2;
		expect(String(await tool.execute?.({}, {} as never))).toContain(
			"The check failed",
		);
	});

	it("does not end the run when the check itself cannot run", async () => {
		const tool = createRunCheckTool({
			controller: {
				oracle,
				transaction: 1,
				runCheck: async () => {
					throw new Error("spawn ENOENT");
				},
			},
		});

		const said = String(await tool.execute?.({}, {} as never));
		expect(said).toContain("could not be run");
		expect(said).toContain("not a reason to stop");
	});
});

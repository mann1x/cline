import { describe, expect, it, vi } from "vitest";
import {
	createEscalateTool,
	ESCALATE_TOOL_DESCRIPTION,
	ESCALATE_TOOL_NAME,
	type EscalationRequest,
} from "./escalate-tool";

function toolWith(
	consult: (request: EscalationRequest) => Promise<{
		reply: string;
		opened: boolean;
		followUpsLeft: number;
		escalationsLeft: number;
		closed?: boolean;
	}>,
) {
	const tool = createEscalateTool({ consult });
	return {
		tool,
		call: (input: unknown) =>
			tool.execute(input, {} as never) as Promise<string>,
	};
}

describe("createEscalateTool", () => {
	// The cost is the only reason this tool needs a description longer than a
	// line. A model that reads `escalate` as "ask for help" will call it on its
	// first failed edit; one told the call is metered and rationed will not.
	it("says in its description that the expert costs more and the budget is finite", () => {
		expect(ESCALATE_TOOL_NAME).toBe("escalate");
		expect(ESCALATE_TOOL_DESCRIPTION).toMatch(/cost|expensive|metered|paid/i);
		// And the other half, which matters as much: an unused expert helps
		// nobody. The measured failure this feature addresses is a model looping
		// until a guard stops it, not a model asking for help too often.
		expect(ESCALATE_TOOL_DESCRIPTION).toMatch(
			/not.*(too )?(conservative|reluctant|hesitate)|do not hesitate|is there to help/i,
		);
	});

	it("hands the goal, the standard and the files to the expert", async () => {
		const consult = vi.fn(async () => ({
			reply: "changed step() to clamp the row index",
			opened: true,
			followUpsLeft: 20,
			escalationsLeft: 2,
		}));
		const { call } = toolWith(consult);

		const result = await call({
			goal: "make the collision check pass",
			expectation: "run_game.js prints ok:true",
			files: ["src/game.js"],
		});

		expect(consult).toHaveBeenCalledWith(
			expect.objectContaining({
				goal: "make the collision check pass",
				expectation: "run_game.js prints ok:true",
				files: ["src/game.js"],
			}),
		);
		expect(result).toContain("changed step() to clamp the row index");
	});

	// The reply is a delivery, not a verdict. The model that escalated is the
	// one still accountable for the task, and a delivery it accepts untested is
	// a transaction it loses later with nothing learned.
	it("tells the model to check the delivery and how much conversation is left", async () => {
		const { call } = toolWith(async () => ({
			reply: "done",
			opened: true,
			followUpsLeft: 19,
			escalationsLeft: 2,
		}));

		const result = await call({ goal: "fix it" });

		expect(result).toMatch(/check|verify|run/i);
		expect(result).toContain("19");
	});

	// Small models put their text in whichever field they remember. Refusing the
	// call over the field name spends a turn teaching schema rather than getting
	// the help, and this tool is reached by a model that is already stuck.
	it("opens an escalation from `message` alone, treating it as the goal", async () => {
		const consult = vi.fn(async () => ({
			reply: "ok",
			opened: true,
			followUpsLeft: 20,
			escalationsLeft: 2,
		}));
		const { call } = toolWith(consult);

		await call({ message: "the board never re-renders after a clear" });

		expect(consult).toHaveBeenCalledWith(
			expect.objectContaining({
				goal: "the board never re-renders after a clear",
			}),
		);
	});

	// Nothing usable at all is different: there is no text to hand over, and
	// opening an escalation on an empty brief spends one of three on a question
	// the expert cannot answer.
	it("refuses an empty call without spending anything", async () => {
		const consult = vi.fn(async () => ({
			reply: "ok",
			opened: true,
			followUpsLeft: 20,
			escalationsLeft: 2,
		}));
		const { call } = toolWith(consult);

		const result = await call({});

		expect(consult).not.toHaveBeenCalled();
		expect(result).toMatch(/goal/i);
	});

	// Ending it is the model's call, and it has to be a call rather than an
	// inference: an exchange nobody closed holds a local server's slot for the
	// rest of the task.
	it("passes the model's decision to end the exchange through", async () => {
		const consult = vi.fn(async () => ({
			reply: "acknowledged",
			opened: false,
			followUpsLeft: 18,
			escalationsLeft: 2,
			closed: true,
		}));
		const { call } = toolWith(consult);

		const result = await call({
			message: "that worked, thank you",
			finished: true,
		});

		expect(consult).toHaveBeenCalledWith(
			expect.objectContaining({ finished: true }),
		);
		expect(result).toMatch(/closed|ended|over/i);
	});

	// A refused escalation is a normal state, not a tool failure. The model has
	// to be able to read why and carry on -- and what it must do instead, or it
	// will spend its remaining turns rewording the same call.
	it("returns a refusal as a result the model can act on", async () => {
		const { call } = toolWith(async () => {
			throw new Error(
				"This task has already escalated 3 times, which is the limit.",
			);
		});

		const result = await call({ goal: "fix it" });

		expect(result).toContain("which is the limit");
		expect(result).toMatch(/yourself|on your own|without/i);
	});
});

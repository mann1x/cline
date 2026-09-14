import { describe, expect, it } from "vitest";
import {
	createWaitForExpertTool,
	WAIT_FOR_EXPERT_TOOL_DESCRIPTION,
} from "./watch-tool";

const context = {} as never;

async function run(tool: { execute?: (i: never, c: never) => unknown }) {
	return (await tool.execute?.({} as never, context)) as string;
}

describe("wait_for_expert", () => {
	it("returns what the session collected", async () => {
		const tool = createWaitForExpertTool({
			collect: async () => ({
				kind: "batch",
				text: "the expert edited a.html",
			}),
		});

		expect(await run(tool)).toBe("the expert edited a.html");
	});

	it("turns a failure into something the model can act on", async () => {
		// A stuck base model that gets a thrown tool call stops. It has to be
		// told the task is still its own.
		const tool = createWaitForExpertTool({
			collect: async () => {
				throw new Error("the connection dropped");
			},
		});

		const answer = await run(tool);

		expect(answer).toContain("the connection dropped");
		expect(answer).toContain("The task is yours");
	});

	it("tells the model what to do when it sees circling", () => {
		expect(WAIT_FOR_EXPERT_TOOL_DESCRIPTION).toContain("circles");
		expect(WAIT_FOR_EXPERT_TOOL_DESCRIPTION).toContain("tell it to stop");
	});
});

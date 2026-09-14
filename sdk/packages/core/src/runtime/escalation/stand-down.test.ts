import { describe, expect, it } from "vitest";
import {
	createStandDown,
	STAND_DOWN_NOTICE,
	withStandDown,
} from "./stand-down";

const context = {} as never;

function tool(name: string, result = "ran") {
	return {
		name,
		description: `the ${name} tool`,
		inputSchema: { type: "object", properties: {} },
		execute: async () => result,
	};
}

async function run(t: { execute?: (i: never, c: never) => unknown }) {
	return (await t.execute?.({} as never, context)) as string;
}

describe("standing down while the expert works", () => {
	it("is off until an escalation engages it", async () => {
		const standDown = createStandDown();
		const [editor] = withStandDown([tool("editor")], standDown);

		expect(standDown.engaged).toBe(false);
		expect(await run(editor)).toBe("ran");
	});

	it("refuses every tool that writes, and says why", async () => {
		const standDown = createStandDown();
		const tools = withStandDown(
			[tool("editor"), tool("apply_patch"), tool("sed"), tool("restore_file")],
			standDown,
		);
		standDown.engage();

		for (const one of tools) {
			const answer = await run(one);
			expect(answer).toContain("standing down");
			expect(answer).not.toBe("ran");
		}
	});

	it("leaves the reads and the checks alone", async () => {
		const standDown = createStandDown();
		const tools = withStandDown(
			[
				tool("read_files"),
				tool("check_file"),
				tool("run_check"),
				tool("grep"),
				tool("search_codebase"),
			],
			standDown,
		);
		standDown.engage();

		for (const one of tools) {
			expect(await run(one)).toBe("ran");
		}
	});

	it("warns on a command rather than refusing it", async () => {
		// Running is allowed -- the base is supposed to be checking the expert's
		// work -- and a command that writes is the one the model must not make.
		const standDown = createStandDown();
		const [commands] = withStandDown([tool("run_commands")], standDown);
		standDown.engage();

		const answer = await run(commands);

		expect(answer).toContain("ran");
		expect(answer).toContain("did not change");
	});

	it("refuses to close somebody else's transaction", async () => {
		const standDown = createStandDown();
		const [submit] = withStandDown([tool("submit_transaction")], standDown);
		standDown.engage();

		expect(await run(submit)).toContain("standing down");
	});

	it("lets go when the escalation ends", async () => {
		const standDown = createStandDown();
		const [editor] = withStandDown([tool("editor")], standDown);
		standDown.engage();
		standDown.release();

		expect(standDown.engaged).toBe(false);
		expect(await run(editor)).toBe("ran");
	});

	it("tells the model to spot-check rather than audit", () => {
		// The batches name every call the expert made. A model told to verify
		// all of them spends the escalation reading, which is the turn economy
		// the batching exists to protect.
		expect(STAND_DOWN_NOTICE).toContain("spot");
		expect(STAND_DOWN_NOTICE).not.toContain("every tool call");
	});
});

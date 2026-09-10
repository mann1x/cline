import type { AgentToolDefinition } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { withCheckFirstEdits } from "./check-first-edits";
import { RUN_CHECK_TOOL_NAME } from "./run-check-tool";

function tools(calls: string[]): AgentToolDefinition[] {
	const make = (name: string) =>
		({
			name,
			description: name,
			inputSchema: { type: "object", properties: {} },
			execute: async () => {
				calls.push(name);
				return `${name} ran`;
			},
		}) as unknown as AgentToolDefinition;
	return [
		make("editor"),
		make("apply_patch"),
		make(RUN_CHECK_TOOL_NAME),
		make("read_files"),
	];
}

function wrap(calls: string[], source: { transaction: number }) {
	return new Map(
		withCheckFirstEdits(tools(calls), {
			get transaction() {
				return source.transaction;
			},
			checkLabel: "node run_game.js manic_miner.html",
		}).map((tool) => [tool.name, tool]),
	);
}

const run = (t: Map<string, AgentToolDefinition>, name: string) =>
	(
		t.get(name) as never as {
			execute: (i: unknown, c: unknown) => Promise<unknown>;
		}
	).execute({}, {});

describe("withCheckFirstEdits", () => {
	it("holds the first edit and says the edit did not happen", async () => {
		const calls: string[] = [];
		const t = wrap(calls, { transaction: 1 });

		const held = (await run(t, "editor")) as string;

		expect(calls).toEqual([]);
		expect(held).toContain("That edit was not made");
		expect(held).toContain(RUN_CHECK_TOOL_NAME);
		expect(held).toContain("node run_game.js manic_miner.html");
		// The other half of what the same session skipped.
		expect(held).toContain("WHERE, WHAT and WHY");
	});

	// The gate is a nudge, not a rule: it refuses one edit and then gets out of
	// the way, so a model that disagrees still gets its transaction.
	it("lets the next edit through even if the check was never run", async () => {
		const calls: string[] = [];
		const t = wrap(calls, { transaction: 1 });

		await run(t, "editor");
		await run(t, "editor");
		await run(t, "apply_patch");

		expect(calls).toEqual(["editor", "apply_patch"]);
	});

	// TX-03 and TX-05 of the measured session opened on the check. Neither
	// should ever have seen this.
	it("never fires for a model that runs the check first", async () => {
		const calls: string[] = [];
		const t = wrap(calls, { transaction: 1 });

		await run(t, RUN_CHECK_TOOL_NAME);
		await run(t, "editor");

		expect(calls).toEqual([RUN_CHECK_TOOL_NAME, "editor"]);
	});

	// A check that threw still showed the model the program's own answer.
	// Holding the edit after that would punish the model for complying.
	it("counts a check that failed as having been run", async () => {
		const calls: string[] = [];
		const wrapped = new Map(
			withCheckFirstEdits(
				[
					{
						name: RUN_CHECK_TOOL_NAME,
						description: "check",
						inputSchema: { type: "object", properties: {} },
						execute: async () => {
							throw new Error("check blew up");
						},
					} as unknown as AgentToolDefinition,
					...tools(calls).filter((t) => t.name === "editor"),
				],
				{ transaction: 1, checkLabel: "the check" },
			).map((tool) => [tool.name, tool]),
		);

		await expect(run(wrapped, RUN_CHECK_TOOL_NAME)).rejects.toThrow(
			"check blew up",
		);
		await run(wrapped, "editor");

		expect(calls).toEqual(["editor"]);
	});

	it("arms again for the next transaction", async () => {
		const calls: string[] = [];
		const source = { transaction: 1 };
		const t = wrap(calls, source);

		await run(t, RUN_CHECK_TOOL_NAME);
		await run(t, "editor");
		expect(calls).toEqual([RUN_CHECK_TOOL_NAME, "editor"]);

		source.transaction = 2;
		const held = (await run(t, "editor")) as string;

		expect(held).toContain("That edit was not made");
		expect(calls).toEqual([RUN_CHECK_TOOL_NAME, "editor"]);
	});

	it("leaves tools that are not edits alone", async () => {
		const calls: string[] = [];
		const t = wrap(calls, { transaction: 1 });

		await run(t, "read_files");

		expect(calls).toEqual(["read_files"]);
	});
});

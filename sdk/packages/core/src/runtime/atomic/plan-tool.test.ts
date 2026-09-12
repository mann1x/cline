import { describe, expect, it } from "vitest";
import {
	createPlanTool,
	MAX_DECLARATIONS_PER_TRANSACTION,
	PLAN_TOOL_NAME,
	type PlanItem,
} from "./plan-tool";

/** A controller whose transaction number the test moves by hand. */
function controller(maxChanges = 6) {
	return { transaction: 1, maxChanges };
}

const CONTEXT = {} as never;

function tool(
	source: ReturnType<typeof controller>,
	onPlan?: (items: readonly PlanItem[]) => void,
) {
	return createPlanTool({
		controller: source,
		maxChanges: source.maxChanges,
		onPlan,
	});
}

async function call(
	t: ReturnType<typeof tool>,
	input: Record<string, unknown>,
): Promise<string> {
	return (await t.execute(input as never, CONTEXT)) as string;
}

const THREE = [
	{ where: "line 90, dDec", what: "delete the extra }", why: "missing )" },
	{ where: "line 97", what: "delete the stray }", why: "Unexpected token {" },
	{ where: "line 111", what: "insert the closing }", why: "cascade" },
];

describe("plan tool", () => {
	it("is named so the protocol text can refer to it", () => {
		expect(PLAN_TOOL_NAME).toBe("plan");
	});

	it("numbers the items itself, so no count can disagree with the list", async () => {
		const t = tool(controller());
		const out = await call(t, { changes: THREE });
		expect(out).toContain("3 changes");
		expect(out).toContain("1. delete the extra }");
		expect(out).toContain("2. delete the stray }");
		expect(out).toContain("3. insert the closing }");
	});

	it("reads back the whole plan on a bare call", async () => {
		const t = tool(controller());
		await call(t, { changes: THREE });
		const out = await call(t, {});
		expect(out).toContain("delete the extra }");
		expect(out).toContain("insert the closing }");
	});

	it("says so when there is no plan yet", async () => {
		const out = await call(tool(controller()), {});
		expect(out).toContain("No plan stated yet");
	});

	it("marks an item landed and shows it in the tally", async () => {
		const t = tool(controller());
		await call(t, { changes: THREE });
		const out = await call(t, { done: 2, note: "applied cleanly" });
		expect(out).toContain("1 landed");
		expect(out).toContain("[x] 2.");
		expect(out).toContain("applied cleanly");
	});

	it("marks an item failed", async () => {
		const t = tool(controller());
		await call(t, { changes: THREE });
		const out = await call(t, { failed: 1, note: "check still reports it" });
		expect(out).toContain("1 failed");
		expect(out).toContain("[!] 1.");
	});

	it("refuses a number that is not in the plan", async () => {
		const t = tool(controller());
		await call(t, { changes: THREE });
		const out = await call(t, { done: 9 });
		expect(out).toContain("no item 9");
	});

	it("refuses more changes than the transaction allows", async () => {
		const t = tool(controller(2));
		const out = await call(t, { changes: THREE });
		expect(out).toContain("3 changes and this transaction allows 2");
	});

	it("refuses an entry missing one of the three fields", async () => {
		const t = tool(controller());
		const out = await call(t, {
			changes: [{ where: "line 90", what: "delete it" }],
		});
		expect(out).toContain("all three");
	});

	it("refuses an empty list", async () => {
		const out = await call(tool(controller()), { changes: [] });
		expect(out).toContain("not a plan");
	});

	it("stops the model restating the plan forever", async () => {
		const t = tool(controller());
		for (let i = 0; i < MAX_DECLARATIONS_PER_TRANSACTION; i += 1) {
			const out = await call(t, { changes: THREE });
			expect(out).not.toContain("Restating it is not progress");
		}
		const refused = await call(t, { changes: THREE });
		expect(refused).toContain("Restating it is not progress");
		// and it still hands the plan back rather than leaving the model blind
		expect(refused).toContain("delete the extra }");
	});

	describe("across a discarded transaction", () => {
		it("keeps the items and records what each one did", async () => {
			const source = controller();
			const t = tool(source);
			await call(t, { changes: THREE });
			await call(t, { done: 1, note: "applied" });
			await call(t, { failed: 2, note: "check unchanged" });

			source.transaction = 2;
			const out = await call(t, {});

			// the landed item is work to do again, but its history says it worked
			expect(out).toContain("[ ] 1.");
			expect(out).toContain("landed in TX-01 (applied), rolled back");
			expect(out).toContain("failed in TX-01 (check unchanged)");
		});

		it("writes the retrospective from the record", async () => {
			const source = controller();
			const t = tool(source);
			await call(t, { changes: THREE });
			await call(t, { done: 1, note: "applied" });
			await call(t, { failed: 2, note: "check unchanged" });

			source.transaction = 2;
			const out = await call(t, {});

			expect(out).toContain("TX-01 is closed");
			expect(out).toContain("WORKED   #1 delete the extra }");
			expect(out).toContain("DID NOT  #2 delete the stray }");
			expect(out).toContain("RE-USE   #3 insert the closing }");
			expect(out).toContain("DIFFERENT");
		});

		it("does not clear the retrospective on a read, only on a new plan", async () => {
			const source = controller();
			const t = tool(source);
			await call(t, { changes: THREE });
			await call(t, { done: 1 });

			source.transaction = 2;
			expect(await call(t, {})).toContain("TX-01 is closed");
			// still owed
			expect(await call(t, {})).toContain("TX-01 is closed");
			// answering it clears it
			expect(await call(t, { changes: THREE })).toContain("TX-01 is closed");
			expect(await call(t, {})).not.toContain("TX-01 is closed");
		});

		it("gives the transaction a fresh declaration budget", async () => {
			const source = controller();
			const t = tool(source);
			for (let i = 0; i < MAX_DECLARATIONS_PER_TRANSACTION; i += 1) {
				await call(t, { changes: THREE });
			}
			expect(await call(t, { changes: THREE })).toContain(
				"Restating it is not progress",
			);
			source.transaction = 2;
			expect(await call(t, { changes: THREE })).not.toContain(
				"Restating it is not progress",
			);
		});

		it("keeps history for an item whose WHAT is unchanged when the plan is restated", async () => {
			const source = controller();
			const t = tool(source);
			await call(t, { changes: THREE });
			await call(t, { done: 1, note: "applied" });
			source.transaction = 2;
			// a new plan that still contains the same first change
			const out = await call(t, {
				changes: [THREE[0], { where: "line 84", what: "add ;", why: "parse" }],
			});
			expect(out).toContain("landed in TX-01 (applied), rolled back");
		});

		it("says nothing about a transaction that never had a plan", async () => {
			const source = controller();
			const t = tool(source);
			source.transaction = 2;
			expect(await call(t, {})).not.toContain("is closed");
		});
	});

	it("reports the plan to the host when it changes", async () => {
		const seen: number[] = [];
		const t = tool(controller(), (items) => seen.push(items.length));
		await call(t, { changes: THREE });
		await call(t, { done: 1 });
		expect(seen).toEqual([3, 3]);
	});
});

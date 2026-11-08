import { describe, expect, it } from "vitest";
import { createSubmitTransactionTool } from "./submit-transaction-tool";

describe("submit_transaction", () => {
	it("passes the account through and returns the verdict", async () => {
		const seen: (string | undefined)[] = [];
		const tool = createSubmitTransactionTool({
			submit: async (account) => {
				seen.push(account);
				return "kept";
			},
		});

		expect(await tool.execute({ account: "  fixed it  " }, {} as never)).toBe(
			"kept",
		);
		expect(seen).toEqual(["fixed it"]);
	});

	// Settling runs the check and may roll back. An error from the rollback
	// half used to be answered "still open and your changes are still in
	// place", which a model then built on (automaticum audit 2026-11-08).
	it("does not promise the changes survived a settle that failed", async () => {
		const errors: string[] = [];
		const tool = createSubmitTransactionTool({
			submit: async () => {
				throw new Error("EBUSY: resource busy");
			},
			onError: (message) => errors.push(message),
		});

		const said = String(await tool.execute({}, {} as never));

		expect(said).toContain("EBUSY");
		expect(said).not.toContain("still in place");
		expect(said).toContain("may or may not still hold your changes");
		expect(said).toContain("Read the files you changed");
		expect(errors).toHaveLength(1);
	});
});

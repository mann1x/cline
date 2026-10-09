import { describe, expect, it, vi } from "vitest";
import { delegatedToolOptions } from "./spawn-tool";

/**
 * A sandboxed agent is built with none of the lead's executors, so that none
 * re-points its file tools at the real workspace. The code search is the one
 * that goes through: it only reads.
 */
describe("a delegated agent's executors", () => {
	const semanticSearch = {
		available: () => true,
		search: vi.fn(async (..._args: unknown[]) => "hits"),
	};
	const editor = vi.fn();
	const overlay = { read: async () => Buffer.from("copy") };
	const workspace = {
		executorOptions: { overlay },
		allowCommands: false,
	} as never;

	it("carries the code search into the sandbox and nothing else of the lead's", async () => {
		const options = delegatedToolOptions(workspace, {
			semanticSearch,
			editor,
		} as never);

		expect(Object.keys(options.executors ?? {})).toEqual(["semanticSearch"]);
		expect(options.enableBash).toBe(false);
		// Through the agent's copy, not the lead's own executor.
		expect(options.executors?.semanticSearch).not.toBe(semanticSearch);
		await options.executors?.semanticSearch?.search("q", "/ws", {} as never);
		expect(semanticSearch.search.mock.calls[0]?.[3]).toHaveProperty("readFile");
	});

	it("adds no executors when the lead has no code search", () => {
		expect(
			delegatedToolOptions(workspace, { editor } as never).executors,
		).toBeUndefined();
	});

	it("keeps the lead's executors, the search with them, without a sandbox", () => {
		const lead = { semanticSearch, editor } as never;
		expect(delegatedToolOptions(undefined, lead).executors).toBe(lead);
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	enableCliCodeSearch,
	getCliCodeSearch,
	resetCliCodeSearch,
} from "./code-search";

const refresh = vi.fn(async () => {});
const createCodeSearch = vi.fn((options: { getConfig: () => unknown }) => ({
	available: () => true,
	search: async () => "",
	state: () => ({ running: false }),
	refresh,
	options,
}));

vi.mock("@cline/core", () => ({
	createCodeSearch: (options: { getConfig: () => unknown }) =>
		createCodeSearch(options),
	DEFAULT_LIBRARY_SETTINGS: { codeIndexWorkspaces: [] },
}));

describe("--code-index", () => {
	afterEach(() => {
		resetCliCodeSearch();
		refresh.mockClear();
		createCodeSearch.mockClear();
	});

	it("does nothing but say why without an embedding model", async () => {
		const warn = vi.fn();

		expect(await enableCliCodeSearch({ cwd: "/ws", warn })).toBe(false);

		expect(warn.mock.calls[0]?.[0]).toContain("CLINE_EMBEDDING_BASE_URL");
		expect(getCliCodeSearch()).toBeUndefined();
		expect(createCodeSearch).not.toHaveBeenCalled();
	});

	it("opts the run's folder in, with the named model, and starts the index", async () => {
		const warn = vi.fn();

		expect(
			await enableCliCodeSearch({
				cwd: "/ws",
				embeddingBaseUrl: "http://e:1",
				embeddingModel: "embed",
				embeddingApiKey: "k",
				warn,
			}),
		).toBe(true);

		expect(warn).not.toHaveBeenCalled();
		expect(getCliCodeSearch()).toBeDefined();
		expect(refresh).toHaveBeenCalledWith("/ws");
		const options = createCodeSearch.mock.calls[0]?.[0] as {
			install?: boolean;
			getConfig: () => unknown;
		};
		expect(options.install).toBe(true);
		expect(options.getConfig()).toEqual({
			settings: { codeIndexWorkspaces: ["/ws"] },
			embedding: { baseUrl: "http://e:1", model: "embed", apiKey: "k" },
		});
	});
});

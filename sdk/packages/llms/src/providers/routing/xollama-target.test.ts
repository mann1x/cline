import { describe, expect, it } from "vitest";
import { inferProviderOptionsTarget } from "./provider-options-types";

describe("xOllama's provider options", () => {
	// Every Ollama option rule -- num_ctx, the sampler, think -- keys on this
	// target, so xOllama gets them all by resolving to it.
	it("resolve as Ollama's", () => {
		expect(inferProviderOptionsTarget("xollama")).toBe("ollama");
		expect(inferProviderOptionsTarget("ollama")).toBe("ollama");
	});
});

import { describe, expect, it } from "vitest";
import { isOllamaNativeProvider } from "./utils";

describe("isOllamaNativeProvider", () => {
	// xOllama is an Ollama fork: what holds for Ollama's wire holds for it.
	it("is Ollama and xOllama, and nothing else", () => {
		expect(isOllamaNativeProvider("ollama")).toBe(true);
		expect(isOllamaNativeProvider("xollama")).toBe(true);
		expect(isOllamaNativeProvider("opencoti")).toBe(false);
		expect(isOllamaNativeProvider("ollama-cloud")).toBe(false);
		expect(isOllamaNativeProvider(undefined)).toBe(false);
	});
});

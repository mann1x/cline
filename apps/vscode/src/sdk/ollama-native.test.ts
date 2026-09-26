import { describe, expect, it } from "vitest"
import { withOllamaNativeDefault, XOLLAMA_DEFAULT_BASE_URL } from "./ollama-native"

describe("withOllamaNativeDefault", () => {
	// An unset base URL means Ollama's own port to every Ollama lookup, which
	// is the wrong server for xOllama.
	it("names xOllama's port when its URL is unset", () => {
		expect(withOllamaNativeDefault("xollama", undefined)).toBe(XOLLAMA_DEFAULT_BASE_URL)
		expect(withOllamaNativeDefault("xollama", "  ")).toBe(XOLLAMA_DEFAULT_BASE_URL)
		expect(withOllamaNativeDefault("xollama", "http://gpu2:22434")).toBe("http://gpu2:22434")
	})

	it("leaves Ollama's unset URL unset, as its lookups expect", () => {
		expect(withOllamaNativeDefault("ollama", undefined)).toBeUndefined()
	})
})

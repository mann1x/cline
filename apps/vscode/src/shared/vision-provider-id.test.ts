import { describe, expect, it } from "vitest"
import { baseProviderId, isVisionProviderId, visionProviderId } from "./vision-provider-id"

describe("where the Vision tab keeps its provider settings", () => {
	it("is a different entry from the one Plan and Act read", () => {
		// The reported bug: picking a vision model overwrote Act's model
		// selection, because both tabs wrote providers.json under "ollama".
		expect(visionProviderId("ollama")).not.toBe("ollama")
	})

	it("still names the vendor the request goes to", () => {
		expect(baseProviderId(visionProviderId("ollama"))).toBe("ollama")
	})

	it("leaves an ordinary id alone", () => {
		expect(baseProviderId("ollama")).toBe("ollama")
		expect(isVisionProviderId("ollama")).toBe(false)
	})

	it("does not stack when applied twice", () => {
		// The hook applies it, and a caller holding an already-scoped id must not
		// end up one level deeper.
		expect(visionProviderId(visionProviderId("ollama"))).toBe(visionProviderId("ollama"))
	})

	it("survives the lowercasing every provider id goes through", () => {
		expect(visionProviderId("ollama")).toBe(visionProviderId("ollama").toLowerCase())
	})
})

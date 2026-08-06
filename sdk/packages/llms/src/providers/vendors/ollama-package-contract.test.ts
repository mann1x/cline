import { describe, expect, it } from "vitest"

/**
 * What the vendored patch guarantees about `ollama-ai-provider-v2`.
 *
 * These assert against the installed package rather than our code, because
 * both facts are its behaviour and both are silent when they regress: an
 * upgrade that drops the patch would send `think: true` (which Ollama reads as
 * *unbounded*) and quietly strip `think_budget`, and every test of our own
 * wiring would still pass while no request was bounded any more.
 */
describe("ollama-ai-provider-v2 patch contract", () => {
	it("accepts a thinking level, not just a boolean", async () => {
		const mod = await import("ollama-ai-provider-v2")
		const schema = (mod as unknown as { ollamaProviderOptions?: unknown }).ollamaProviderOptions

		// The schema is not exported; assert through the shipped bundle instead.
		if (!schema) {
			const { readFileSync } = await import("node:fs")
			const { createRequire } = await import("node:module")
			const require = createRequire(import.meta.url)
			const entry = require.resolve("ollama-ai-provider-v2")
			const source = readFileSync(entry, "utf8")

			// A level must survive as a level.
			expect(source).toMatch(/think: \w+(\.\w+)?\.union\(\[/)
			// ...and must not be collapsed to a boolean on the way to the wire.
			expect(source).not.toContain("was mapped to think=true")
			return
		}
		expect(schema).toBeDefined()
	})

	it("keeps options it does not name, so think_budget survives", async () => {
		const { readFileSync } = await import("node:fs")
		const { createRequire } = await import("node:module")
		const require = createRequire(import.meta.url)
		const entry = require.resolve("ollama-ai-provider-v2")
		const source = readFileSync(entry, "utf8")

		expect(source).toMatch(/\}\)\.catchall\(/)
	})
})

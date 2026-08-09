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

	/**
	 * Where the API prefix lives.
	 *
	 * This package appends bare paths to `baseURL` (`/chat`), so `/api` has to
	 * be part of the base URL. The previous provider took the opposite
	 * convention — a bare origin, with `/api/...` appended by the client — and
	 * carrying that normalization over sent every request to `/chat`, which
	 * Ollama answers with a plain `404 page not found`.
	 *
	 * The rest of this vendor's tests mock `createOllama`, so no test of our own
	 * wiring can see which convention the package follows. This one lets the
	 * real package build the URL and asserts the path it actually requests.
	 */
	it("requests /api/chat when given a configured origin", async () => {
		const { createOllamaProviderModule } = await import("./ollama")

		const requested: string[] = []
		const fetchMock = (async (input: RequestInfo | URL) => {
			requested.push(typeof input === "string" ? input : input.toString())
			return new Response(
				`${JSON.stringify({
					model: "m",
					created_at: "2024-01-01T00:00:00Z",
					message: { role: "assistant", content: "" },
					done: true,
					done_reason: "stop",
					prompt_eval_count: 1,
					eval_count: 1,
				})}\n`,
				{ status: 200, headers: { "content-type": "application/x-ndjson" } },
			)
		}) as typeof fetch

		const provider = await createOllamaProviderModule(
			{ providerId: "ollama", baseUrl: "http://localhost:11434", fetch: fetchMock } as never,
			{
				provider: { id: "ollama", name: "Ollama", defaultModelId: "", models: [] },
				model: { id: "m", name: "m", providerId: "ollama" },
			} as never,
		)

		const stream = await provider.model("m").doStream({
			prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		} as never)
		// Drain so the request is actually issued and the mock is not left open.
		const reader = (stream as { stream: ReadableStream }).stream.getReader()
		while (!(await reader.read()).done) {
			// no-op
		}

		// Not `requested[0]`: the factory asks `/api/show` for the model's own
		// `num_ctx` before the first completion. What this test pins is the
		// path the package builds for a chat, not the order of the two.
		expect(requested).toContain("http://localhost:11434/api/chat")
	})
})

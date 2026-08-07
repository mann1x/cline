import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock("@/shared/net", () => ({ fetch: mocks.fetch }))
vi.mock("@/shared/services/Logger", () => ({ Logger: { log: vi.fn() } }))

import {
	clearOllamaModelFamilyCache,
	DEFAULT_OLLAMA_BASE_URL,
	resolveOllamaImageSupport,
	resolveOllamaModelFamily,
} from "./ollama-model-family"

const post = mocks.fetch

/** What `fetch` gives back, as much of it as this module reads. */
function ok(payload: unknown) {
	return { ok: true, status: 200, json: async () => payload }
}

beforeEach(() => {
	clearOllamaModelFamilyCache()
	post.mockReset()
})

afterEach(() => {
	vi.clearAllMocks()
})

describe("resolveOllamaModelFamily", () => {
	it("reads the family a local model reports", async () => {
		// The case this exists for: nothing in the name says "Gemma".
		post.mockResolvedValueOnce(ok({ details: { family: "gemma4" } }) as never)

		await expect(resolveOllamaModelFamily("http://localhost:11434", "v7-coder_tb:Q4_K_M")).resolves.toBe("gemma4")

		expect(post).toHaveBeenCalledWith(
			"http://localhost:11434/api/show",
			expect.objectContaining({
				method: "POST",
				// A string body, not a stream: the fetch adapter axios is configured
				// with hands undici a stream, which it rejects without `duplex`.
				body: JSON.stringify({ model: "v7-coder_tb:Q4_K_M" }),
			}),
		)
	})

	it("falls back to the architecture when there is no details block", async () => {
		post.mockResolvedValueOnce(ok({ model_info: { "general.architecture": "qwen35moe" } }) as never)

		await expect(resolveOllamaModelFamily("http://localhost:11434", "old-build")).resolves.toBe("qwen35moe")
	})

	it("resolves to nothing when Ollama is not reachable", async () => {
		// A session must still start; it falls back to the provider or default
		// template.
		post.mockRejectedValueOnce(new Error("ECONNREFUSED"))

		await expect(resolveOllamaModelFamily("http://localhost:11434", "anything")).resolves.toBeUndefined()
	})

	it("sends a body undici will accept", async () => {
		// The bug this exists for. Going through axios meant going through the
		// fetch adapter it is configured with, which hands undici a stream —
		// and undici rejects a stream body outright: `RequestInit: duplex
		// option is required when sending a body`. Every other caller on this
		// path issues a GET, so this was the only one to meet it, and the
		// failure was invisible: the lookup fails soft, so the only symptom was
		// every Ollama model quietly resolving to `default.md`.
		post.mockResolvedValueOnce(ok({ details: { family: "gemma4" } }) as never)

		await resolveOllamaModelFamily("http://localhost:11434", "m")

		const init = post.mock.calls[0]?.[1] as RequestInit
		expect(typeof init.body).toBe("string")
	})

	it("treats a non-2xx answer as no family", async () => {
		// A wrong endpoint answers 404 rather than throwing, and a 404 body is
		// not a model description.
		post.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) } as never)

		await expect(resolveOllamaModelFamily("http://localhost:11434", "m")).resolves.toBeUndefined()
	})

	it("caches a hit so a session does not pay for it twice", async () => {
		post.mockResolvedValueOnce(ok({ details: { family: "gemma4" } }) as never)

		await resolveOllamaModelFamily("http://localhost:11434", "m")
		await resolveOllamaModelFamily("http://localhost:11434", "m")

		expect(post).toHaveBeenCalledTimes(1)
	})

	it("caches a miss so an absent Ollama is not waited on every session", async () => {
		post.mockRejectedValueOnce(new Error("ECONNREFUSED"))

		await resolveOllamaModelFamily("http://localhost:11434", "m")
		await resolveOllamaModelFamily("http://localhost:11434", "m")

		expect(post).toHaveBeenCalledTimes(1)
	})

	it("keys the cache by endpoint as well as model", async () => {
		// Two hosts can serve different models under the same name.
		post.mockResolvedValueOnce(ok({ details: { family: "gemma4" } }) as never)
		post.mockResolvedValueOnce(ok({ details: { family: "qwen35" } }) as never)

		await expect(resolveOllamaModelFamily("http://a:11434", "same-name")).resolves.toBe("gemma4")
		await expect(resolveOllamaModelFamily("http://b:11434", "same-name")).resolves.toBe("qwen35")
	})

	it("trims a trailing slash off the endpoint", async () => {
		post.mockResolvedValueOnce(ok({ details: { family: "gemma4" } }) as never)

		await resolveOllamaModelFamily("http://localhost:11434/", "m")

		expect(post).toHaveBeenCalledWith("http://localhost:11434/api/show", expect.anything())
	})

	it("asks nothing of an unusable base url or empty model", async () => {
		await expect(resolveOllamaModelFamily("not a url", "m")).resolves.toBeUndefined()
		await expect(resolveOllamaModelFamily("http://localhost:11434", "   ")).resolves.toBeUndefined()
		expect(post).not.toHaveBeenCalled()
	})

	it("falls back to Ollama's own endpoint when none is configured", async () => {
		// The settings field is blank for anyone running Ollama where it
		// installs itself, and skipping the lookup there sent every local model
		// to default.md however clearly the GGUF named its architecture.
		post.mockResolvedValue(ok({ details: { family: "qwen35moe" } }) as never)

		await expect(resolveOllamaModelFamily(undefined, "a3b-coder_tb:vision-Q3_K_M")).resolves.toBe("qwen35moe")
		await expect(resolveOllamaModelFamily("   ", "a3b-coder_tb:vision-Q3_K_M")).resolves.toBe("qwen35moe")

		expect(post).toHaveBeenCalledWith(
			`${DEFAULT_OLLAMA_BASE_URL}/api/show`,
			expect.objectContaining({ body: JSON.stringify({ model: "a3b-coder_tb:vision-Q3_K_M" }) }),
		)
		// Both spellings of "unset" land on one cache entry.
		expect(post).toHaveBeenCalledTimes(1)
	})

	it("treats a blank family as no family", async () => {
		post.mockResolvedValueOnce(ok({ details: { family: "  " } }) as never)

		await expect(resolveOllamaModelFamily("http://localhost:11434", "m")).resolves.toBeUndefined()
	})
})

/**
 * The alternative is a guess, and the guess is optimistic: image support comes
 * from the model catalog, which has never heard of a local model. That is how a
 * browser screenshot reached a model that could not read one. Ollama knows.
 */
describe("resolveOllamaImageSupport", () => {
	it("reports a vision model as one", async () => {
		post.mockResolvedValueOnce(ok({ capabilities: ["completion", "tools", "vision"] }) as never)

		await expect(resolveOllamaImageSupport("http://localhost:11434", "qwen2.5vl:7b")).resolves.toBe(true)
	})

	it("reports a model that lists capabilities without vision as one that cannot", async () => {
		post.mockResolvedValueOnce(ok({ capabilities: ["completion", "tools"] }) as never)

		await expect(resolveOllamaImageSupport("http://localhost:11434", "deepseek-v3")).resolves.toBe(false)
	})

	// Absent is not "no". An older server that cannot answer must leave the
	// existing optimistic default alone rather than disable images.
	it("says nothing when the server does not report capabilities", async () => {
		post.mockResolvedValueOnce(ok({ details: { family: "llama" } }) as never)

		await expect(resolveOllamaImageSupport("http://localhost:11434", "llama3")).resolves.toBeUndefined()
	})

	it("says nothing when Ollama is unreachable", async () => {
		post.mockRejectedValueOnce(new Error("connect ECONNREFUSED") as never)

		await expect(resolveOllamaImageSupport("http://localhost:11434", "llama3")).resolves.toBeUndefined()
	})

	// Family and capabilities arrive in the same response; asking twice would
	// put two waits on the session-start path for one answer.
	it("shares one request with the family lookup", async () => {
		post.mockResolvedValueOnce(ok({ details: { family: "qwen3vl" }, capabilities: ["vision"] }) as never)

		const [family, images] = await Promise.all([
			resolveOllamaModelFamily("http://localhost:11434", "qwen2.5vl:7b"),
			resolveOllamaImageSupport("http://localhost:11434", "qwen2.5vl:7b"),
		])

		expect(family).toBe("qwen3vl")
		expect(images).toBe(true)
		expect(post).toHaveBeenCalledTimes(1)
	})

	it("falls back to the default endpoint when the setting is blank", async () => {
		post.mockResolvedValueOnce(ok({ capabilities: ["vision"] }) as never)

		await expect(resolveOllamaImageSupport("", "qwen2.5vl:7b")).resolves.toBe(true)

		expect(post).toHaveBeenCalledWith(`${DEFAULT_OLLAMA_BASE_URL.replace(/\/+$/, "")}/api/show`, expect.anything())
	})
})

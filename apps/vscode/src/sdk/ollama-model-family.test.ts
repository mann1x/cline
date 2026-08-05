import axios from "axios"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearOllamaModelFamilyCache, resolveOllamaModelFamily } from "./ollama-model-family"

vi.mock("axios")
vi.mock("@/shared/net", () => ({ getAxiosSettings: () => ({}) }))
vi.mock("@/shared/services/Logger", () => ({ Logger: { log: vi.fn() } }))

const post = vi.mocked(axios.post)

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
		post.mockResolvedValueOnce({ data: { details: { family: "gemma4" } } } as never)

		await expect(resolveOllamaModelFamily("http://localhost:11434", "v7-coder_tb:Q4_K_M")).resolves.toBe("gemma4")

		expect(post).toHaveBeenCalledWith(
			"http://localhost:11434/api/show",
			{ model: "v7-coder_tb:Q4_K_M" },
			expect.objectContaining({ timeout: 2000 }),
		)
	})

	it("falls back to the architecture when there is no details block", async () => {
		post.mockResolvedValueOnce({
			data: { model_info: { "general.architecture": "qwen35moe" } },
		} as never)

		await expect(resolveOllamaModelFamily("http://localhost:11434", "old-build")).resolves.toBe("qwen35moe")
	})

	it("resolves to nothing when Ollama is not reachable", async () => {
		// A session must still start; it falls back to the provider or default
		// template.
		post.mockRejectedValueOnce(new Error("ECONNREFUSED"))

		await expect(resolveOllamaModelFamily("http://localhost:11434", "anything")).resolves.toBeUndefined()
	})

	it("caches a hit so a session does not pay for it twice", async () => {
		post.mockResolvedValueOnce({ data: { details: { family: "gemma4" } } } as never)

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
		post.mockResolvedValueOnce({ data: { details: { family: "gemma4" } } } as never)
		post.mockResolvedValueOnce({ data: { details: { family: "qwen35" } } } as never)

		await expect(resolveOllamaModelFamily("http://a:11434", "same-name")).resolves.toBe("gemma4")
		await expect(resolveOllamaModelFamily("http://b:11434", "same-name")).resolves.toBe("qwen35")
	})

	it("trims a trailing slash off the endpoint", async () => {
		post.mockResolvedValueOnce({ data: { details: { family: "gemma4" } } } as never)

		await resolveOllamaModelFamily("http://localhost:11434/", "m")

		expect(post).toHaveBeenCalledWith("http://localhost:11434/api/show", expect.anything(), expect.anything())
	})

	it("asks nothing of an unusable base url or empty model", async () => {
		await expect(resolveOllamaModelFamily("not a url", "m")).resolves.toBeUndefined()
		await expect(resolveOllamaModelFamily("http://localhost:11434", "   ")).resolves.toBeUndefined()
		expect(post).not.toHaveBeenCalled()
	})

	it("treats a blank family as no family", async () => {
		post.mockResolvedValueOnce({ data: { details: { family: "  " } } } as never)

		await expect(resolveOllamaModelFamily("http://localhost:11434", "m")).resolves.toBeUndefined()
	})
})

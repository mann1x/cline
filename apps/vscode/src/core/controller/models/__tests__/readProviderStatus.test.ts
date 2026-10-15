import { describe, expect, it, vi } from "vitest"
import type { EffectiveProviderConfig } from "@/sdk/model-catalog/contracts"
import { probeProviderStatus } from "../readProviderStatus"

type Call = { url: string; headers: Record<string, string> }

function stubFetch(answer: (url: string) => Response | Error) {
	const calls: Call[] = []
	const impl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		calls.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) } })
		const result = answer(url)
		if (result instanceof Error) {
			throw result
		}
		return result
	}) as unknown as typeof fetch
	return { impl, calls }
}

function config(providerId: string, fields: Partial<EffectiveProviderConfig> = {}): EffectiveProviderConfig {
	return { providerId, ...fields } as EffectiveProviderConfig
}

const ok = () => new Response("{}", { status: 200 })

describe("probeProviderStatus", () => {
	it("asks an OpenAI-compatible endpoint for /models with the key as a bearer token", async () => {
		const { impl, calls } = stubFetch(ok)
		const status = await probeProviderStatus(
			"openai",
			config("openai", { baseUrl: "http://box:8000/v1/", apiKey: "sk-test" }),
			undefined,
			impl,
		)
		expect(status.state).toBe("ready")
		expect(calls).toHaveLength(1)
		expect(calls[0].url).toBe("http://box:8000/v1/models")
		expect(calls[0].headers.Authorization).toBe("Bearer sk-test")
	})

	it("sends no Authorization header when no key is stored", async () => {
		const { impl, calls } = stubFetch(ok)
		await probeProviderStatus("lmstudio", config("lmstudio", { baseUrl: "http://localhost:1234/v1" }), undefined, impl)
		expect(calls[0].url).toBe("http://localhost:1234/v1/models")
		expect(calls[0].headers.Authorization).toBeUndefined()
	})

	it("uses the provider's default base URL when none is stored", async () => {
		const { impl, calls } = stubFetch(ok)
		await probeProviderStatus("openai-native", config("openai-native", { apiKey: "sk" }), undefined, impl)
		expect(calls[0].url).toBe("https://api.openai.com/v1/models")
	})

	it("asks Anthropic with x-api-key and a version header", async () => {
		const { impl, calls } = stubFetch(ok)
		const status = await probeProviderStatus("anthropic", config("anthropic", { apiKey: "ant" }), undefined, impl)
		expect(status.state).toBe("ready")
		expect(calls[0].url).toBe("https://api.anthropic.com/v1/models")
		expect(calls[0].headers["x-api-key"]).toBe("ant")
		expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01")
	})

	it("asks Gemini with the key in a header, never in the URL", async () => {
		const { impl, calls } = stubFetch(ok)
		await probeProviderStatus("gemini", config("gemini", { apiKey: "g-key" }), undefined, impl)
		expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models")
		expect(calls[0].headers["x-goog-api-key"]).toBe("g-key")
		expect(calls[0].url).not.toContain("g-key")
	})

	it("is unknown, and asks nothing, for a cloud API with no key", async () => {
		const { impl, calls } = stubFetch(ok)
		const status = await probeProviderStatus("anthropic", config("anthropic"), undefined, impl)
		expect(status).toEqual({ state: "unknown", detail: "No API key is set." })
		expect(calls).toHaveLength(0)
	})

	it("fails on a refused key, naming the status", async () => {
		const { impl } = stubFetch(() => new Response("no", { status: 401 }))
		const status = await probeProviderStatus("openai-native", config("openai-native", { apiKey: "bad" }), undefined, impl)
		expect(status.state).toBe("fail")
		expect(status.detail).toContain("refused the API key (HTTP 401)")
	})

	it("fails on any other HTTP error", async () => {
		const { impl } = stubFetch(() => new Response("", { status: 502 }))
		const status = await probeProviderStatus("openai", config("openai", { baseUrl: "http://box/v1" }), undefined, impl)
		expect(status.state).toBe("fail")
		expect(status.detail).toBe("http://box/v1/models answered HTTP 502.")
	})

	it("fails with the network's own code when nothing answers", async () => {
		const error = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })
		const { impl } = stubFetch(() => error)
		const status = await probeProviderStatus("openai", config("openai", { baseUrl: "http://box/v1" }), undefined, impl)
		expect(status.state).toBe("fail")
		expect(status.detail).toBe("http://box/v1/models is not reachable (ECONNREFUSED).")
	})

	it("asks Ollama through /api/tags", async () => {
		const { impl, calls } = stubFetch(() => new Response(JSON.stringify({ models: [] }), { status: 200 }))
		const status = await probeProviderStatus(
			"ollama",
			config("ollama", { baseUrl: "http://pandorum:11434" }),
			undefined,
			impl,
		)
		expect(status.state).toBe("ready")
		expect(calls[0].url).toBe("http://pandorum:11434/api/tags")
	})

	it("fails a keyed xOllama that refuses, as a key problem", async () => {
		const { impl } = stubFetch(() => new Response("", { status: 401 }))
		const status = await probeProviderStatus("xollama", config("xollama", { baseUrl: "http://box:22434" }), undefined, impl)
		expect(status.state).toBe("fail")
		expect(status.detail).toContain("refused the API key")
	})

	describe("the selected model", () => {
		const list =
			(...ids: string[]) =>
			() =>
				new Response(JSON.stringify({ object: "list", data: ids.map((id) => ({ id, owned_by: "organization" })) }), {
					status: 200,
				})
		const tags = () =>
			new Response(JSON.stringify({ models: [{ name: "qwen3:latest", model: "qwen3:latest" }] }), { status: 200 })

		it("is green when a server the user runs lists it", async () => {
			const { impl } = stubFetch(list("qwen3.5-27b", "gemma-4"))
			const status = await probeProviderStatus("lmstudio", config("lmstudio"), "gemma-4", impl)
			expect(status).toMatchObject({ state: "ready", modelFound: true })
			expect(status.detail).toContain("has gemma-4")
		})

		it("is red when the server answers without it, and names what it has", async () => {
			const { impl } = stubFetch(list("qwen3.5-27b", "gemma-4"))
			const status = await probeProviderStatus("openai", config("openai", { baseUrl: "http://box/v1" }), "v9-agentic", impl)
			expect(status).toMatchObject({ state: "fail", modelFound: false })
			expect(status.detail).toContain("does not have v9-agentic")
			expect(status.detail).toContain("It lists 2: qwen3.5-27b, gemma-4.")
		})

		it("is not red on a llama.cpp server that serves one model under any name", async () => {
			const { impl } = stubFetch(
				() =>
					new Response(JSON.stringify({ object: "list", data: [{ id: "model.gguf", owned_by: "llamacpp" }] }), {
						status: 200,
					}),
			)
			const status = await probeProviderStatus("opencoti", config("opencoti"), "omni-v6", impl)
			expect(status.state).toBe("ready")
			expect(status.modelFound).toBeUndefined()
			expect(status.detail).toContain("serves one model (model.gguf) under any name")
		})

		it("is not looked up in a cloud catalog that leaves out aliases", async () => {
			const { impl } = stubFetch(list("claude-sonnet-5-5-20260901"))
			const status = await probeProviderStatus("anthropic", config("anthropic", { apiKey: "k" }), "claude-sonnet-5-5", impl)
			expect(status.state).toBe("ready")
			expect(status.modelFound).toBeUndefined()
		})

		it("is red on Ollama when /api/tags does not have it", async () => {
			const { impl } = stubFetch(tags)
			const status = await probeProviderStatus(
				"ollama",
				config("ollama", { baseUrl: "http://pandorum:11434" }),
				"v9-agentic_A_tb:q4km-96k",
				impl,
			)
			expect(status).toMatchObject({ state: "fail", modelFound: false })
			expect(status.detail).toContain("does not have v9-agentic_A_tb:q4km-96k")
		})

		it("is green on Ollama when it has it, :latest or not", async () => {
			const { impl } = stubFetch(tags)
			const status = await probeProviderStatus("ollama", config("ollama"), "qwen3", impl)
			expect(status).toMatchObject({ state: "ready", modelFound: true })
		})

		it("stays green, saying so, when the list cannot be read", async () => {
			const { impl } = stubFetch(() => new Response("not json", { status: 200 }))
			const status = await probeProviderStatus("lmstudio", config("lmstudio"), "gemma-4", impl)
			expect(status.state).toBe("ready")
			expect(status.detail).toContain("gemma-4 was not checked")
		})
	})

	it.each([
		"bedrock",
		"vertex",
		"claude-code",
		"openai-codex",
		"cline",
	])("is unknown, and asks nothing, for %s", async (providerId) => {
		const { impl, calls } = stubFetch(ok)
		const status = await probeProviderStatus(providerId, config(providerId, { apiKey: "k" }), undefined, impl)
		expect(status.state).toBe("unknown")
		expect(status.detail).not.toBe("")
		expect(calls).toHaveLength(0)
	})
})

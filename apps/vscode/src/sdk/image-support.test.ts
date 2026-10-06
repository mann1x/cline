import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock("@/shared/net", () => ({ fetch: mocks.fetch }))
vi.mock("@/core/storage/StateManager", () => ({ StateManager: { get: vi.fn() } }))
vi.mock("./cline-session-factory", () => ({
	ensureBaseUrlScheme: (value: string) => (/^https?:\/\//.test(value) ? value : `http://${value}`),
	ollamaNativeBaseUrl: vi.fn(),
	resolveBaseUrl: vi.fn(),
	resolveModelId: vi.fn(),
}))
vi.mock("./ollama-model-family", () => ({
	DEFAULT_OLLAMA_BASE_URL: "http://localhost:11434",
	peekOllamaImageSupport: vi.fn(async (_baseUrl: string, modelId: string) =>
		modelId === "cloud-eyes:cloud" ? true : undefined,
	),
}))
vi.mock("./vision-model", () => ({ buildScopedApiConfiguration: vi.fn() }))

import { clearImageSupportCache, listImageModels, resolveImageSupport } from "./image-support"

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

/** What the three servers on the bench answered, 2026-10-06. */
const TAGS = {
	models: [
		{ name: "v7-coder_tb:vision-iq4_nl", capabilities: ["completion", "vision", "tools", "thinking"] },
		{ name: "omnimerge-v6-mtp_tb:27b-q4km-128k", capabilities: ["completion", "tools", "thinking"] },
	],
}

describe("image support, asked of the server", () => {
	beforeEach(() => {
		clearImageSupportCache()
		mocks.fetch.mockReset()
	})

	it("reads an xOllama model's answer from /api/tags at the base URL given", async () => {
		mocks.fetch.mockResolvedValue(json(TAGS))

		expect(await resolveImageSupport("xollama", "http://192.168.178.2:11433", "v7-coder_tb:vision-iq4_nl")).toBe("yes")
		expect(await resolveImageSupport("xollama", "http://192.168.178.2:11433", "omnimerge-v6-mtp_tb:27b-q4km-128k")).toBe("no")
		// One request answers for every model on the server.
		expect(mocks.fetch).toHaveBeenCalledTimes(1)
		expect(mocks.fetch.mock.calls[0][0]).toBe("http://192.168.178.2:11433/api/tags")
	})

	it("asks /api/show for a model the list does not carry", async () => {
		mocks.fetch.mockResolvedValue(json(TAGS))

		expect(await resolveImageSupport("ollama", "http://host:11434", "cloud-eyes:cloud")).toBe("yes")
		expect(await resolveImageSupport("ollama", "http://host:11434", "never-heard-of")).toBe("unknown")
	})

	it("splits a server's models, and reports nothing for a server that lists no capabilities", async () => {
		mocks.fetch.mockResolvedValueOnce(json(TAGS))
		expect(await listImageModels("xollama", "http://a:22434")).toEqual({
			reported: true,
			vision: ["v7-coder_tb:vision-iq4_nl"],
			notVision: ["omnimerge-v6-mtp_tb:27b-q4km-128k"],
		})

		mocks.fetch.mockResolvedValueOnce(json({ models: [{ name: "old-server-model" }] }))
		expect(await listImageModels("ollama", "http://b:11434")).toEqual({ reported: false, vision: [], notVision: [] })
	})

	it("reads llama.cpp's and opencoti's answer from /props at the server root", async () => {
		mocks.fetch.mockResolvedValue(json({ modalities: { vision: false, audio: false } }))

		expect(await resolveImageSupport("opencoti", "http://192.168.178.2:8240/v1", "model.gguf")).toBe("no")
		expect(mocks.fetch.mock.calls[0][0]).toBe("http://192.168.178.2:8240/props")
	})

	it("answers unknown for a server that is down and for a provider that is not asked", async () => {
		mocks.fetch.mockRejectedValue(new Error("ECONNREFUSED"))

		expect(await resolveImageSupport("opencoti", "http://down:8240", "model.gguf")).toBe("unknown")
		expect(await resolveImageSupport("anthropic", undefined, "claude")).toBe("unknown")
	})
})

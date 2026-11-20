import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useServerSamplingDefaults } from "./useServerSamplingDefaults"

const mocks = vi.hoisted(() => ({ read: vi.fn() }))

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: { readServerSamplingDefaults: mocks.read },
}))

describe("useServerSamplingDefaults", () => {
	beforeEach(() => {
		mocks.read.mockReset()
		mocks.read.mockResolvedValue({ reachable: true, parameters: { temperature: "0.8", top_k: "64" } })
	})

	// Reported: opencoti's sampling fields all read "model default" while the
	// Ollama form showed the model's values.
	it("answers the server's defaults for opencoti and the generic llama.cpp provider", async () => {
		for (const providerId of ["opencoti", "openai-compatible"]) {
			const { result } = renderHook(() => useServerSamplingDefaults(providerId, "http://host:8240", "gemma"))
			await waitFor(() => expect(result.current).toEqual({ temperature: "0.8", top_k: "64" }))
		}
		expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ providerId: "opencoti", modelId: "gemma" }))
	})

	it("never asks a hosted provider or a provider with no base URL", async () => {
		const hosted = renderHook(() => useServerSamplingDefaults("openai", "https://api.openai.com/v1", "gpt"))
		const unset = renderHook(() => useServerSamplingDefaults("opencoti", undefined, "gemma"))
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(mocks.read).not.toHaveBeenCalled()
		expect(hosted.result.current).toEqual({})
		expect(unset.result.current).toEqual({})
	})

	it("leaves nothing when the server does not answer", async () => {
		mocks.read.mockRejectedValue(new Error("down"))
		const { result } = renderHook(() => useServerSamplingDefaults("opencoti", "http://down:1", "gemma"))
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(result.current).toEqual({})
	})
})

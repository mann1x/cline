import { OllamaReachabilityResponse } from "@shared/proto/cline/models"
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ModelsServiceClient } from "@/services/grpc-client"
import { describeReachability, RECHECK_WHILE_DOWN_MS, useOllamaReachability } from "./useOllamaReachability"

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: { readOllamaReachability: vi.fn() },
}))

const read = vi.mocked(ModelsServiceClient.readOllamaReachability)
const answer = (fields: Partial<OllamaReachabilityResponse>) =>
	OllamaReachabilityResponse.create({ reachable: true, baseUrl: "http://gpu2:11434", ...fields })

describe("what the chat input says about its server", () => {
	it("names the server, the network's answer, and where the fix is", () => {
		const problem = describeReachability("ollama", "qwen3", answer({ reachable: false, error: "ECONNREFUSED" }))
		expect(problem?.kind).toBe("down")
		expect(problem?.message).toBe(
			"Ollama at http://gpu2:11434 is not reachable (ECONNREFUSED). Check the base URL in the provider settings, or whether the server is running.",
		)
	})

	it("points a remote xOllama at its exposure switch, and a local one not", () => {
		const remote = describeReachability("xollama", "m", answer({ reachable: false, baseUrl: "http://192.168.178.161:22434" }))
		expect(remote?.message).toContain("XOLLAMA_HOST=0.0.0.0:<port>")
		const local = describeReachability("xollama", "m", answer({ reachable: false, baseUrl: "http://localhost:22434" }))
		expect(local?.message).not.toContain("XOLLAMA_HOST")
	})

	it("tells a refused key from a server that is down", () => {
		const problem = describeReachability("xollama", "m", answer({ reachable: false, error: "HTTP 401", unauthorized: true }))
		expect(problem?.kind).toBe("auth")
		expect(problem?.message).toContain("needs its API key")
		expect(problem?.message).toContain("not an ollama.com key")
	})

	it("says when the server answers without the model", () => {
		const problem = describeReachability("xollama", "omni-council", answer({ modelFound: false }))
		expect(problem).toEqual({
			kind: "model",
			message: "xOllama at http://gpu2:11434 does not have omni-council. Pull it there, or choose another model.",
		})
	})

	it("says nothing when all is well, or when the host could not be asked", () => {
		expect(describeReachability("ollama", "qwen3", answer({ modelFound: true }))).toBeUndefined()
		expect(describeReachability("ollama", "qwen3", answer({}))).toBeUndefined()
		expect(describeReachability("ollama", "qwen3", undefined)).toBeUndefined()
	})
})

describe("keeping it current", () => {
	beforeEach(() => {
		read.mockReset()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("asks nothing for a provider it does not apply to", () => {
		const { result } = renderHook(() => useOllamaReachability("anthropic", "claude"))
		expect(result.current).toBeUndefined()
		expect(read).not.toHaveBeenCalled()
	})

	it("clears the warning once the server comes back", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
		read.mockResolvedValueOnce(answer({ reachable: false, error: "ECONNREFUSED" }))
		read.mockResolvedValueOnce(answer({ modelFound: true }))
		const { result } = renderHook(() => useOllamaReachability("ollama", "qwen3"))
		await waitFor(() => expect(result.current?.kind).toBe("down"))
		expect(read.mock.calls[0]?.[0]).toMatchObject({ providerId: "ollama", modelId: "qwen3" })

		await act(async () => {
			await vi.advanceTimersByTimeAsync(RECHECK_WHILE_DOWN_MS)
		})
		await waitFor(() => expect(result.current).toBeUndefined())
		expect(read).toHaveBeenCalledTimes(2)
	})

	it("does not warn when the host itself could not be asked", async () => {
		read.mockRejectedValue(new Error("no host"))
		const { result } = renderHook(() => useOllamaReachability("ollama", "qwen3"))
		await waitFor(() => expect(read).toHaveBeenCalled())
		expect(result.current).toBeUndefined()
	})
})

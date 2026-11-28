import { describe, expect, it } from "vitest"
import { profileServerChange } from "../profileServerChange"

const SOLIDPC = {
	global: { ollamaBaseUrl: "http://192.168.178.2:11434" },
	mode: { apiProvider: "ollama", ollamaModelId: "omnimerge-v6-mtp_tb:27b-q4km-128k" },
	providerConfig: { baseUrl: "http://192.168.178.2:11434", contextWindow: 128000 },
}

describe("profileServerChange", () => {
	it("reports a provider switch that brought another server and model", () => {
		const bonsai = {
			global: { ollamaBaseUrl: "http://192.168.178.2:11434" },
			// xOllama keeps its model in apiModelId; the Ollama field is a stale
			// copy from another profile, as it was on pandorum.
			mode: {
				apiProvider: "xollama",
				apiModelId: "mannix/bonsai-2-27b:mtp-vision-ptq1_0",
				ollamaModelId: "v9-agentic_std12_tb:q4km-64k",
			},
			providerConfig: { baseUrl: "http://127.0.0.1:22434" },
		}
		const change = profileServerChange(SOLIDPC, bonsai)
		expect(change?.from).toEqual({
			provider: "ollama",
			baseUrl: "http://192.168.178.2:11434",
			model: "omnimerge-v6-mtp_tb:27b-q4km-128k",
		})
		expect(change?.to.provider).toBe("xollama")
		expect(change?.to.baseUrl).toBe("http://127.0.0.1:22434")
		expect(change?.to.model).toBe("mannix/bonsai-2-27b:mtp-vision-ptq1_0")
	})

	it("says nothing when the switch kept the server and model", () => {
		// The carry commits the model on xOllama, which also writes apiModelId.
		const carried = { ...SOLIDPC, mode: { ...SOLIDPC.mode, apiProvider: "xollama", apiModelId: SOLIDPC.mode.ollamaModelId } }
		expect(profileServerChange(SOLIDPC, carried)).toBeUndefined()
	})

	it("says nothing about ordinary edits on the same provider", () => {
		const edited = {
			...SOLIDPC,
			mode: { ...SOLIDPC.mode, ollamaModelId: "other:tag" },
			providerConfig: { baseUrl: "http://other:11434" },
		}
		expect(profileServerChange(SOLIDPC, edited)).toBeUndefined()
	})
})

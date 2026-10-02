import { beforeEach, describe, expect, it, vi } from "vitest"
import { audioEndpointsConfigured, parseAudioEndpoints } from "@/shared/audio-endpoints"

const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, secrets: {} as Record<string, string> }))

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: () => ({
			getGlobalSettingsKey: (key: string) => state.settings[key],
			getSecretKey: (key: string) => state.secrets[key],
			getApiConfiguration: () => ({}),
		}),
	},
}))

import { resolveSpeech, resolveTranscription } from "./audio-config"
import { resetMediaProbes } from "./media-endpoint-config"

const store = (value: unknown) => {
	state.settings.audioEndpoints = JSON.stringify(value)
}

describe("the audio endpoints", () => {
	beforeEach(() => {
		state.settings = { audioEnabled: true }
		state.secrets = {}
		resetMediaProbes()
		// Nothing answers: the servers these name may be started later.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("connection refused")
			}),
		)
	})

	it("reads an empty or broken record as an empty tab", () => {
		expect(parseAudioEndpoints(undefined)).toEqual({ stt: { baseUrl: "", model: "" }, tts: { baseUrl: "", model: "" } })
		expect(parseAudioEndpoints("{not json")).toEqual({ stt: { baseUrl: "", model: "" }, tts: { baseUrl: "", model: "" } })
		expect(audioEndpointsConfigured(parseAudioEndpoints(undefined))).toBe(false)
		expect(audioEndpointsConfigured(parseAudioEndpoints('{"useProvider":true}'))).toBe(true)
		expect(audioEndpointsConfigured(parseAudioEndpoints('{"tts":{"baseUrl":"http://h","model":"m"}}'))).toBe(true)
		expect(audioEndpointsConfigured(parseAudioEndpoints('{"tts":{"baseUrl":"http://h","model":"m","disabled":true}}'))).toBe(
			false,
		)
	})

	it("offers a typed endpoint that is not answering, with a warning", async () => {
		store({ stt: { baseUrl: "http://127.0.0.1:9", model: "whisper" }, tts: { baseUrl: "", model: "" } })
		state.secrets.audioSttApiKey = " sk-stt "
		const resolved = await resolveTranscription(undefined)
		expect(resolved).toMatchObject({
			source: "typed",
			server: "unknown",
			endpoint: { baseUrl: "http://127.0.0.1:9", model: "whisper", apiKey: "sk-stt" },
		})
		expect("warning" in resolved && resolved.warning).toBeTruthy()
		// The other tool names nowhere to go, and each is resolved on its own.
		expect(await resolveSpeech(undefined)).toHaveProperty("disabled")
	})

	it("carries the tab's voice and format to the speech endpoint, and each key to its own", async () => {
		store({
			stt: { baseUrl: "", model: "" },
			tts: { baseUrl: "http://127.0.0.1:9", model: "outetts", voice: "anna", format: "wav" },
		})
		state.secrets.audioSttApiKey = "sk-stt"
		const resolved = await resolveSpeech(undefined)
		expect(resolved).toMatchObject({ endpoint: { model: "outetts", voice: "anna", format: "wav" } })
		expect("endpoint" in resolved && resolved.endpoint.apiKey).toBeUndefined()
	})

	it("is off with the panel's box, and per tool with the tab's", async () => {
		store({
			stt: { baseUrl: "http://127.0.0.1:9", model: "whisper", disabled: true },
			tts: { baseUrl: "http://127.0.0.1:9", model: "outetts" },
		})
		expect(await resolveTranscription(undefined)).toEqual({ disabled: "speech-to-text is switched off on the Audio tab" })
		expect(await resolveSpeech(undefined)).toHaveProperty("endpoint")
		state.settings.audioEnabled = false
		expect(await resolveSpeech(undefined)).toEqual({ disabled: "audio processing is switched off" })
	})
})

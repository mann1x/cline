import { beforeEach, describe, expect, it, vi } from "vitest"
import { parseVideoEndpoint, videoEndpointConfigured } from "@/shared/video-endpoint"

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

import { resetMediaProbes } from "./media-endpoint-config"
import { resolveExtensionMediaTool } from "./media-tools-config"

const resolveVideoGeneration = (provider?: undefined) => resolveExtensionMediaTool("generate_video", provider)

describe("the video endpoint", () => {
	beforeEach(() => {
		state.settings = { videoEnabled: true }
		state.secrets = {}
		resetMediaProbes()
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("connection refused")
			}),
		)
	})

	it("reads an empty or broken record as an empty tab", () => {
		expect(parseVideoEndpoint(undefined)).toEqual({ baseUrl: "", model: "" })
		expect(parseVideoEndpoint("{not json")).toEqual({ baseUrl: "", model: "" })
		expect(parseVideoEndpoint('{"baseUrl":"http://h","model":"m","seconds":"3","format":"MP4","size":" 832x480 "}')).toEqual({
			baseUrl: "http://h",
			model: "m",
			seconds: 3,
			format: "mp4",
			size: "832x480",
		})
		expect(videoEndpointConfigured(parseVideoEndpoint(undefined))).toBe(false)
		expect(videoEndpointConfigured(parseVideoEndpoint('{"useProvider":true}'))).toBe(true)
	})

	it("offers a typed endpoint that is not answering, with its defaults and key", async () => {
		state.settings.videoEndpoint = JSON.stringify({
			baseUrl: "http://127.0.0.1:9",
			model: "wan2.1",
			size: "832x480",
			seconds: 2,
			format: "mp4",
		})
		state.secrets.videoApiKey = " sk-v "
		const resolved = await resolveVideoGeneration(undefined)
		expect(resolved).toMatchObject({
			source: "typed",
			server: "unknown",
			endpoint: {
				baseUrl: "http://127.0.0.1:9",
				model: "wan2.1",
				apiKey: "sk-v",
				size: "832x480",
				seconds: 2,
				format: "mp4",
			},
		})
		expect("warning" in resolved && resolved.warning).toBeTruthy()
	})

	it("is not offered with nothing named, or with the panel's box unticked", async () => {
		expect(await resolveVideoGeneration(undefined)).toHaveProperty("disabled")
		state.settings.videoEndpoint = JSON.stringify({ baseUrl: "http://127.0.0.1:9", model: "wan2.1" })
		state.settings.videoEnabled = false
		expect(await resolveVideoGeneration(undefined)).toEqual({ disabled: "video generation is switched off" })
	})
})

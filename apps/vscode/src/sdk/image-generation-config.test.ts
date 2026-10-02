import type { MediaEndpointProbe, MediaKind, MediaSessionProvider } from "@cline/core"
import { beforeEach, describe, expect, it, vi } from "vitest"

const stored = { endpoint: "" as string, apiKey: undefined as string | undefined, enabled: true as boolean | undefined }

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: () => ({
			getGlobalSettingsKey: (key: string) =>
				key === "imageGenEndpoint" ? stored.endpoint : key === "imageGenEnabled" ? stored.enabled : undefined,
			getSecretKey: (key: string) => (key === "imageGenApiKey" ? stored.apiKey : undefined),
		}),
	},
}))

// What answers at each base URL. A URL with no entry is a server that is down.
const servers: Record<string, MediaEndpointProbe> = {}

vi.mock("./media-endpoint-config", async () => {
	const core = await import("@cline/core")
	return {
		resolveMediaTab: (
			kind: MediaKind,
			tab: { useProvider?: boolean; baseUrl?: string; model?: string; apiKey?: string },
			provider?: MediaSessionProvider,
		) =>
			core.resolveMediaEndpoint({
				kind,
				useProvider: tab.useProvider === true,
				provider,
				typed: tab,
				probe: async (baseUrl: string) => servers[baseUrl],
			}),
	}
})

vi.mock("@/shared/services/Logger", () => ({
	Logger: { log: () => {}, warn: () => {}, error: () => {} },
}))

import { readStoredEndpoint, resolveImageGeneration } from "./image-generation-config"

const plain: MediaEndpointProbe = { server: "openai", kinds: {}, models: [] }
const opencoti: MediaEndpointProbe = {
	server: "opencoti",
	kinds: { image_generation: true, image_edit: true, transcription: false, speech: false, video: false },
	models: [{ id: "qwen3-14b" }, { id: "klein", kinds: ["image_generation", "image_edit"] }],
}

beforeEach(() => {
	stored.endpoint = ""
	stored.apiKey = undefined
	stored.enabled = true
	for (const key of Object.keys(servers)) {
		delete servers[key]
	}
	servers["https://gen.pollinations.ai"] = plain
	servers["http://localhost:8080"] = plain
})

describe("resolveImageGeneration", () => {
	it("uses the endpoint the user named on the Images tab", async () => {
		stored.endpoint = JSON.stringify({ baseUrl: " https://gen.pollinations.ai ", model: " z-image ", size: "1024x1024" })

		expect(await resolveImageGeneration()).toEqual({
			endpoint: { baseUrl: "https://gen.pollinations.ai", model: "z-image", size: "1024x1024" },
			source: "typed",
			server: "openai",
		})
	})

	// The key is stored apart from the rest, and has to be put back together
	// here: nothing else reads both, and the tool needs one object.
	it("joins the stored key back on, and leaves it off when there is none", async () => {
		stored.endpoint = JSON.stringify({ baseUrl: "https://gen.pollinations.ai", model: "z-image" })
		stored.apiKey = "  sk-secret  "
		expect(await resolveImageGeneration()).toMatchObject({ endpoint: { apiKey: "sk-secret" } })

		stored.apiKey = "   "
		const resolved = await resolveImageGeneration()
		expect("endpoint" in resolved && resolved.endpoint).not.toHaveProperty("apiKey")
	})

	// Half a configuration cannot be called. Offering the tool on it only moves
	// the failure to where the model has to explain it to the user.
	it("is not offered without both an endpoint and a model", async () => {
		stored.endpoint = JSON.stringify({ baseUrl: "http://localhost:8080", model: "" })
		expect(await resolveImageGeneration()).toEqual({ disabled: "the endpoint has no model named" })

		stored.endpoint = JSON.stringify({ baseUrl: "   ", model: "z-image" })
		expect(await resolveImageGeneration()).toEqual({ disabled: "no endpoint is configured" })

		stored.endpoint = ""
		expect(await resolveImageGeneration()).toEqual({ disabled: "no endpoint is configured" })
	})

	// The owner's rule: an endpoint may be started on request, so one that is
	// down is still offered. The box is the off switch.
	it("is offered when the endpoint does not answer, with a warning", async () => {
		stored.endpoint = JSON.stringify({ baseUrl: "http://down:1", model: "z-image" })
		expect(await resolveImageGeneration()).toEqual({
			endpoint: { baseUrl: "http://down:1", model: "z-image" },
			source: "typed",
			server: "unknown",
			warning: "the endpoint at http://down:1 does not answer right now",
		})
	})

	// Stored JSON that will not parse is a settings file someone edited, not a
	// reason to throw inside a tool call.
	it("treats unparseable storage as nothing configured", async () => {
		stored.endpoint = "{not json"
		expect(readStoredEndpoint()).toBeUndefined()
		expect(await resolveImageGeneration()).toEqual({ disabled: "no endpoint is configured" })
	})

	// The checkbox is the user's decision. A stored endpoint used to keep the
	// tool offered with the box unticked, because the gate read only the
	// endpoint and nothing else read the box at all.
	it("is off with the box unticked, whatever is stored", async () => {
		stored.endpoint = JSON.stringify({ baseUrl: "http://localhost:8080", model: "z-image" })
		stored.enabled = false
		expect(await resolveImageGeneration()).toEqual({ disabled: "image generation is switched off" })

		stored.enabled = undefined
		expect(await resolveImageGeneration()).toEqual({ disabled: "image generation is switched off" })

		stored.enabled = true
		expect(await resolveImageGeneration()).toMatchObject({ source: "typed" })
	})
})

describe("the session's own provider", () => {
	const lead = { providerId: "opencoti", baseUrl: "http://bs2:8244", modelId: "qwen3-14b" }

	it("generates there when the tab says so and the server draws, keeping the tab's size", async () => {
		servers["http://bs2:8244"] = opencoti
		stored.endpoint = JSON.stringify({ baseUrl: "", model: "", size: "768x768", useProvider: true })

		expect(await resolveImageGeneration(lead)).toEqual({
			endpoint: { baseUrl: "http://bs2:8244", model: "klein", size: "768x768" },
			source: "provider",
			server: "opencoti",
		})
	})

	it("is ignored without the flag", async () => {
		servers["http://bs2:8244"] = opencoti
		stored.endpoint = JSON.stringify({ baseUrl: "http://localhost:8080", model: "z-image" })

		expect(await resolveImageGeneration(lead)).toMatchObject({ source: "typed" })
	})

	it("gives way to the typed endpoint when it has no image engine, or is another kind of server", async () => {
		stored.endpoint = JSON.stringify({ baseUrl: "http://localhost:8080", model: "z-image", useProvider: true })
		servers["http://bs2:8244"] = { ...opencoti, kinds: { ...opencoti.kinds, image_generation: false } }
		expect(await resolveImageGeneration(lead)).toMatchObject({ source: "typed" })

		servers["http://bs2:8244"] = plain
		expect(await resolveImageGeneration(lead)).toMatchObject({ source: "typed" })
	})

	it("leaves the tool out when neither it nor a typed endpoint serves", async () => {
		servers["http://bs2:8244"] = plain
		stored.endpoint = JSON.stringify({ baseUrl: "", model: "", useProvider: true })
		expect(await resolveImageGeneration(lead)).toEqual({ disabled: "no endpoint is configured" })
	})
})

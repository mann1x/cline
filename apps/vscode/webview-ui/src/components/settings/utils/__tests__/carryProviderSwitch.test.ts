import { captureProviderConfigSnapshot } from "@shared/api-config-snapshot"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { carryProviderSwitch } from "../carryProviderSwitch"

/**
 * providers.json, one entry per provider, with the store's write rule: a field
 * a patch names replaces the stored one, and `0` / `{}` clear it.
 */
const store = vi.hoisted(() => ({ entries: new Map<string, Record<string, unknown>>() }))

function applyPatch(entry: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const next = { ...entry }
	for (const [key, value] of Object.entries(patch)) {
		const isClear =
			value === 0 || (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)
		if (isClear) {
			delete next[key]
		} else if (value !== undefined) {
			next[key] = value
		}
	}
	return next
}

vi.mock("@/hooks/useProviderConfig", () => ({
	readProviderConfig: (id: string) => store.entries.get(id),
	writeProviderConfigFor: async (id: string, patch: Record<string, unknown>) => {
		store.entries.set(id, applyPatch(store.entries.get(id) ?? { providerId: id }, patch))
	},
	toProtobufProviderModelOverrides: (overrides: unknown) => overrides,
}))

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: {
		commitModelSelection: async (request: { providerId: string; mode: "plan" | "act"; modelId: string }) => {
			const entry = store.entries.get(request.providerId) ?? { providerId: request.providerId }
			store.entries.set(request.providerId, {
				...entry,
				[request.mode === "plan" ? "planSelection" : "actSelection"]: { modelId: request.modelId },
			})
		},
	},
}))

const SOLIDPC_OLLAMA = {
	providerId: "ollama",
	baseUrl: "http://192.168.178.2:11434",
	headers: {},
	contextWindow: 128000,
	reasoning: { enabled: true, effort: "high" },
	sampling: { temperature: 0.8 },
	actSelection: { modelId: "omnimerge-v6-mtp_tb:27b-q4km-128k" },
	planSelection: { modelId: "omnimerge-v6-mtp_tb:27b-q4km-128k" },
}

// What loading "pandorumx - Bonsai ptq1" left on the xOllama entry.
const BONSAI_XOLLAMA = {
	providerId: "xollama",
	baseUrl: "http://127.0.0.1:22434",
	headers: {},
	contextWindow: 192000,
	reasoning: { enabled: true, effort: "high" },
	sampling: { temperature: 0.8, topK: 40 },
	outputBudget: { mode: "auto" },
	polykv: { dynamicContextSize: true },
	notices: { enabled: true },
	actSelection: { modelId: "mannix/bonsai-2-27b:mtp-vision-ptq1_0" },
	planSelection: { modelId: "mannix/bonsai-2-27b:mtp-vision-ptq1_0" },
}

describe("carryProviderSwitch", () => {
	beforeEach(() => {
		store.entries.clear()
		store.entries.set("ollama", structuredClone(SOLIDPC_OLLAMA))
		store.entries.set("xollama", structuredClone(BONSAI_XOLLAMA))
	})

	it("moving a profile from Ollama to xOllama keeps its server, not the last xOllama profile's", async () => {
		expect(await carryProviderSwitch("ollama", "xollama", ["plan", "act"])).toBe(true)
		const xollama = store.entries.get("xollama") ?? {}
		expect(xollama.baseUrl).toBe("http://192.168.178.2:11434")
		expect(xollama.contextWindow).toBe(128000)
		expect(xollama.sampling).toEqual({ temperature: 0.8 })
		expect(xollama.actSelection).toEqual({ modelId: "omnimerge-v6-mtp_tb:27b-q4km-128k" })
		expect(xollama.planSelection).toEqual({ modelId: "omnimerge-v6-mtp_tb:27b-q4km-128k" })
		// Bonsai's manual leftovers are gone, xOllama's own sections stay.
		expect(xollama).not.toHaveProperty("outputBudget")
		expect(xollama.polykv).toEqual({ dynamicContextSize: true })
		expect(xollama.notices).toEqual({ enabled: true })

		// And what Update would save from the panel now is the solidpc server.
		const saved = captureProviderConfigSnapshot(xollama, "act")
		expect(saved?.baseUrl).toBe("http://192.168.178.2:11434")
		expect(saved?.contextWindow).toBe(128000)
	})

	it("leaves the target alone outside a family", async () => {
		store.entries.set("anthropic", { providerId: "anthropic" })
		expect(await carryProviderSwitch("ollama", "anthropic", ["act"])).toBe(false)
		expect(store.entries.get("anthropic")).toEqual({ providerId: "anthropic" })
	})

	it("only commits the modes it was given", async () => {
		await carryProviderSwitch("ollama", "xollama", ["act"])
		expect(store.entries.get("xollama")?.planSelection).toEqual({ modelId: "mannix/bonsai-2-27b:mtp-vision-ptq1_0" })
		expect(store.entries.get("xollama")?.actSelection).toEqual({ modelId: "omnimerge-v6-mtp_tb:27b-q4km-128k" })
	})
})

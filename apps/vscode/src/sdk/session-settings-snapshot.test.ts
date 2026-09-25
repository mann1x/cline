import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ getProviderSettings: vi.fn() }))

vi.mock("@shared/services/Logger", () => ({ Logger: { warn: vi.fn(), log: vi.fn(), error: vi.fn() } }))
vi.mock("./legacy-state-reader", () => ({ resolveDataDir: () => "/data" }))
vi.mock("./provider-migration", () => ({
	getProviderSettingsManager: () => ({ getProviderSettings: mocks.getProviderSettings }),
}))
vi.mock("./model-catalog/sdk-provider-id", () => ({ toSdkProviderId: (id: string) => id }))

import { recordPolykvGrantedWindow, resetPolykvSessions } from "@cline/llms"
import { captureSessionSettings, describeSessionSettings } from "./session-settings-snapshot"

describe("captureSessionSettings", () => {
	// A session record is exported, synced between machines and pasted into
	// issues. Anything that can carry a credential stays out of it.
	it("records what explains the run and never a credential", () => {
		mocks.getProviderSettings.mockReturnValue({
			provider: "opencoti",
			model: "v9-agentic",
			apiKey: "sk-secret",
			baseUrl: "http://192.168.178.2:8241",
			headers: { Authorization: "Bearer secret" },
			aws: { accessKeyId: "AKIA" },
			contextWindow: 65536,
			sampling: { temperature: 0.5 },
		})

		const recorded = captureSessionSettings("opencoti")

		expect(recorded).toEqual({ contextWindow: 65536, sampling: { temperature: 0.5 } })
		expect(JSON.stringify(recorded)).not.toContain("secret")
		expect(JSON.stringify(recorded)).not.toContain("AKIA")
	})

	// The record is faithful: a key that was set is kept, whatever its value.
	// Only a key that was never set is dropped, so that a reader can tell
	// "off" from "never configured".
	it("drops what was never set and keeps what was set to off", () => {
		mocks.getProviderSettings.mockReturnValue({
			polykv: { enabled: false, overcommit: false, swarm: false },
			tools: [],
			reasoning: { enabled: false },
		})

		expect(captureSessionSettings("opencoti")).toEqual({
			polykv: { enabled: false, overcommit: false, swarm: false },
			reasoning: { enabled: false },
		})
	})

	it("records nothing rather than an empty object when there is nothing to record", () => {
		mocks.getProviderSettings.mockReturnValue({ apiKey: "sk-secret" })
		expect(captureSessionSettings("opencoti")).toBeUndefined()
	})

	// The resume rule across a re-stamp: a resumed session is stamped again at
	// start, and the window it was granted must be in the new stamp, or the
	// next restart forgets which window it has to ask for.
	it("records the window the session was granted", () => {
		mocks.getProviderSettings.mockReturnValue({ contextWindow: 262_144 })
		recordPolykvGrantedWindow("conv", 163_840, { asked: 262_144 })
		try {
			expect(captureSessionSettings("opencoti", "conv")).toEqual({
				contextWindow: 262_144,
				contextWindowGrant: { granted: 163_840, asked: 262_144 },
			})
			expect(
				describeSessionSettings({
					settings: { contextWindowGrant: { granted: 163_840 } },
				}),
			).toContainEqual({ label: "Granted window", value: "163,840 tokens" })
		} finally {
			resetPolykvSessions()
		}
	})

	// A session must start whether or not providers.json can be read.
	it("survives an unreadable providers.json", () => {
		mocks.getProviderSettings.mockImplementation(() => {
			throw new Error("EACCES")
		})
		expect(captureSessionSettings("opencoti")).toBeUndefined()
	})
})

describe("describeSessionSettings", () => {
	it("leads with provider and model, which every session record has", () => {
		const rows = describeSessionSettings({ provider: "opencoti", model: "v9-agentic" })

		expect(rows).toEqual([
			{ label: "Provider", value: "opencoti" },
			{ label: "Model", value: "v9-agentic" },
		])
	})

	it("spells out the budget, the reasoning state and each sampler field", () => {
		const rows = describeSessionSettings({
			provider: "opencoti",
			model: "v9-agentic",
			settings: {
				contextWindow: 65536,
				outputBudget: { mode: "auto", maxTokens: 96000 },
				reasoning: { enabled: false },
				sampling: { temperature: 0.5, repeatLastN: 96 },
			},
		})
		const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.value]))

		expect(byLabel["Context window"]).toBe("65,536 tokens")
		expect(byLabel["Output budget"]).toBe("auto, 96,000 tokens")
		expect(byLabel.Reasoning).toBe("off")
		expect(byLabel.temperature).toBe("0.5")
		expect(byLabel["repeat last n"]).toBe("96")
	})

	// An all-off section is a row that says nothing, and the reader still has
	// to read it. Deciding that is the renderer's job, not the record's.
	it("gives an all-off PolyKV section no row", () => {
		const rows = describeSessionSettings({
			provider: "opencoti",
			settings: { polykv: { enabled: false, overcommit: false, swarm: false } },
		})

		expect(rows.some((row) => row.label === "PolyKV")).toBe(false)
	})

	// Sessions recorded before any of this exist in every install that will
	// take the update, and they are most of the list on the day it lands.
	it("still describes a session that carries no snapshot", () => {
		const rows = describeSessionSettings({ provider: "ollama", model: "qwen3", settings: undefined })
		expect(rows).toHaveLength(2)
	})
})

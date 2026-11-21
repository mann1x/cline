import { describe, expect, it, vi } from "vitest"

vi.mock("@/core/storage/StateManager", () => ({ StateManager: { get: () => ({}) } }))

import { capEndpointByAccount } from "./cline-session-factory"

describe("capEndpointByAccount", () => {
	const entries = [
		{ providerId: "ollama", baseUrl: "http://127.0.0.1:11434/", limit: 8 },
		{ providerId: "ollama", baseUrl: "http://192.168.178.161:11434", limit: 8 },
		{ providerId: "openrouter", limit: 6 },
	]

	it("holds the agents' endpoint to the plan's allowance, and only that one", () => {
		expect(capEndpointByAccount(entries, { providerId: "OLLAMA", baseUrl: "http://127.0.0.1:11434" }, 3)).toEqual([
			{ providerId: "ollama", baseUrl: "http://127.0.0.1:11434/", limit: 3 },
			entries[1],
			entries[2],
		])
	})

	it("leaves a lower count, and everything when no plan applies", () => {
		const low = [{ providerId: "ollama", limit: 2 }]
		expect(capEndpointByAccount(low, { providerId: "ollama" }, 3)).toEqual(low)
		expect(capEndpointByAccount(entries, { providerId: "ollama" }, undefined)).toBe(entries)
		expect(capEndpointByAccount(undefined, { providerId: "ollama" }, 3)).toBeUndefined()
	})
})

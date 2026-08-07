import { describe, expect, it } from "vitest"
import {
	type ApiConfigurationProfile,
	findApiConfigurationProfile,
	MAX_PROFILE_NAME_LENGTH,
	parseApiConfigurationProfiles,
	parseApiConfigurationSnapshot,
	proposeProfileName,
	removeApiConfigurationProfile,
	serializeApiConfigurationProfiles,
	upsertApiConfigurationProfile,
} from "./api-config-profiles"

function profile(name: string, updatedAt = 1): ApiConfigurationProfile {
	return { name, updatedAt, snapshot: { global: {}, mode: { apiProvider: "ollama" } } }
}

describe("parseApiConfigurationProfiles", () => {
	it("round-trips what it wrote", () => {
		const profiles = [profile("ollama / qwen3"), profile("anthropic / sonnet")]
		expect(parseApiConfigurationProfiles(serializeApiConfigurationProfiles(profiles))).toEqual(profiles)
	})

	it("reads an unset setting as no profiles", () => {
		expect(parseApiConfigurationProfiles(undefined)).toEqual([])
		expect(parseApiConfigurationProfiles("")).toEqual([])
	})

	// The settings panel has to open even when this value is nonsense; throwing
	// here would take the whole panel with it.
	it("survives malformed JSON", () => {
		expect(parseApiConfigurationProfiles("{not json")).toEqual([])
		expect(parseApiConfigurationProfiles('{"a":1}')).toEqual([])
	})

	it("drops entries with no usable name or snapshot", () => {
		const raw = JSON.stringify([
			{ name: "  ", snapshot: { global: {}, mode: {} } },
			{ name: "keeper", snapshot: { global: {}, mode: {} } },
			{ name: "no snapshot" },
			null,
		])
		expect(parseApiConfigurationProfiles(raw).map((entry) => entry.name)).toEqual(["keeper"])
	})

	it("keeps the first of two profiles sharing a name", () => {
		const raw = JSON.stringify([
			{ name: "dup", updatedAt: 1, snapshot: { global: { a: 1 }, mode: {} } },
			{ name: "dup", updatedAt: 2, snapshot: { global: { a: 2 }, mode: {} } },
		])
		const parsed = parseApiConfigurationProfiles(raw)
		expect(parsed).toHaveLength(1)
		expect(parsed[0].snapshot.global.a).toBe(1)
	})

	it("repairs a snapshot that lost a half", () => {
		const raw = JSON.stringify([{ name: "half", snapshot: { mode: { apiProvider: "ollama" } } }])
		expect(parseApiConfigurationProfiles(raw)[0].snapshot.global).toEqual({})
	})
})

describe("proposeProfileName", () => {
	it("names the combination the user is actually choosing", () => {
		expect(proposeProfileName("ollama", "v7-coder_tb:vision-iq4_nl", [])).toBe("ollama / v7-coder_tb:vision-iq4_nl")
	})

	it("falls back when there is nothing selected yet", () => {
		expect(proposeProfileName(undefined, undefined, [])).toBe("New profile")
	})

	it("uses whichever half it has", () => {
		expect(proposeProfileName("ollama", undefined, [])).toBe("ollama")
	})

	// Proposing a name that already exists would turn a save into a silent
	// overwrite of someone else's profile.
	it("does not propose a name that is taken", () => {
		const existing = [profile("ollama / qwen3")]
		expect(proposeProfileName("ollama", "qwen3", existing)).toBe("ollama / qwen3 (2)")
	})

	it("keeps counting past the first collision", () => {
		const existing = [profile("ollama / qwen3"), profile("ollama / qwen3 (2)")]
		expect(proposeProfileName("ollama", "qwen3", existing)).toBe("ollama / qwen3 (3)")
	})

	it("truncates a name storage would not want", () => {
		const name = proposeProfileName("ollama", "x".repeat(500), [])
		expect(name.length).toBe(MAX_PROFILE_NAME_LENGTH)
	})
})

describe("the profile list", () => {
	it("adds a profile in name order", () => {
		const profiles = upsertApiConfigurationProfile([profile("zeta"), profile("alpha")], profile("mid"))
		expect(profiles.map((entry) => entry.name)).toEqual(["alpha", "mid", "zeta"])
	})

	it("replaces rather than duplicates an existing name", () => {
		const profiles = upsertApiConfigurationProfile([profile("alpha", 1)], profile("alpha", 2))
		expect(profiles).toHaveLength(1)
		expect(profiles[0].updatedAt).toBe(2)
	})

	// Names are shown, matched and typed by a person; case is not a distinction
	// anyone would expect to matter.
	it("matches names without regard to case", () => {
		expect(findApiConfigurationProfile([profile("Ollama / Qwen3")], "ollama / qwen3")?.name).toBe("Ollama / Qwen3")
		expect(removeApiConfigurationProfile([profile("Alpha")], "alpha")).toEqual([])
		expect(upsertApiConfigurationProfile([profile("Alpha", 1)], profile("alpha", 2))).toHaveLength(1)
	})
})

describe("parseApiConfigurationSnapshot", () => {
	it("reads a stored snapshot", () => {
		const raw = JSON.stringify({ global: { ollamaBaseUrl: "http://x" }, mode: { apiProvider: "ollama" } })
		expect(parseApiConfigurationSnapshot(raw)).toEqual({
			global: { ollamaBaseUrl: "http://x" },
			mode: { apiProvider: "ollama" },
		})
	})

	it("reports nothing stored rather than an empty snapshot", () => {
		expect(parseApiConfigurationSnapshot("")).toBeUndefined()
		expect(parseApiConfigurationSnapshot("garbage")).toBeUndefined()
		expect(parseApiConfigurationSnapshot("[1,2]")).toBeUndefined()
	})
})

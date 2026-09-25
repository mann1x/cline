import { getPolykvWindowGrant, recordPolykvGrantedWindow, recordPolykvWindowObservation, resetPolykvSessions } from "@cline/llms"
import type { AgentEvent } from "@cline/shared"
import { afterEach, describe, expect, it } from "vitest"
import { hydrateWindowGrant, persistWindowGrant, readContextWindowGrant, WINDOW_GRANT_SETTINGS_KEY } from "./context-window-grant"
import { MessageTranslatorState, translateSessionEvent } from "./message-translator"

afterEach(resetPolykvSessions)

/** An in-memory stand-in for the session store, recording its writes. */
function store(records: Record<string, Record<string, unknown>>) {
	const writes: Array<{ sessionId: string; metadata: Record<string, unknown> }> = []
	return {
		writes,
		get: async (sessionId: string) => (records[sessionId] ? { metadata: records[sessionId] } : undefined),
		update: async (sessionId: string, updates: { metadata?: Record<string, unknown> | null }) => {
			records[sessionId] = updates.metadata ?? {}
			writes.push({ sessionId, metadata: records[sessionId] })
			return { updated: true }
		},
	}
}

describe("what the context bar is told about the window", () => {
	it("is the grant the last response stated, with the conversation's original ask", () => {
		recordPolykvGrantedWindow("conv", 163_840, { asked: 262_144 })
		// A resume asks for exactly its grant; the bar still compares with the
		// ask the conversation was opened with.
		recordPolykvWindowObservation("conv", { granted: 163_840, asked: 163_840 })
		expect(readContextWindowGrant("conv")).toEqual({ grantedTokens: 163_840, askedTokens: 262_144 })
	})

	it("counts a shared prefix riding above a private budget", () => {
		recordPolykvGrantedWindow("conv", 150_000, { asked: 150_000, sharedTokens: 10_000 })
		recordPolykvWindowObservation("conv", { granted: 150_000, asked: 150_000 })
		expect(readContextWindowGrant("conv")).toEqual({ grantedTokens: 160_000, askedTokens: 160_000 })
	})

	// Absent is unknown, not unchanged: the bar falls back to the configured
	// window rather than drawing a grant the server no longer vouched for.
	it("says nothing when the last response stated no grant", () => {
		recordPolykvGrantedWindow("conv", 163_840, { asked: 262_144 })
		recordPolykvWindowObservation("conv", { asked: 163_840 })
		expect(readContextWindowGrant("conv")).toBeUndefined()
	})

	it("rides the usage row, so the bar reads it from the request it describes", () => {
		const state = new MessageTranslatorState(undefined, undefined, undefined, undefined, undefined, () => ({
			grantedTokens: 163_840,
			askedTokens: 262_144,
		}))
		const usage = translateSessionEvent(
			{
				type: "agent_event",
				payload: {
					sessionId: "session-1",
					event: { type: "usage", inputTokens: 10, outputTokens: 1 } as AgentEvent,
				},
			},
			state,
		)
		expect(JSON.parse(usage.messages[0].text ?? "{}").contextWindowGrant).toEqual({
			grantedTokens: 163_840,
			askedTokens: 262_144,
		})
	})
})

describe("keeping the grant with the session", () => {
	it("writes it into the recorded settings snapshot", async () => {
		const sessions = store({ conv: { settings: { contextWindow: 262_144 }, title: "t" } })
		await persistWindowGrant(sessions, "conv", { granted: 163_840, asked: 262_144 })
		expect(sessions.writes[0]?.metadata).toEqual({
			settings: { contextWindow: 262_144, [WINDOW_GRANT_SETTINGS_KEY]: { granted: 163_840, asked: 262_144 } },
			title: "t",
		})
	})

	it("writes nothing for a session it never recorded, or when nothing changed", async () => {
		const sessions = store({
			conv: { settings: { [WINDOW_GRANT_SETTINGS_KEY]: { granted: 163_840 } } },
		})
		await persistWindowGrant(sessions, "conv~agent-1", { granted: 65_536 })
		await persistWindowGrant(sessions, "conv", { granted: 163_840 })
		expect(sessions.writes).toEqual([])
	})

	// The resume rule across a restart: the reopened conversation asks for the
	// window it was opened with, because the record still knows it.
	it("hydrates a reopened conversation from its record", () => {
		expect(
			hydrateWindowGrant("conv", {
				settings: { [WINDOW_GRANT_SETTINGS_KEY]: { granted: 163_840, asked: 262_144, sharedTokens: 100 } },
			}),
		).toBe(true)
		expect(getPolykvWindowGrant("conv")).toEqual({ granted: 163_840, asked: 262_144, sharedTokens: 100 })
	})

	it("keeps an in-memory grant over a stored one", () => {
		recordPolykvGrantedWindow("conv", 131_072)
		expect(hydrateWindowGrant("conv", { settings: { [WINDOW_GRANT_SETTINGS_KEY]: { granted: 65_536 } } })).toBe(false)
		expect(getPolykvWindowGrant("conv")?.granted).toBe(131_072)
	})

	it("ignores a stored record that is not a grant", () => {
		expect(hydrateWindowGrant("conv", { settings: { [WINDOW_GRANT_SETTINGS_KEY]: { granted: "big" } } })).toBe(false)
		expect(getPolykvWindowGrant("conv")).toBeUndefined()
	})
})

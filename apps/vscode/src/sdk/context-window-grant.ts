import {
	getPolykvWindowGrant,
	getPolykvWindowObservation,
	onPolykvWindowGrant,
	type PolykvWindowGrant,
	readPolykvWindowGrant,
	recordPolykvGrantedWindow,
} from "@cline/llms"
import type { ContextWindowGrant } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"

/**
 * The window opencoti granted a conversation, carried to the two places that
 * need it outside the provider: the task header's context bar, and the
 * session's own metadata so a reopened conversation asks for the same window.
 *
 * Stored inside the recorded settings snapshot (`metadata.settings`), under
 * this key, because that is the record of how the session was run -- and the
 * window it was granted is exactly that.
 */
export const WINDOW_GRANT_SETTINGS_KEY = "contextWindowGrant"

/**
 * What the context bar should say about the last request's window.
 *
 * `undefined` unless the last admitted response stated a grant: a response
 * without `X-Context-Window` is not guaranteed, and the bar then shows the
 * configured window rather than a grant it can no longer vouch for.
 *
 * Both numbers include any shared prefix riding above a private budget, so
 * they are the window the conversation can fill, and `askedTokens` is the ask
 * the conversation was OPENED with -- a resume asks for exactly its grant, and
 * comparing against that would hide a window that was negotiated down.
 */
export function readContextWindowGrant(sessionId: string | undefined): ContextWindowGrant | undefined {
	const observed = getPolykvWindowObservation(sessionId)
	if (observed?.granted === undefined) {
		return undefined
	}
	const grant = getPolykvWindowGrant(sessionId)
	const shared = grant?.sharedTokens ?? observed.sharedTokens ?? 0
	const asked = grant?.asked ?? observed.asked
	return {
		grantedTokens: observed.granted + shared,
		...(asked !== undefined ? { askedTokens: asked + shared } : {}),
	}
}

function settingsOf(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	const settings = metadata?.settings
	return settings && typeof settings === "object" && !Array.isArray(settings)
		? (settings as Record<string, unknown>)
		: undefined
}

/** The grant a stored session record carries, if it carries a valid one. */
export function readStoredWindowGrant(metadata: Record<string, unknown> | undefined): PolykvWindowGrant | undefined {
	return readPolykvWindowGrant(settingsOf(metadata)?.[WINDOW_GRANT_SETTINGS_KEY])
}

/**
 * Put a reopened conversation's grant back where the provider reads it.
 *
 * Only when this process does not already hold one: an in-memory grant is the
 * newer truth, and the stored copy is what survives an extension restart.
 * Returns whether anything was hydrated.
 */
export function hydrateWindowGrant(sessionId: string, metadata: Record<string, unknown> | undefined): boolean {
	if (getPolykvWindowGrant(sessionId)) {
		return false
	}
	const stored = readStoredWindowGrant(metadata)
	if (!stored) {
		return false
	}
	recordPolykvGrantedWindow(sessionId, stored.granted, {
		...(stored.asked !== undefined ? { asked: stored.asked } : {}),
		...(stored.sharedTokens !== undefined ? { sharedTokens: stored.sharedTokens } : {}),
	})
	return true
}

interface SessionRecordStore {
	get(sessionId: string): Promise<{ metadata?: Record<string, unknown> } | undefined>
	update(sessionId: string, updates: { metadata?: Record<string, unknown> | null }): Promise<{ updated: boolean }>
}

function sameGrant(a: PolykvWindowGrant | undefined, b: PolykvWindowGrant): boolean {
	return a?.granted === b.granted && a?.asked === b.asked && a?.sharedTokens === b.sharedTokens
}

/**
 * Write a session's grant into its stored settings snapshot.
 *
 * Read-modify-write of the whole metadata, as every other writer of it does.
 * A session this host never recorded -- a swarm worker's engine id, a title
 * call's auxiliary id -- has no record and is skipped, and so is a write that
 * would change nothing.
 */
export async function persistWindowGrant(
	store: SessionRecordStore,
	sessionId: string,
	grant: PolykvWindowGrant,
): Promise<boolean> {
	const record = await store.get(sessionId)
	if (!record) {
		return false
	}
	const metadata = record.metadata ?? {}
	const settings = settingsOf(metadata) ?? {}
	if (sameGrant(readPolykvWindowGrant(settings[WINDOW_GRANT_SETTINGS_KEY]), grant)) {
		return false
	}
	const result = await store.update(sessionId, {
		metadata: {
			...metadata,
			settings: { ...settings, [WINDOW_GRANT_SETTINGS_KEY]: { ...grant } },
		},
	})
	return result.updated
}

/**
 * Persist every grant as the provider learns it. Returns the unsubscribe.
 *
 * The grant arrives on a response, long after the session record was written
 * at start, so it cannot ride the start-time snapshot alone.
 */
export function persistWindowGrants(getStore: () => SessionRecordStore | undefined): () => void {
	return onPolykvWindowGrant((sessionId, grant) => {
		const store = getStore()
		if (!store) {
			return
		}
		void persistWindowGrant(store, sessionId, grant).catch((error: unknown) => {
			Logger.warn(`[ContextWindowGrant] Could not record the granted window for ${sessionId}:`, error)
		})
	})
}

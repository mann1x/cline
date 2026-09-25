import type { ContextWindowGrant } from "@shared/ExtensionMessage"

/** What the context bar is drawn against, and whether to say why. */
export interface ShownContextWindow {
	/** The window the bar ends at; 0 when nothing is known. */
	max: number
	/** The bar ends at a window the server granted, not the configured one. */
	granted: boolean
	/** The grant is smaller than what the conversation asked for. */
	smallerThanAsked: boolean
	/** What was asked, for the note. */
	asked?: number
}

/**
 * The window the context bar should end at.
 *
 * The server's grant where it stated one and it is smaller than the configured
 * window: that is all the conversation has. A grant above the configured window
 * is not drawn -- compaction and the output cap are sized to the configured one
 * -- and no grant at all (any provider but opencoti, or a response that did not
 * state one) leaves the configured window, exactly as before.
 *
 * The note compares with the conversation's ORIGINAL ask, which the grant
 * carries: a resume asks for exactly its grant, and comparing against that
 * would hide a window that was negotiated down when it was opened.
 */
export function resolveShownContextWindow(
	configured: number | undefined,
	grant: ContextWindowGrant | undefined,
): ShownContextWindow {
	const configuredWindow = typeof configured === "number" && configured > 0 ? configured : 0
	if (!grant || !(grant.grantedTokens > 0) || (configuredWindow > 0 && grant.grantedTokens >= configuredWindow)) {
		return { max: configuredWindow, granted: false, smallerThanAsked: false }
	}
	const asked = grant.askedTokens ?? (configuredWindow || undefined)
	return {
		max: grant.grantedTokens,
		granted: true,
		smallerThanAsked: asked !== undefined && grant.grantedTokens < asked,
		...(asked !== undefined ? { asked } : {}),
	}
}

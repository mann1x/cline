/**
 * What the Video tab stores, as one JSON record round-tripped whole.
 *
 * Shared by the host that reads it and the tab that writes it. The key is not
 * in here: it is a secret.
 */
export interface VideoEndpointSettings {
	baseUrl: string
	model: string
	/** Use the session's own opencoti or xOllama when it generates video. */
	useProvider?: boolean
	/** Default for calls that name no size, as `WIDTHxHEIGHT`. */
	size?: string
	/** Default for calls that name no length, in seconds. */
	seconds?: number
	/** The container to ask for, e.g. `mp4`. The engine's own when unset. */
	format?: string
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")

/** Unparseable or empty storage is an empty tab, not a reason to throw. */
export function parseVideoEndpoint(raw: string | undefined): VideoEndpointSettings {
	let record: Record<string, unknown> = {}
	if (raw) {
		try {
			const value = JSON.parse(raw)
			if (typeof value === "object" && value !== null) {
				record = value as Record<string, unknown>
			}
		} catch {
			// An empty tab.
		}
	}
	const seconds = typeof record.seconds === "number" ? record.seconds : Number(text(record.seconds))
	return {
		baseUrl: text(record.baseUrl),
		model: text(record.model),
		...(record.useProvider === true ? { useProvider: true } : {}),
		...(text(record.size) ? { size: text(record.size) } : {}),
		...(Number.isFinite(seconds) && seconds > 0 ? { seconds } : {}),
		...(text(record.format) ? { format: text(record.format).toLowerCase() } : {}),
	}
}

/** Whether the tab says anywhere to go at all, for the panel's warning. */
export function videoEndpointConfigured(settings: VideoEndpointSettings): boolean {
	return settings.useProvider === true || (settings.baseUrl !== "" && settings.model !== "")
}

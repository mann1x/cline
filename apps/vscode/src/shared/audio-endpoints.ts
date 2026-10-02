/**
 * What the Audio tab stores, as one JSON record round-tripped whole.
 *
 * Shared by the host that reads it and the tab that writes it, so the two
 * cannot disagree about a field. The keys are not in here: they are secrets.
 */
export interface AudioEndpointSettings {
	/** Where requests go when the session's provider is not used. */
	baseUrl: string
	model: string
	/** The tool is offered unless this is set. */
	disabled?: boolean
}

export interface AudioEndpoints {
	/** Use the session's own opencoti or xOllama when it serves the kind. */
	useProvider?: boolean
	/** Speech-to-text: `transcribe_audio`. */
	stt: AudioEndpointSettings
	/** Text-to-speech: `synthesize_speech`, with the defaults a call may omit. */
	tts: AudioEndpointSettings & { voice?: string; format?: string }
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")

function endpoint(raw: unknown): AudioEndpointSettings {
	const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
	return {
		baseUrl: text(record.baseUrl),
		model: text(record.model),
		...(record.disabled === true ? { disabled: true } : {}),
	}
}

/** Unparseable or empty storage is an empty tab, not a reason to throw. */
export function parseAudioEndpoints(raw: string | undefined): AudioEndpoints {
	let parsed: Record<string, unknown> = {}
	if (raw) {
		try {
			const value = JSON.parse(raw)
			if (typeof value === "object" && value !== null) {
				parsed = value as Record<string, unknown>
			}
		} catch {
			// An empty tab.
		}
	}
	const tts = (typeof parsed.tts === "object" && parsed.tts !== null ? parsed.tts : {}) as Record<string, unknown>
	return {
		...(parsed.useProvider === true ? { useProvider: true } : {}),
		stt: endpoint(parsed.stt),
		tts: {
			...endpoint(parsed.tts),
			...(text(tts.voice) ? { voice: text(tts.voice) } : {}),
			...(text(tts.format) ? { format: text(tts.format) } : {}),
		},
	}
}

/** Whether the tab says anywhere to go at all, for the panel's warning. */
export function audioEndpointsConfigured(endpoints: AudioEndpoints): boolean {
	const named = (settings: AudioEndpointSettings) => !settings.disabled && settings.baseUrl !== "" && settings.model !== ""
	return endpoints.useProvider === true || named(endpoints.stt) || named(endpoints.tts)
}

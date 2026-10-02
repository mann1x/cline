/**
 * What `readMediaEndpoint` answers for one kind of media tool, as JSON.
 *
 * Shared by the host that writes it and the settings tab that shows it. The
 * tab cannot work this out itself: it has neither the session provider's key
 * nor a way to ask a server what it serves.
 */
export type MediaEndpointKind = "image_generation" | "image_edit" | "transcription" | "speech" | "video"

export interface MediaEndpointStatus {
	/**
	 * The session's provider: which server answers there, and whether it serves
	 * this kind. Absent when the provider has no base URL or did not answer.
	 */
	provider?: {
		server: "opencoti" | "xollama" | "openai"
		serves: boolean
		/** The models there that serve this kind. */
		models: string[]
	}
	/** The models the typed endpoint lists for this kind, when it answers. */
	typedModels?: string[]
	/** The tool is offered, and this is where it goes. */
	resolved?: {
		source: "provider" | "typed"
		/** `unknown` is a typed endpoint that did not answer. */
		server: "opencoti" | "xollama" | "openai" | "unknown"
		model: string
		/** Why a call may fail right now; the tool is offered all the same. */
		warning?: string
	}
	/** The tool is not offered, and this is why. */
	disabled?: string
}

export function parseMediaEndpointStatus(raw: string | undefined): MediaEndpointStatus {
	if (!raw) {
		return {}
	}
	try {
		const parsed = JSON.parse(raw) as MediaEndpointStatus
		return typeof parsed === "object" && parsed !== null ? parsed : {}
	} catch {
		return {}
	}
}

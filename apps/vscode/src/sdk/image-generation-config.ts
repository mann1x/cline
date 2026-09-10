import type { ImageGenerationEndpoint } from "@cline/core"
import { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"

/**
 * Where `generate_image` sends its requests, or nothing.
 *
 * Extension state rather than a VS Code setting, which is the second answer to
 * this question: the first was four `cline.imageGeneration.*` settings sitting
 * next to `cline.lintCommand`, and they were wrong twice over. Nobody looks for
 * a model and an endpoint in the Settings UI when every other model and
 * endpoint in this extension is named on the API configuration panel; and the
 * key would have lived in a settings file that syncs and gets committed.
 *
 * So the base URL, the model and the default size are stored as one JSON record
 * the settings view round-trips whole, and the key is a secret, read here and
 * never sent to the webview.
 *
 * Read per call rather than captured at session start, so changing the endpoint
 * takes effect on the next tool call rather than the next window.
 */
export function readImageGenerationEndpoint(): ImageGenerationEndpoint | undefined {
	const stored = readStoredEndpoint()
	// Both or neither: an endpoint with no model cannot be called, and a model
	// with no endpoint has nowhere to go. Offering the tool on half a
	// configuration only moves the failure to where the model has to explain it.
	if (!stored?.baseUrl || !stored.model) {
		return undefined
	}
	const apiKey = readImageGenerationApiKey()
	return {
		baseUrl: stored.baseUrl,
		model: stored.model,
		...(apiKey ? { apiKey } : {}),
		...(stored.size ? { size: stored.size } : {}),
	}
}

/** What is stored, whether or not it is complete enough to call. */
export function readStoredEndpoint(): { baseUrl: string; model: string; size?: string } | undefined {
	const raw = StateManager.get().getGlobalSettingsKey("imageGenEndpoint")
	if (!raw) {
		return undefined
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		Logger.log("[ImageGeneration] The stored endpoint could not be parsed; treating as none configured")
		return undefined
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined
	}
	const record = parsed as { baseUrl?: unknown; model?: unknown; size?: unknown }
	const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")
	const size = text(record.size)
	return {
		baseUrl: text(record.baseUrl),
		model: text(record.model),
		...(size ? { size } : {}),
	}
}

/** The key, for the two callers allowed to have it: the tool and the model listing. */
export function readImageGenerationApiKey(): string | undefined {
	return StateManager.get().getSecretKey("imageGenApiKey")?.trim() || undefined
}

/** Whether the `generate_image` tool should be offered at all. */
export function isImageGenerationConfigured(): boolean {
	return readImageGenerationEndpoint() !== undefined
}

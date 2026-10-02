import type { ImageGenerationEndpoint, MediaServer, MediaSessionProvider } from "@cline/core"
import { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"
import { type MediaTabSettings, resolveMediaTab } from "./media-endpoint-config"

/**
 * Where `generate_image` sends its requests.
 *
 * Extension state rather than a VS Code setting, which is the second answer to
 * this question: the first was four `cline.imageGeneration.*` settings sitting
 * next to `cline.lintCommand`, and they were wrong twice over. Nobody looks for
 * a model and an endpoint in the Settings UI when every other model and
 * endpoint in this extension is named on the API configuration panel; and the
 * key would have lived in a settings file that syncs and gets committed.
 *
 * So the base URL, the model, the default size and the "use the session's
 * provider" flag are stored as one JSON record the settings view round-trips
 * whole, and the key is a secret, read here and never sent to the webview.
 */

/** What is stored, whether or not it is complete enough to call. */
export function readStoredEndpoint(): { baseUrl: string; model: string; size?: string; useProvider?: boolean } | undefined {
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
	const record = parsed as { baseUrl?: unknown; model?: unknown; size?: unknown; useProvider?: unknown }
	const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")
	const size = text(record.size)
	return {
		baseUrl: text(record.baseUrl),
		model: text(record.model),
		...(size ? { size } : {}),
		...(record.useProvider === true ? { useProvider: true } : {}),
	}
}

/** The key, for the two callers allowed to have it: the tool and the model listing. */
export function readImageGenerationApiKey(): string | undefined {
	return StateManager.get().getSecretKey("imageGenApiKey")?.trim() || undefined
}

export type ResolvedImageGeneration =
	| { endpoint: ImageGenerationEndpoint; source: "provider" | "typed"; server: MediaServer | "unknown"; warning?: string }
	| { disabled: string }

/**
 * Where `generate_image` goes for this session, or why it is not offered.
 *
 * The box ticked, and then the owner's rule: the session's own opencoti or
 * xOllama when the tab says to use it and it generates images; the typed
 * endpoint otherwise; and nothing when that names no URL or no model. A typed
 * endpoint that is down is still offered -- it may be started on request --
 * and the box is how the user says they do not want the tool. The box used to
 * be read by nothing but the settings panel, so a stored endpoint kept the tool
 * offered after the user unticked it.
 */
/** The Images tab, as the shared resolution takes a tab. */
export function readImageGenerationTab(): MediaTabSettings {
	const stored = readStoredEndpoint()
	return {
		useProvider: stored?.useProvider,
		baseUrl: stored?.baseUrl,
		model: stored?.model,
		apiKey: readImageGenerationApiKey(),
	}
}

export async function resolveImageGeneration(provider?: MediaSessionProvider): Promise<ResolvedImageGeneration> {
	if (StateManager.get().getGlobalSettingsKey("imageGenEnabled") !== true) {
		return { disabled: "image generation is switched off" }
	}
	const stored = readStoredEndpoint()
	const resolved = await resolveMediaTab("image_generation", readImageGenerationTab(), provider)
	if ("disabled" in resolved) {
		return resolved
	}
	return {
		...resolved,
		endpoint: { ...resolved.endpoint, ...(stored?.size ? { size: stored.size } : {}) },
	}
}

import { type MediaSessionProvider, type MediaToolName, type MediaToolsConfig, resolveMediaTool } from "@cline/core"
import { StateManager } from "@/core/storage/StateManager"
import { parseAudioEndpoints } from "@/shared/audio-endpoints"
import { parseVideoEndpoint } from "@/shared/video-endpoint"
import { readImageGenerationApiKey, readStoredEndpoint } from "./image-generation-config"
import { probeMediaServer, readLeadMediaProvider } from "./media-endpoint-config"

/**
 * The Images, Audio and Video tabs as the one configuration core builds the
 * media tools from.
 *
 * This is all the extension decides about them. Which tools a configuration
 * makes, and where each goes, is `createMediaTools` in core, which the CLI
 * calls with a configuration read from a file -- so the two hosts cannot offer
 * different tools for the same settings.
 *
 * A section is present when its switch is on: the panel's "Use an endpoint for
 * ..." box, and the tab's own switch where a tab holds two tools.
 */
export function readMediaToolsConfig(): MediaToolsConfig {
	const state = StateManager.get()
	const secret = (key: "audioSttApiKey" | "audioTtsApiKey" | "videoApiKey") => state.getSecretKey(key)?.trim() || undefined
	const config: MediaToolsConfig = {}

	if (state.getGlobalSettingsKey("imageGenEnabled") === true) {
		const stored = readStoredEndpoint()
		config.image = {
			useProvider: stored?.useProvider,
			baseUrl: stored?.baseUrl,
			model: stored?.model,
			apiKey: readImageGenerationApiKey(),
			size: stored?.size,
			edit: stored?.editDisabled ? false : { baseUrl: stored?.editBaseUrl, model: stored?.editModel },
		}
	}

	if (state.getGlobalSettingsKey("audioEnabled") === true) {
		const stored = parseAudioEndpoints(state.getGlobalSettingsKey("audioEndpoints"))
		if (!stored.stt.disabled) {
			config.transcription = {
				useProvider: stored.useProvider,
				baseUrl: stored.stt.baseUrl,
				model: stored.stt.model,
				apiKey: secret("audioSttApiKey"),
			}
		}
		if (!stored.tts.disabled) {
			config.speech = {
				useProvider: stored.useProvider,
				baseUrl: stored.tts.baseUrl,
				model: stored.tts.model,
				apiKey: secret("audioTtsApiKey"),
				voice: stored.tts.voice,
				format: stored.tts.format,
			}
		}
	}

	if (state.getGlobalSettingsKey("videoEnabled") === true) {
		const stored = parseVideoEndpoint(state.getGlobalSettingsKey("videoEndpoint"))
		config.video = {
			useProvider: stored.useProvider,
			baseUrl: stored.baseUrl,
			model: stored.model,
			apiKey: secret("videoApiKey"),
			size: stored.size,
			seconds: stored.seconds,
			format: stored.format,
		}
	}
	return config
}

/** Where one media tool goes under the current settings, or why it is not offered. */
export function resolveExtensionMediaTool<T extends MediaToolName>(tool: T, provider?: MediaSessionProvider) {
	return resolveMediaTool(tool, readMediaToolsConfig(), provider ?? readLeadMediaProvider(), probeMediaServer)
}

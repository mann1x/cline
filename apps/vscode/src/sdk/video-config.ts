import { StateManager } from "@/core/storage/StateManager"
import { parseVideoEndpoint, type VideoEndpointSettings } from "@/shared/video-endpoint"
import type { MediaTabSettings } from "./media-endpoint-config"

/**
 * Where `generate_video` sends its requests: the Video tab, under the panel's
 * "Use an endpoint for video generation" box. `media-tools-config.ts` turns
 * the record into the section core resolves.
 */
export function readVideoEndpoint(): VideoEndpointSettings {
	return parseVideoEndpoint(StateManager.get().getGlobalSettingsKey("videoEndpoint"))
}

export function readVideoTab(): MediaTabSettings {
	const stored = readVideoEndpoint()
	return {
		useProvider: stored.useProvider,
		baseUrl: stored.baseUrl,
		model: stored.model,
		apiKey: StateManager.get().getSecretKey("videoApiKey")?.trim() || undefined,
	}
}

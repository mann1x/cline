import type { MediaSessionProvider, ResolvedMediaEndpoint, VideoGenerationEndpoint } from "@cline/core"
import { StateManager } from "@/core/storage/StateManager"
import { parseVideoEndpoint, type VideoEndpointSettings } from "@/shared/video-endpoint"
import { type MediaTabSettings, resolveMediaTab } from "./media-endpoint-config"

/**
 * Where `generate_video` sends its requests: the Video tab, under the panel's
 * "Use an endpoint for video generation" box, resolved by the rule every media
 * tool shares (see `media-endpoint-config.ts`).
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

type ResolvedVideo = Exclude<ResolvedMediaEndpoint, { disabled: string }> & { endpoint: VideoGenerationEndpoint }

export async function resolveVideoGeneration(provider?: MediaSessionProvider): Promise<ResolvedVideo | { disabled: string }> {
	if (StateManager.get().getGlobalSettingsKey("videoEnabled") !== true) {
		return { disabled: "video generation is switched off" }
	}
	const stored = readVideoEndpoint()
	const resolved = await resolveMediaTab("video", readVideoTab(), provider)
	if ("disabled" in resolved) {
		return resolved
	}
	return {
		...resolved,
		endpoint: {
			...resolved.endpoint,
			...(stored.size ? { size: stored.size } : {}),
			...(stored.seconds ? { seconds: stored.seconds } : {}),
			...(stored.format ? { format: stored.format } : {}),
		},
	}
}

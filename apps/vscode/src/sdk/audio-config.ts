import { StateManager } from "@/core/storage/StateManager"
import { type AudioEndpoints, parseAudioEndpoints } from "@/shared/audio-endpoints"
import type { MediaTabSettings } from "./media-endpoint-config"

/**
 * Where `transcribe_audio` and `synthesize_speech` send their requests.
 *
 * The Audio tab holds two endpoints because they are often two servers, and
 * one "use the session's provider" box over both. Each has its own switch on
 * the tab, under the panel's "Use an endpoint for audio processing" box.
 * `media-tools-config.ts` turns the record into the two sections core
 * resolves; what is here is the tab as the settings status reads it.
 */
export function readAudioEndpoints(): AudioEndpoints {
	return parseAudioEndpoints(StateManager.get().getGlobalSettingsKey("audioEndpoints"))
}

const secret = (key: "audioSttApiKey" | "audioTtsApiKey") => StateManager.get().getSecretKey(key)?.trim() || undefined

export function readTranscriptionTab(): MediaTabSettings {
	const stored = readAudioEndpoints()
	return {
		useProvider: stored.useProvider,
		baseUrl: stored.stt.baseUrl,
		model: stored.stt.model,
		apiKey: secret("audioSttApiKey"),
	}
}

export function readSpeechTab(): MediaTabSettings {
	const stored = readAudioEndpoints()
	return {
		useProvider: stored.useProvider,
		baseUrl: stored.tts.baseUrl,
		model: stored.tts.model,
		apiKey: secret("audioTtsApiKey"),
	}
}

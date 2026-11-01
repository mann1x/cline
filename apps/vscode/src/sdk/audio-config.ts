import { StateManager } from "@/core/storage/StateManager"
import { type AudioEndpoints, parseAudioEndpoints, sfxBaseUrl } from "@/shared/audio-endpoints"
import type { MediaTabSettings } from "./media-endpoint-config"

/**
 * Where `transcribe_audio`, `synthesize_speech` and `generate_sound_effect`
 * send their requests.
 *
 * The Audio tab holds three endpoints because they can be separate servers,
 * and one "use the session's provider" box over all of them. Each has its own switch on
 * the tab, under the panel's "Use an endpoint for audio processing" box.
 * `media-tools-config.ts` turns the record into the sections core
 * resolves; what is here is the tab as the settings status reads it.
 */
export function readAudioEndpoints(): AudioEndpoints {
	return parseAudioEndpoints(StateManager.get().getGlobalSettingsKey("audioEndpoints"))
}

const secret = (key: "audioSttApiKey" | "audioTtsApiKey" | "audioSfxApiKey") =>
	StateManager.get().getSecretKey(key)?.trim() || undefined

/**
 * The key for sound effects' endpoint. Never the speech key on another server:
 * each key goes to its own endpoint only, as the tab says.
 */
export function sfxApiKey(stored: AudioEndpoints): string | undefined {
	return secret(stored.sfx.baseUrl ? "audioSfxApiKey" : "audioTtsApiKey")
}

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

export function readSoundEffectsTab(): MediaTabSettings {
	const stored = readAudioEndpoints()
	return {
		useProvider: stored.useProvider,
		baseUrl: sfxBaseUrl(stored),
		model: stored.sfx.model,
		apiKey: sfxApiKey(stored),
	}
}

import type { MediaSessionProvider, ResolvedMediaEndpoint, SpeechEndpoint } from "@cline/core"
import { StateManager } from "@/core/storage/StateManager"
import { type AudioEndpoints, parseAudioEndpoints } from "@/shared/audio-endpoints"
import { type MediaTabSettings, resolveMediaTab } from "./media-endpoint-config"

/**
 * Where `transcribe_audio` and `synthesize_speech` send their requests.
 *
 * The Audio tab holds two endpoints because they are often two servers, and
 * one "use the session's provider" box over both. Each tool is resolved by the
 * rule every media tool shares (see `media-endpoint-config.ts`), and each has
 * its own switch on the tab, under the panel's "Use an endpoint for audio
 * processing" box.
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

function audioOff(): string | undefined {
	return StateManager.get().getGlobalSettingsKey("audioEnabled") === true ? undefined : "audio processing is switched off"
}

export async function resolveTranscription(provider?: MediaSessionProvider): Promise<ResolvedMediaEndpoint> {
	const off = audioOff()
	if (off) {
		return { disabled: off }
	}
	if (readAudioEndpoints().stt.disabled) {
		return { disabled: "speech-to-text is switched off on the Audio tab" }
	}
	return resolveMediaTab("transcription", readTranscriptionTab(), provider)
}

type ResolvedSpeech = Exclude<ResolvedMediaEndpoint, { disabled: string }> & { endpoint: SpeechEndpoint }

export async function resolveSpeech(provider?: MediaSessionProvider): Promise<ResolvedSpeech | { disabled: string }> {
	const off = audioOff()
	if (off) {
		return { disabled: off }
	}
	const stored = readAudioEndpoints()
	if (stored.tts.disabled) {
		return { disabled: "text-to-speech is switched off on the Audio tab" }
	}
	const resolved = await resolveMediaTab("speech", readSpeechTab(), provider)
	if ("disabled" in resolved) {
		return resolved
	}
	return {
		...resolved,
		endpoint: {
			...resolved.endpoint,
			...(stored.tts.voice ? { voice: stored.tts.voice } : {}),
			...(stored.tts.format ? { format: stored.tts.format } : {}),
		},
	}
}

import { listMediaModels, listSpeechVoices, MEDIA_KINDS, type MediaKind } from "@cline/core"
import { String as ProtoString, StringRequest } from "@shared/proto/cline/common"
import { readSpeechTab, readTranscriptionTab } from "@/sdk/audio-config"
import { readImageEditTab, readImageGenerationTab } from "@/sdk/image-generation-config"
import { type MediaTabSettings, probeMediaServer, readLeadMediaProvider, resolveMediaTab } from "@/sdk/media-endpoint-config"
import type { MediaEndpointStatus } from "@/shared/media-endpoint-status"
import { Controller } from ".."

/** The tab that configures each kind. A kind with no tab yet has no entry. */
const TABS: Partial<Record<MediaKind, () => MediaTabSettings>> = {
	image_generation: readImageGenerationTab,
	image_edit: readImageEditTab,
	transcription: readTranscriptionTab,
	speech: readSpeechTab,
}

/** Asked when the user opens the voice picker, never when the pane opens. */
const SPEECH_VOICES_REQUEST = "speech:voices"

/**
 * The voices of the endpoint `synthesize_speech` resolves to. Resolved with
 * the audio switches ignored, so the picker fills while the tool is off.
 */
async function readSpeechVoices(): Promise<MediaEndpointStatus> {
	try {
		const resolved = await resolveMediaTab("speech", readSpeechTab(), readLeadMediaProvider())
		if ("disabled" in resolved) {
			return { disabled: resolved.disabled }
		}
		const voices = await listSpeechVoices(resolved.endpoint, resolved.server)
		return voices ? { voices } : {}
	} catch (error) {
		return { disabled: error instanceof Error ? error.message : String(error) }
	}
}

/**
 * Where one kind of media tool would go right now, and why.
 *
 * Asked by the settings tab rather than worked out in it: the answer depends
 * on what two servers serve, and on a key the webview is never given. It is
 * the same resolution the session runs when it builds its tools, so what the
 * tab says is what the next session does.
 */
export async function readMediaEndpoint(_controller: Controller, request: StringRequest): Promise<ProtoString> {
	if (request.value === SPEECH_VOICES_REQUEST) {
		return ProtoString.create({ value: JSON.stringify(await readSpeechVoices()) })
	}
	const kind = request.value as MediaKind
	const status: MediaEndpointStatus = {}
	const tab = MEDIA_KINDS.includes(kind) ? TABS[kind]?.() : undefined
	if (!tab) {
		return ProtoString.create({ value: JSON.stringify({ disabled: "no settings exist for this yet" }) })
	}
	try {
		const provider = readLeadMediaProvider()
		const probe = provider?.baseUrl ? await probeMediaServer(provider.baseUrl, provider.apiKey) : undefined
		if (probe) {
			const serves = probe.server !== "openai" && probe.kinds[kind] === true
			status.provider = {
				server: probe.server,
				serves,
				// Only what the server says serves it: a chat model listed next
				// to the image engine is not a choice here.
				models: serves ? listMediaModels({ ...probe, models: probe.models.filter((m) => m.kinds) }, kind) : [],
			}
		}
		// What the typed endpoint itself lists for this kind, for the picker.
		const typedProbe = tab.baseUrl?.trim() ? await probeMediaServer(tab.baseUrl, tab.apiKey) : undefined
		if (typedProbe) {
			status.typedModels = listMediaModels(typedProbe, kind)
		}
		const resolved = await resolveMediaTab(kind, tab, provider)
		if ("disabled" in resolved) {
			status.disabled = resolved.disabled
		} else {
			status.resolved = {
				source: resolved.source,
				server: resolved.server,
				model: resolved.endpoint.model,
				...(resolved.warning ? { warning: resolved.warning } : {}),
			}
		}
	} catch (error) {
		status.disabled = error instanceof Error ? error.message : String(error)
	}
	return ProtoString.create({ value: JSON.stringify(status) })
}

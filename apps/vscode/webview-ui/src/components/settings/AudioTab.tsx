import { type AudioEndpoints, parseAudioEndpoints } from "@shared/audio-endpoints"
import { parseMediaEndpointStatus } from "@shared/media-endpoint-status"
import { StringRequest } from "@shared/proto/cline/common"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { useCallback, useMemo, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient, StateServiceClient } from "@/services/grpc-client"
import { DebouncedTextField } from "./common/DebouncedTextField"
import { MediaEndpointStatusLines, mediaPickerModels, useMediaEndpointStatus } from "./common/MediaEndpointStatus"
import { SettingsCheckbox } from "./common/SettingsCheckbox"
import OllamaModelPicker from "./OllamaModelPicker"

interface SpeechVoices {
	voices: string[]
	default?: string
	formats: string[]
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`

/**
 * The two audio endpoints: speech-to-text and text-to-speech.
 *
 * Two endpoints on one tab because they are two tools that are often two
 * servers -- a Whisper box and a TTS box -- and one box over both because an
 * opencoti that serves the chat model can serve both engines too. Like the
 * Images tab this is not a `ScopedModelTab`: what is configured is an
 * endpoint, not a second model in the conversation.
 */
const AudioTab = () => {
	const { audioEndpoints, audioSttApiKeySet, audioTtsApiKeySet } = useExtensionState()
	const stored = useMemo(() => parseAudioEndpoints(audioEndpoints), [audioEndpoints])
	const statusTrigger = `${audioEndpoints}|${audioSttApiKeySet}|${audioTtsApiKeySet}`
	const sttStatus = useMediaEndpointStatus("transcription", statusTrigger)
	const ttsStatus = useMediaEndpointStatus("speech", statusTrigger)
	const [voices, setVoices] = useState<SpeechVoices | undefined>()

	const save = useCallback(async (next: AudioEndpoints) => {
		try {
			await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ audioEndpoints: JSON.stringify(next) }))
		} catch (error) {
			console.error("Failed to save the audio endpoints:", error)
		}
	}, [])
	const saveStt = (patch: Partial<AudioEndpoints["stt"]>) => void save({ ...stored, stt: { ...stored.stt, ...patch } })
	const saveTts = (patch: Partial<AudioEndpoints["tts"]>) => void save({ ...stored, tts: { ...stored.tts, ...patch } })

	const saveKey = useCallback(async (key: "audioSttApiKey" | "audioTtsApiKey", value: string) => {
		try {
			await StateServiceClient.updateSettings(
				UpdateSettingsRequest.create(key === "audioSttApiKey" ? { audioSttApiKey: value } : { audioTtsApiKey: value }),
			)
		} catch (error) {
			console.error("Failed to save the audio key:", error)
		}
	}, [])

	// Asked when the voice picker is opened, never when the pane is: xOllama
	// starts the speech engine to answer.
	const requestVoices = useCallback(async () => {
		try {
			const response = await ModelsServiceClient.readMediaEndpoint(StringRequest.create({ value: "speech:voices" }))
			setVoices(parseMediaEndpointStatus(response?.value).voices)
		} catch (error) {
			console.error("Failed to list the speech voices:", error)
		}
	}, [])

	const useProvider = stored.useProvider === true
	const sttModels = mediaPickerModels(sttStatus)
	const ttsModels = mediaPickerModels(ttsStatus)
	const sttOn = stored.stt.disabled !== true
	const ttsOn = stored.tts.disabled !== true

	return (
		<div className="flex flex-col gap-3">
			<div>
				<SettingsCheckbox checked={useProvider} onChange={(checked) => void save({ ...stored, useProvider: checked })}>
					Use the session's opencoti or xOllama provider when it serves audio
				</SettingsCheckbox>
				<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
					One opencoti can serve the chat model and both audio engines, and an xOllama model can carry them. With this
					ticked, a session running on such a provider transcribes and speaks there, and each endpoint below is the
					fallback for its tool: it is used when the session runs on anything else, or on a server without that engine.
				</p>
			</div>

			<div className="pt-3 border-t border-(--vscode-panel-border)">
				<SettingsCheckbox checked={sttOn} onChange={(checked) => saveStt({ disabled: !checked })}>
					Offer speech-to-text
				</SettingsCheckbox>
				<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
					Offers the <code>transcribe_audio</code> tool, which turns an audio file in the workspace into text: plain
					text, or subtitles (<code>srt</code>, <code>vtt</code>) saved beside it.
				</p>
				{sttOn ? (
					<MediaEndpointStatusLines
						lacks="no speech-to-text engine loaded"
						serves="transcribes audio"
						status={sttStatus}
						toggle="Offer speech-to-text"
						tool="transcribe_audio"
						useProvider={useProvider}
					/>
				) : null}
			</div>

			{sttOn ? (
				<>
					<DebouncedTextField
						className="w-full"
						initialValue={stored.stt.baseUrl}
						onChange={(value) => saveStt({ baseUrl: value.trim() })}
						placeholder="http://127.0.0.1:8080">
						<span className="font-medium">Speech-to-text endpoint</span>
					</DebouncedTextField>
					<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
						Any server that speaks the OpenAI audio API. Cerebriline calls{" "}
						<code>POST &lt;endpoint&gt;/audio/transcriptions</code> and adds the <code>/v1</code> if you leave it off:
						opencoti or xOllama with a Whisper model, a whisper.cpp or faster-whisper server, or a hosted one. It may
						be started later — the tool is offered whether or not it answers now.
					</p>

					<DebouncedTextField
						className="w-full"
						initialValue=""
						onChange={(value) => void saveKey("audioSttApiKey", value)}
						placeholder={
							audioSttApiKeySet
								? "Stored — type to replace, clear to remove"
								: "Leave empty if the server needs none"
						}
						type="password">
						<span className="font-medium">API key</span>
					</DebouncedTextField>

					<div>
						<label className="font-medium text-sm block mb-1" htmlFor="audio-stt-model">
							Model
						</label>
						<OllamaModelPicker
							ollamaModels={sttModels}
							onModelChange={(value) => saveStt({ model: value.trim() })}
							placeholder="Search and select a speech-to-text model..."
							selectedModelId={stored.stt.model}
						/>
						<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
							{sttModels.length > 0
								? `${count(sttModels.length, "speech-to-text model")} listed${sttStatus.resolved?.source === "provider" ? " on the session's provider. Name one here when it has several." : " by this endpoint."}`
								: "No speech-to-text models were listed — type the name yourself; it is sent as given."}
						</p>
					</div>
				</>
			) : null}

			<div className="mt-2 pt-3 border-t border-(--vscode-panel-border)">
				<SettingsCheckbox checked={ttsOn} onChange={(checked) => saveTts({ disabled: !checked })}>
					Offer text-to-speech
				</SettingsCheckbox>
				<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
					Offers the <code>synthesize_speech</code> tool, which turns text into an audio file in the workspace. The file
					is named from what the engine returns, so asking for <code>mp3</code> from an engine that only encodes WAV
					gives a <code>.wav</code>.
				</p>
				{ttsOn ? (
					<MediaEndpointStatusLines
						lacks="no speech engine loaded"
						serves="synthesizes speech"
						status={ttsStatus}
						toggle="Offer text-to-speech"
						tool="synthesize_speech"
						useProvider={useProvider}
					/>
				) : null}
			</div>

			{ttsOn ? (
				<>
					<DebouncedTextField
						className="w-full"
						initialValue={stored.tts.baseUrl}
						onChange={(value) => saveTts({ baseUrl: value.trim() })}
						placeholder="http://127.0.0.1:8080">
						<span className="font-medium">Text-to-speech endpoint</span>
					</DebouncedTextField>
					<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
						Cerebriline calls <code>POST &lt;endpoint&gt;/audio/speech</code>. It can be the same server as above or
						another one, and like it may be started later.
					</p>

					<DebouncedTextField
						className="w-full"
						initialValue=""
						onChange={(value) => void saveKey("audioTtsApiKey", value)}
						placeholder={
							audioTtsApiKeySet
								? "Stored — type to replace, clear to remove"
								: "Leave empty if the server needs none"
						}
						type="password">
						<span className="font-medium">API key</span>
					</DebouncedTextField>
					<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
						Each key is sent as <code>Authorization: Bearer</code> to its own endpoint only, and kept in the editor's
						secret storage — which is why the fields look empty even when a key is stored.
					</p>

					<div>
						<label className="font-medium text-sm block mb-1" htmlFor="audio-tts-model">
							Model
						</label>
						<OllamaModelPicker
							ollamaModels={ttsModels}
							onModelChange={(value) => saveTts({ model: value.trim() })}
							placeholder="Search and select a speech model..."
							selectedModelId={stored.tts.model}
						/>
						<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
							{ttsModels.length > 0
								? `${count(ttsModels.length, "speech model")} listed${ttsStatus.resolved?.source === "provider" ? " on the session's provider. Name one here when it has several." : " by this endpoint."}`
								: "No speech models were listed — type the name yourself; it is sent as given."}
						</p>
					</div>

					<div>
						<label className="font-medium text-sm block mb-1" htmlFor="audio-tts-voice">
							Default voice
						</label>
						<OllamaModelPicker
							ollamaModels={voices?.voices ?? []}
							onFocus={() => void requestVoices()}
							onModelChange={(value) => saveTts({ voice: value.trim() })}
							placeholder="The engine's default"
							selectedModelId={stored.tts.voice ?? ""}
						/>
						<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
							Used when the model names no voice.{" "}
							{voices
								? `${count(voices.voices.length, "voice")} on this engine${voices.default ? `, default ${voices.default}` : ""}.`
								: "opencoti and xOllama list theirs when you open this field (xOllama starts the engine to answer); for any other server, type the name."}
						</p>
					</div>

					<DebouncedTextField
						className="w-full"
						initialValue={stored.tts.format ?? ""}
						onChange={(value) => saveTts({ format: value.trim().toLowerCase() })}
						placeholder="The engine's default">
						<span className="font-medium">Default format</span>
					</DebouncedTextField>
					<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
						Used when the model asks for none: <code>wav</code>, <code>mp3</code>, <code>flac</code>,{" "}
						<code>opus</code>.{" "}
						{voices && voices.formats.length > 0
							? `This engine encodes ${voices.formats.join(", ")}.`
							: "An engine that cannot encode the one asked for is asked again for its own default."}
					</p>
				</>
			) : null}
		</div>
	)
}

export default AudioTab

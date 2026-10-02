import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { parseVideoEndpoint, type VideoEndpointSettings } from "@shared/video-endpoint"
import { useCallback, useMemo } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { DebouncedTextField } from "./common/DebouncedTextField"
import { MediaEndpointStatusLines, mediaPickerModels, useMediaEndpointStatus } from "./common/MediaEndpointStatus"
import { SettingsCheckbox } from "./common/SettingsCheckbox"
import OllamaModelPicker from "./OllamaModelPicker"

/**
 * The video generation endpoint.
 *
 * An endpoint, like the Images and Audio tabs and for the same reason: what
 * `generate_video` needs is a URL, a key, a model name and the defaults a call
 * may leave out, not a second model in the conversation.
 */
const VideoTab = () => {
	const { videoEndpoint, videoApiKeySet } = useExtensionState()
	const stored = useMemo(() => parseVideoEndpoint(videoEndpoint), [videoEndpoint])
	const status = useMediaEndpointStatus("video", `${videoEndpoint}|${videoApiKeySet}`)

	const save = useCallback(
		async (patch: Partial<VideoEndpointSettings>) => {
			try {
				await StateServiceClient.updateSettings(
					UpdateSettingsRequest.create({ videoEndpoint: JSON.stringify({ ...stored, ...patch }) }),
				)
			} catch (error) {
				console.error("Failed to save the video endpoint:", error)
			}
		},
		[stored],
	)

	const saveApiKey = useCallback(async (value: string) => {
		try {
			await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ videoApiKey: value }))
		} catch (error) {
			console.error("Failed to save the video key:", error)
		}
	}, [])

	const useProvider = stored.useProvider === true
	const models = mediaPickerModels(status)
	const onProvider = status.resolved?.source === "provider"

	return (
		<div className="flex flex-col gap-3">
			<div>
				<SettingsCheckbox checked={useProvider} onChange={(checked) => void save({ useProvider: checked })}>
					Use the session's opencoti or xOllama provider when it generates video
				</SettingsCheckbox>
				<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
					One opencoti can serve the chat model and a video engine. With this ticked, a session running on such a
					provider renders clips there and the endpoint below is the fallback: it is used when the session runs on
					anything else, or on a server that has no video engine.
				</p>
				<MediaEndpointStatusLines
					lacks="no video engine loaded"
					serves="generates video"
					status={status}
					toggle="Use an endpoint for video generation"
					tool="generate_video"
					useProvider={useProvider}
				/>
			</div>

			<DebouncedTextField
				className="w-full"
				initialValue={stored.baseUrl}
				onChange={(value) => void save({ baseUrl: value.trim() })}
				placeholder="http://127.0.0.1:8080">
				<span className="font-medium">Endpoint</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				Any server that speaks the OpenAI videos API. Cerebriline calls <code>POST &lt;endpoint&gt;/videos</code>, asks{" "}
				<code>GET &lt;endpoint&gt;/videos/&lt;id&gt;</code> until the clip is done, then downloads it, and adds the{" "}
				<code>/v1</code> if you leave it off. It may be started later — the tool is offered whether or not it answers now.
			</p>

			<DebouncedTextField
				className="w-full"
				initialValue=""
				onChange={(value) => void saveApiKey(value)}
				placeholder={
					videoApiKeySet ? "Stored — type to replace, clear to remove" : "Leave empty if the server needs none"
				}
				type="password">
				<span className="font-medium">API key</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				Sent as <code>Authorization: Bearer</code>. Kept in the editor's secret storage and never sent back to this panel
				— which is why the field looks empty even when a key is stored.
			</p>

			<div>
				<label className="font-medium text-sm block mb-1" htmlFor="video-model">
					Model
				</label>
				<OllamaModelPicker
					ollamaModels={models}
					onModelChange={(value) => void save({ model: value.trim() })}
					placeholder="Search and select a video model..."
					selectedModelId={stored.model}
				/>
				<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
					{models.length > 0
						? `${models.length} video model${models.length === 1 ? "" : "s"} listed${onProvider ? " on the session's provider. Name one here when it has several." : " by this endpoint."}`
						: "No video models were listed — type the name yourself; it is sent as given."}
				</p>
			</div>

			<DebouncedTextField
				className="w-full"
				initialValue={stored.size ?? ""}
				onChange={(value) => void save({ size: value.trim() })}
				placeholder="832x480">
				<span className="font-medium">Default size</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				Used when the model does not ask for one, as <code>WIDTHxHEIGHT</code>. Leave empty for the engine's own. Video
				models support only a few shapes, and memory grows quickly with size.
			</p>

			<DebouncedTextField
				className="w-full"
				initialValue={stored.seconds ? String(stored.seconds) : ""}
				onChange={(value) => {
					const seconds = Number(value.trim())
					void save({ seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined })
				}}
				placeholder="The engine's default">
				<span className="font-medium">Default length (seconds)</span>
			</DebouncedTextField>

			<DebouncedTextField
				className="w-full"
				initialValue={stored.format ?? ""}
				onChange={(value) => void save({ format: value.trim().toLowerCase() })}
				placeholder="The engine's default">
				<span className="font-medium">Format</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				The container to ask for, such as <code>mp4</code>. An engine that cannot write it is asked again for its own
				default, and the file is named from what comes back.
			</p>
		</div>
	)
}

export default VideoTab

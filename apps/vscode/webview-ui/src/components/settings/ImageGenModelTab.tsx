import { StringRequest } from "@shared/proto/cline/common"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient, StateServiceClient } from "@/services/grpc-client"
import { DebouncedTextField } from "./common/DebouncedTextField"
import OllamaModelPicker from "./OllamaModelPicker"

/** What is stored, as the settings view holds it. The key is not in here. */
interface StoredEndpoint {
	baseUrl: string
	model: string
	size?: string
}

function parseStored(raw: string): StoredEndpoint {
	if (!raw) {
		return { baseUrl: "", model: "" }
	}
	try {
		const parsed = JSON.parse(raw) as Partial<StoredEndpoint>
		return {
			baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
			model: typeof parsed.model === "string" ? parsed.model : "",
			...(typeof parsed.size === "string" && parsed.size ? { size: parsed.size } : {}),
		}
	} catch {
		return { baseUrl: "", model: "" }
	}
}

/**
 * The image generation endpoint.
 *
 * The odd one among the tabs, and worth saying why it is one at all: what is
 * configured here is not a second model in the conversation, it is a second
 * *endpoint* — `generate_image` posts to `<base>/images/generations` and needs
 * a URL, a key, a model name and a size. So this is not a `ScopedModelTab`: the
 * provider list a scope snapshot carries has no image models in it, and picking
 * "Anthropic" here would mean nothing.
 *
 * The model field is a picker over what the endpoint itself reports, the way
 * the Ollama one is, because these catalogues are long and the names are not
 * guessable: pollinations.ai lists 388 models, 36 of which draw. Typing a name
 * the list does not have still works — a server that answers no listing is
 * still a server that generates.
 */
const ImageGenModelTab = () => {
	const { imageGenEndpoint, imageGenApiKeySet } = useExtensionState()
	const stored = useMemo(() => parseStored(imageGenEndpoint), [imageGenEndpoint])
	const [models, setModels] = useState<string[]>([])

	const save = useCallback(
		async (patch: Partial<StoredEndpoint>) => {
			const next = { ...stored, ...patch }
			try {
				await StateServiceClient.updateSettings(
					UpdateSettingsRequest.create({
						imageGenEndpoint: JSON.stringify({
							baseUrl: next.baseUrl,
							model: next.model,
							...(next.size ? { size: next.size } : {}),
						}),
					}),
				)
			} catch (error) {
				console.error("Failed to save the image generation endpoint:", error)
			}
		},
		[stored],
	)

	const saveApiKey = useCallback(async (value: string) => {
		try {
			await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ imageGenApiKey: value }))
		} catch (error) {
			console.error("Failed to save the image generation key:", error)
		}
	}, [])

	// Fetched when the base URL changes and on focus of the picker, never on an
	// interval: the URL is user-configurable, so an unbounded poll can hammer a
	// metered endpoint for as long as this pane is open.
	const requestModels = useCallback(async () => {
		if (!stored.baseUrl.trim()) {
			setModels([])
			return
		}
		try {
			const response = await ModelsServiceClient.getImageGenerationModels(StringRequest.create({ value: stored.baseUrl }))
			setModels(response?.values ?? [])
		} catch (error) {
			console.error("Failed to fetch image models:", error)
			setModels([])
		}
	}, [stored.baseUrl])

	useEffect(() => {
		void requestModels()
	}, [requestModels])

	return (
		<div className="flex flex-col gap-3">
			<DebouncedTextField
				className="w-full"
				initialValue={stored.baseUrl}
				onChange={(value) => void save({ baseUrl: value })}
				placeholder="https://gen.pollinations.ai">
				<span className="font-medium">Endpoint</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				Any server that speaks the OpenAI images API. Cline calls <code>POST &lt;endpoint&gt;/images/generations</code>{" "}
				and adds the <code>/v1</code> if you leave it off. A local LocalAI, ComfyUI or Automatic1111 shim, or a hosted one
				— <VSCodeLink href="https://gen.pollinations.ai/docs">pollinations.ai</VSCodeLink>, OpenAI itself.
			</p>

			<DebouncedTextField
				className="w-full"
				initialValue=""
				onChange={(value) => void saveApiKey(value)}
				placeholder={
					imageGenApiKeySet ? "Stored — type to replace, clear to remove" : "Leave empty if the server needs none"
				}
				type="password">
				<span className="font-medium">API key</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				Sent as <code>Authorization: Bearer</code>. Kept in the editor's secret storage, never in a settings file and
				never sent back to this panel — which is why the field looks empty even when a key is stored.
			</p>

			<div>
				<label className="font-medium text-sm block mb-1" htmlFor="image-gen-model">
					Model
				</label>
				<OllamaModelPicker
					ollamaModels={models}
					onFocus={() => void requestModels()}
					onModelChange={(value) => void save({ model: value })}
					placeholder="Search and select an image model..."
					selectedModelId={stored.model}
				/>
				<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
					{models.length > 0
						? `${models.length} image model${models.length === 1 ? "" : "s"} offered by this endpoint.`
						: "This endpoint reported no image models — type the name yourself; it is sent as given."}
				</p>
			</div>

			<DebouncedTextField
				className="w-full"
				initialValue={stored.size ?? ""}
				onChange={(value) => void save({ size: value.trim() })}
				placeholder="1024x1024">
				<span className="font-medium">Default size</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				Used when the model does not ask for one, as <code>WIDTHxHEIGHT</code>. Leave empty to let the backend choose, and
				expect it to round whatever you give it to a shape it supports.
			</p>
		</div>
	)
}

export default ImageGenModelTab

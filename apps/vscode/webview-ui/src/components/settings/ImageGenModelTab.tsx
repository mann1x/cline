import { type MediaEndpointStatus, parseMediaEndpointStatus } from "@shared/media-endpoint-status"
import { StringRequest } from "@shared/proto/cline/common"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient, StateServiceClient } from "@/services/grpc-client"
import { DebouncedTextField } from "./common/DebouncedTextField"
import { SettingsCheckbox } from "./common/SettingsCheckbox"
import OllamaModelPicker from "./OllamaModelPicker"

/** What is stored, as the settings view holds it. The key is not in here. */
interface StoredEndpoint {
	baseUrl: string
	model: string
	size?: string
	/** Use the session's own opencoti or xOllama when it generates images. */
	useProvider?: boolean
}

const SERVER_NAMES = { opencoti: "opencoti", xollama: "xOllama", openai: "OpenAI-compatible" } as const

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
			...(parsed.useProvider === true ? { useProvider: true } : {}),
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
	const [status, setStatus] = useState<MediaEndpointStatus>({})

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
							...(next.useProvider ? { useProvider: true } : {}),
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

	// What the next session will do with this tab, asked of the host: it holds
	// the session provider's key and can ask each server what it serves. Asked
	// again whenever what is stored changes, never on an interval.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the stored record is the trigger, not an input
	useEffect(() => {
		let current = true
		ModelsServiceClient.readMediaEndpoint(StringRequest.create({ value: "image_generation" }))
			.then((response) => {
				if (current) {
					setStatus(parseMediaEndpointStatus(response?.value))
				}
			})
			.catch((error) => console.error("Failed to read the image endpoint status:", error))
		return () => {
			current = false
		}
	}, [imageGenEndpoint, imageGenApiKeySet])

	const onProvider = status.resolved?.source === "provider"
	const pickerModels = onProvider ? (status.provider?.models ?? []) : models

	return (
		<div className="flex flex-col gap-3">
			<div>
				<SettingsCheckbox
					checked={stored.useProvider === true}
					onChange={(checked) => void save({ useProvider: checked })}>
					Use the session's opencoti or xOllama provider when it generates images
				</SettingsCheckbox>
				<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
					One opencoti can serve the chat model and every media engine, and an xOllama model can carry them. With this
					ticked, a session running on such a provider generates images there and the endpoint below is the fallback: it
					is used when the session runs on anything else, or on a server that has no image engine.
				</p>
				{stored.useProvider && status.provider ? (
					<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
						{status.provider.serves
							? `The current provider is ${SERVER_NAMES[status.provider.server]} and generates images.`
							: status.provider.server === "openai"
								? "The current provider is neither opencoti nor xOllama, so the endpoint below is used."
								: `The current provider is ${SERVER_NAMES[status.provider.server]} but has no image engine loaded, so the endpoint below is used.`}
					</p>
				) : null}
				{status.resolved ? (
					<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
						<code>generate_image</code> goes to{" "}
						{status.resolved.source === "provider" ? "the session's provider" : "the endpoint below"} (
						{SERVER_NAMES[status.resolved.server]}), model <code>{status.resolved.model}</code>.
					</p>
				) : status.disabled ? (
					<p className="text-xs mt-1 text-(--vscode-errorForeground)">
						<code>generate_image</code> is not offered: {status.disabled}.
					</p>
				) : null}
			</div>

			<DebouncedTextField
				className="w-full"
				initialValue={stored.baseUrl}
				onChange={(value) => void save({ baseUrl: value })}
				placeholder="https://gen.pollinations.ai">
				<span className="font-medium">Endpoint</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				Any server that speaks the OpenAI images API. Cerebriline calls{" "}
				<code>POST &lt;endpoint&gt;/images/generations</code> and adds the <code>/v1</code> if you leave it off. A local
				LocalAI, ComfyUI or Automatic1111 shim, or a hosted one —{" "}
				<VSCodeLink href="https://gen.pollinations.ai/docs">pollinations.ai</VSCodeLink>, OpenAI itself.
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
					ollamaModels={pickerModels}
					onFocus={() => void requestModels()}
					onModelChange={(value) => void save({ model: value })}
					placeholder="Search and select an image model..."
					selectedModelId={stored.model}
				/>
				<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
					{onProvider
						? `${pickerModels.length} image model${pickerModels.length === 1 ? "" : "s"} on the session's provider. Name one here when it has several.`
						: pickerModels.length > 0
							? `${pickerModels.length} image model${pickerModels.length === 1 ? "" : "s"} offered by this endpoint.`
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

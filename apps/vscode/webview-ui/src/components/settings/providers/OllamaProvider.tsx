import { openAiModelInfoSafeDefaults } from "@shared/api"
import { StringRequest } from "@shared/proto/cline/common"
import { fromProtobufModelOverrides } from "@shared/proto-conversions/models/modelOverrides"
import { Mode } from "@shared/storage/types"
import { VSCodeCheckbox, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useProviderConfig } from "@/hooks/useProviderConfig"
import { useProviderModelSelection } from "@/hooks/useProviderModelSelection"
import { ModelsServiceClient } from "@/services/grpc-client"
import { ApiKeyField } from "../common/ApiKeyField"
import { BaseUrlField } from "../common/BaseUrlField"
import { DebouncedTextField } from "../common/DebouncedTextField"
import OllamaModelPicker from "../OllamaModelPicker"
import { updateSetting } from "../utils/settingsHandlers"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"
import { useProviderApiKeyField } from "../utils/useProviderApiKeyField"

/**
 * Props for the OllamaProvider component
 */
interface OllamaProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

/**
 * Thinking levels offered for Ollama, in the order they escalate.
 *
 * `unset` is a real choice rather than a placeholder: it leaves the request
 * without an effort so the vendor's own default applies, which is what a user
 * who wants thinking on but has no opinion about how much actually means.
 * The rest are the levels Ollama itself accepts, `xhigh` being the name the AI
 * SDK gives Ollama's `max`.
 */
const OLLAMA_THINKING_LEVELS = ["unset", "minimal", "low", "medium", "high", "xhigh"] as const

/**
 * Placeholder text only. The real defaults live in the SDK
 * (`DEFAULT_MAX_TOOL_RESULT_CHARS`, `DEFAULT_GATEWAY_MAX_OUTPUT_TOKENS`);
 * the webview cannot import them, so these say what they are worth: a hint.
 */
const DEFAULT_TOOL_RESULT_CHARS_HINT = 32000
const DEFAULT_MAX_OUTPUT_TOKENS_HINT = 32000

type OllamaThinkingLevel = (typeof OLLAMA_THINKING_LEVELS)[number]

const OLLAMA_THINKING_LEVEL_LABELS: Record<OllamaThinkingLevel, string> = {
	unset: "Default (provider decides)",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Max",
}

/**
 * The Ollama provider configuration component
 */
export const OllamaProvider = ({ showModelOptions, isPopup, currentMode }: OllamaProviderProps) => {
	const { apiConfiguration, maxToolResultChars } = useExtensionState()
	const { handleFieldChange } = useApiConfigurationHandlers()
	const { config, write, commitSelection } = useProviderConfig("ollama")

	const [ollamaModels, setOllamaModels] = useState<string[]>([])

	const ollamaBaseUrl = config?.baseUrl ?? apiConfiguration?.ollamaBaseUrl
	// providers.json (config.contextWindow) is the source of truth; the legacy
	// apiConfiguration string is a migration fallback.
	const ollamaNumCtx = config?.contextWindow || Number.parseInt(apiConfiguration?.ollamaApiOptionsCtxNum || "", 10)
	const ollamaModelInfo = useMemo(() => {
		return {
			...openAiModelInfoSafeDefaults,
			...(Number.isFinite(ollamaNumCtx) && ollamaNumCtx > 0 ? { contextWindow: ollamaNumCtx } : {}),
		}
	}, [ollamaNumCtx])
	const ollamaModelInfoById = useMemo(
		() => Object.fromEntries(ollamaModels.map((modelId) => [modelId, { ...ollamaModelInfo, name: modelId }])),
		[ollamaModelInfo, ollamaModels],
	)
	const { committedSelection, selectedModel, commitModelSelection } = useProviderModelSelection("ollama", currentMode, {
		models: ollamaModelInfoById,
		config,
		commitSelection,
		fallbackModelInfo: ollamaModelInfo,
		customModelInfo: (modelId) => ({ ...ollamaModelInfo, name: modelId }),
	})
	// The committed per-model overrides, so the panel can show the value it is
	// about to replace and carry the other overrides across when it writes.
	const committedOverrides = useMemo(
		() => fromProtobufModelOverrides(committedSelection?.overrides),
		[committedSelection?.overrides],
	)
	const committedMaxTokens =
		typeof committedOverrides?.maxTokens === "number" && committedOverrides.maxTokens > 0
			? committedOverrides.maxTokens
			: undefined

	const { savedApiKeyMask, handleApiKeyChange } = useProviderApiKeyField({
		apiKeyLength: config?.apiKeyLength,
		providerName: "Ollama",
		write,
	})

	const handleBaseUrlChange = useCallback(
		(value: string) => {
			void write({ baseUrl: value }).catch((error) => console.error("Failed to update Ollama base URL:", error))
		},
		[write],
	)
	const handleBaseUrlClear = useCallback(async () => {
		try {
			await write({ baseUrl: "" })
		} catch (error) {
			console.error("Failed to clear Ollama base URL:", error)
			throw error
		}
	}, [write])

	// Thinking is stored on the provider config rather than per mode: it
	// describes what the local model is asked to do, not how a task is run.
	const thinkingEnabled = config?.reasoning?.enabled === true
	const thinkingLevel: OllamaThinkingLevel =
		config?.reasoning?.effort && (OLLAMA_THINKING_LEVELS as readonly string[]).includes(config.reasoning.effort)
			? (config.reasoning.effort as OllamaThinkingLevel)
			: "unset"

	const handleThinkingEnabledChange = useCallback(
		(enabled: boolean) => {
			// Clearing the effort alongside a disable keeps the two coherent:
			// a stored level that cannot apply reads as though it does.
			void write({ reasoning: { enabled, effort: enabled ? (config?.reasoning?.effort ?? undefined) : undefined } }).catch(
				(error) => console.error("Failed to update Ollama thinking:", error),
			)
		},
		[write, config?.reasoning?.effort],
	)

	const handleThinkingLevelChange = useCallback(
		(level: OllamaThinkingLevel) => {
			void write({ reasoning: { enabled: true, effort: level === "unset" ? undefined : level } }).catch((error) =>
				console.error("Failed to update Ollama thinking level:", error),
			)
		},
		[write],
	)

	// Fetch ollama models on mount and whenever the base URL changes. The
	// picker also refetches on focus — do NOT poll on an interval: the base
	// URL is user-configurable, so an unbounded poll can hammer a remote or
	// metered endpoint for as long as the settings pane is open (ENG-2344).
	const requestOllamaModels = useCallback(async () => {
		try {
			const response = await ModelsServiceClient.getOllamaModels(
				StringRequest.create({
					value: ollamaBaseUrl || "",
				}),
			)
			if (response && response.values) {
				setOllamaModels(response.values)
			}
		} catch (error) {
			console.error("Failed to fetch Ollama models:", error)
			setOllamaModels([])
		}
	}, [ollamaBaseUrl])

	useEffect(() => {
		requestOllamaModels()
	}, [requestOllamaModels])

	return (
		<div className="flex flex-col gap-2">
			<BaseUrlField
				initialValue={ollamaBaseUrl}
				label="Use custom base URL"
				onChange={handleBaseUrlChange}
				onClear={handleBaseUrlClear}
				placeholder="Default: http://localhost:11434"
			/>

			{ollamaBaseUrl && (
				<ApiKeyField
					helpText="Optional API key for authenticated Ollama instances or cloud services. Leave empty for local installations."
					initialValue={savedApiKeyMask}
					onChange={handleApiKeyChange}
					placeholder="Enter API Key (optional)..."
					providerName="Ollama"
				/>
			)}

			{/* Model selection - use filterable picker */}
			<label htmlFor="ollama-model-selection">
				<span className="font-semibold">Model</span>
			</label>
			<OllamaModelPicker
				ollamaModels={ollamaModels}
				onFocus={requestOllamaModels}
				onModelChange={(modelId) => {
					const trimmedModelId = modelId.trim()
					if (!trimmedModelId) {
						return
					}
					void commitModelSelection({
						modelId: trimmedModelId,
						modelInfo: { ...ollamaModelInfo, name: trimmedModelId },
					}).catch((error) => console.error("Failed to update Ollama model selection:", error))
				}}
				placeholder={ollamaModels.length > 0 ? "Search and select a model..." : "e.g. llama3.1"}
				selectedModelId={selectedModel.modelId || ""}
			/>

			{/* Thinking. Rendered only once the provider config has resolved, for
			    the same reason as the context-window field below: mounting
			    against an unloaded config would show "off" for a provider that
			    has thinking enabled. */}
			{config !== undefined && (
				<div className="flex flex-col gap-1">
					<VSCodeCheckbox
						checked={thinkingEnabled}
						onChange={(event) => handleThinkingEnabledChange((event.target as HTMLInputElement).checked)}>
						Enable thinking
					</VSCodeCheckbox>
					<p className="text-xs mt-0 mb-1 text-description">
						Asks the model to think in its own reasoning channel instead of into its answer. On a reasoning model this
						also lets Ollama bound how much of a reply is spent thinking.
					</p>
					{thinkingEnabled && (
						<div className="mb-1">
							<Label className="text-xs font-medium">Thinking level</Label>
							<Select
								onValueChange={(value) => handleThinkingLevelChange(value as OllamaThinkingLevel)}
								value={thinkingLevel}>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{OLLAMA_THINKING_LEVELS.map((level) => (
										<SelectItem key={level} value={level}>
											{OLLAMA_THINKING_LEVEL_LABELS[level]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="text-xs mt-1 mb-0 text-description">
								Higher levels let the model think for longer before answering, leaving less of the reply for the
								answer itself.
							</p>
						</div>
					)}
				</div>
			)}

			{/* Show status message based on model availability */}
			{ollamaModels.length === 0 && (
				<p className="text-sm mt-1 text-description italic">
					Unable to fetch models from Ollama server. Please ensure Ollama is running and accessible, or enter the model
					ID manually above.
				</p>
			)}

			{/* Render only after the provider config RPC has resolved: the
			    debounced input fires onChange for its initial value shortly
			    after mount, so mounting before `config` loads would persist
			    the 32768 fallback over a value saved in providers.json. */}
			{config !== undefined && (
				<DebouncedTextField
					initialValue={Number.isFinite(ollamaNumCtx) && ollamaNumCtx > 0 ? String(ollamaNumCtx) : ""}
					onChange={(v) => {
						const contextWindow = Number.parseInt(v, 10)
						const numCtx = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined
						// The debounced input also fires for its initial value and
						// external prop syncs — only persist actual changes.
						const currentNumCtx = Number.isFinite(ollamaNumCtx) && ollamaNumCtx > 0 ? ollamaNumCtx : undefined
						if (numCtx === currentNumCtx) {
							return
						}
						// Persist to providers.json (`contextWindow`); the store
						// mirrors the value to the legacy state key for older
						// readers. Zero clears the setting.
						void write({ contextWindow: numCtx ?? 0 }).catch((error) =>
							console.error("Failed to update Ollama context window:", error),
						)

						if (selectedModel.modelId) {
							void commitModelSelection({
								modelId: selectedModel.modelId,
								modelInfo: {
									...openAiModelInfoSafeDefaults,
									name: selectedModel.modelId,
									...(numCtx ? { contextWindow: numCtx } : {}),
								},
							}).catch((error) => console.error("Failed to update Ollama context window:", error))
						}
					}}
					placeholder={"Default: 32768"}
					style={{ width: "100%" }}>
					<span className="font-semibold">Model Context Window</span>
				</DebouncedTextField>
			)}

			{/* The two budgets that decide how much of the context window the
			    session is allowed to spend, sitting under the window itself
			    because that is the number they are read against. */}
			{config !== undefined && (
				<>
					<DebouncedTextField
						initialValue={maxToolResultChars ? String(maxToolResultChars) : ""}
						onChange={(v) => {
							const parsed = Number.parseInt(v, 10)
							const next = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
							// The debounced input also fires for its initial value.
							if (next === (maxToolResultChars ?? 0)) {
								return
							}
							updateSetting("maxToolResultChars", next)
						}}
						placeholder={`Default: ${DEFAULT_TOOL_RESULT_CHARS_HINT}`}
						style={{ width: "100%" }}>
						<span className="font-semibold">Tool Results Character Cap</span>
					</DebouncedTextField>
					<p className="text-xs mt-0 text-description">
						How much of a single tool result reaches the model. Anything longer keeps its start and its end and loses
						the middle, with a note saying Cline removed it. Applies to every provider. Blank restores the default.
					</p>

					<DebouncedTextField
						initialValue={committedMaxTokens ? String(committedMaxTokens) : ""}
						onChange={(v) => {
							const parsed = Number.parseInt(v, 10)
							const requested = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
							// A reply cannot be longer than the window it has to
							// fit in, so clamp rather than accept a number the
							// gateway would silently reduce anyway.
							const next =
								requested !== undefined && Number.isFinite(ollamaNumCtx) && ollamaNumCtx > 0
									? Math.min(requested, ollamaNumCtx)
									: requested
							if (next === committedMaxTokens || !selectedModel.modelId) {
								return
							}
							// Overrides replace wholesale, so carry the rest of
							// them across; dropping maxTokens from an otherwise
							// empty set clears the entry, which is the intent.
							const { maxTokens: _replaced, ...rest } = committedOverrides ?? {}
							void commitModelSelection({
								modelId: selectedModel.modelId,
								overrides: { ...rest, ...(next !== undefined ? { maxTokens: next } : {}) },
							}).catch((error) => console.error("Failed to update Ollama per-turn output cap:", error))
						}}
						placeholder={`Default: ${DEFAULT_MAX_OUTPUT_TOKENS_HINT}`}
						style={{ width: "100%" }}>
						<span className="font-semibold">Per-Turn Max Output Tokens</span>
					</DebouncedTextField>
					<p className="text-xs mt-0 text-description">
						The cap on one reply — Ollama's <code>num_predict</code>. The system prompt tells the model this number,
						so it is also what the model believes it has to work with. Clamped to the context window. Blank restores
						the default. A raw <code>num_predict</code> in the provider's sampling options, if one is set, overrides
						this.
					</p>
				</>
			)}

			{showModelOptions && (
				<>
					<DebouncedTextField
						initialValue={
							apiConfiguration?.requestTimeoutMs ? apiConfiguration.requestTimeoutMs.toString() : "300000"
						}
						onChange={(value) => {
							// Convert to number, with validation
							const numValue = Number.parseInt(value, 10)
							if (!Number.isNaN(numValue) && numValue > 0) {
								handleFieldChange("requestTimeoutMs", numValue)
							}
						}}
						placeholder="Default: 300000 (5 minutes)"
						style={{ width: "100%" }}>
						<span className="font-semibold">Request Timeout (ms)</span>
					</DebouncedTextField>
					<p className="text-xs mt-0 text-description">
						Maximum time in milliseconds to wait for API responses before timing out.
					</p>
				</>
			)}

			<p
				style={{
					fontSize: "12px",
					marginTop: "5px",
					color: "var(--vscode-descriptionForeground)",
				}}>
				Ollama allows you to run models locally on your computer. For instructions on how to get started, see their{" "}
				<VSCodeLink
					href="https://github.com/ollama/ollama/blob/main/README.md"
					style={{ display: "inline", fontSize: "inherit" }}>
					quickstart guide.
				</VSCodeLink>{" "}
				<span style={{ color: "var(--vscode-errorForeground)" }}>
					(<span style={{ fontWeight: 500 }}>Note:</span> Cline uses complex prompts, so behavior can vary across
					models. Less capable models may not work as expected.)
				</span>
			</p>
		</div>
	)
}

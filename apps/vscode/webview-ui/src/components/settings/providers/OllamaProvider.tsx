import { openAiModelInfoSafeDefaults } from "@shared/api"
import { StringRequest } from "@shared/proto/cline/common"
import type { ProviderSamplingPatch } from "@shared/proto/cline/models"
import { OllamaModelParametersRequest } from "@shared/proto/cline/models"
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
import { DebouncedTextArea } from "../common/DebouncedTextArea"
import { DebouncedTextField } from "../common/DebouncedTextField"
import OllamaModelPicker from "../OllamaModelPicker"
import { useApiConfigurationScope } from "../utils/ApiConfigurationScopeContext"
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
 *
 * `custom` is the one entry that is not an effort at all: it stands for "no
 * effort, a `think_budget` instead". Keeping it in this list is what makes the
 * dropdown the single control -- the budget field used to sit separately under
 * the advanced parameters, where it looked like a second, competing way to say
 * the same thing, and nothing on screen said which of the two won.
 */
const OLLAMA_THINKING_LEVELS = ["unset", "minimal", "low", "medium", "high", "xhigh", "custom"] as const

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
	custom: "Custom (think_budget)",
}

/**
 * The sampling parameters Ollama accepts on `/api/chat`, in the order its API
 * docs list them.
 *
 * Every one is left blank by default, and blank means "not sent". That is the
 * whole design of this section: a local model carries its sampler in the
 * Modelfile, usually one that was measured against that quant, and a settings
 * screen that shipped defaults would quietly overwrite it the first time it was
 * opened. Only fields the user types are transmitted.
 */
const OLLAMA_SAMPLING_FIELDS = [
	{
		key: "temperature",
		label: "temperature",
		kind: "number",
		hint: "Randomness of the next-token choice. Lower is more deterministic.",
	},
	{ key: "topK", label: "top_k", kind: "integer", hint: "Sample from the K most likely tokens." },
	{ key: "topP", label: "top_p", kind: "number", hint: "Sample from the smallest set whose probabilities sum to P." },
	{ key: "minP", label: "min_p", kind: "number", hint: "Drop tokens below this fraction of the most likely one." },
	{ key: "typicalP", label: "typical_p", kind: "number", hint: "Locally typical sampling." },
	{
		key: "repeatLastN",
		label: "repeat_last_n",
		kind: "integer",
		hint: "How far back the repeat penalty looks. 0 disables it, -1 uses the whole context.",
	},
	{ key: "repeatPenalty", label: "repeat_penalty", kind: "number", hint: "Penalty applied within that window." },
	{
		key: "presencePenalty",
		label: "presence_penalty",
		kind: "number",
		hint: "Flat penalty for tokens already used, over the whole context.",
	},
	{
		key: "frequencyPenalty",
		label: "frequency_penalty",
		kind: "number",
		hint: "Penalty proportional to how often a token was used, over the whole context.",
	},
	{ key: "seed", label: "seed", kind: "integer", hint: "Fixes sampling for reproducible runs." },
	{
		key: "numPredict",
		label: "num_predict",
		kind: "integer",
		hint: "Maximum tokens to generate. -1 is unlimited.",
	},
	{ key: "numKeep", label: "num_keep", kind: "integer", hint: "Tokens kept from the prompt when the context is trimmed." },
] as const

type OllamaSamplingFieldKey = (typeof OLLAMA_SAMPLING_FIELDS)[number]["key"]

/** Placeholders are shown in a two-column grid in a sidebar; this is what fits. */
const SAMPLING_PLACEHOLDER_MAX_LENGTH = 48

/** Sampling values as the panel edits them: raw text, so a half-typed number survives a render. */
type SamplingDraft = Partial<Record<OllamaSamplingFieldKey | "stop" | "thinkBudget" | "thinkBudgetMessage", string>>

function parseSamplingNumber(raw: string | undefined, kind: "number" | "integer"): number | undefined {
	const trimmed = raw?.trim()
	if (!trimmed) {
		return undefined
	}
	const parsed = Number(trimmed)
	if (!Number.isFinite(parsed)) {
		return undefined
	}
	return kind === "integer" ? Math.trunc(parsed) : parsed
}

/**
 * The Ollama provider configuration component
 */
export const OllamaProvider = ({ showModelOptions, isPopup, currentMode }: OllamaProviderProps) => {
	const { apiConfiguration, maxToolResultChars } = useExtensionState()
	const { handleFieldChange } = useApiConfigurationHandlers()
	const { config, write, commitSelection } = useProviderConfig("ollama")
	const scope = useApiConfigurationScope()

	const [ollamaModels, setOllamaModels] = useState<string[]>([])

	const ollamaBaseUrl = config?.baseUrl ?? apiConfiguration?.ollamaBaseUrl
	// providers.json (config.contextWindow) is the source of truth; the legacy
	// apiConfiguration string is a migration fallback.
	//
	// For the unscoped panel only. `ollamaApiOptionsCtxNum` is a single global
	// key, so a scoped panel falling back to it shows — and then carries — the
	// number belonging to a model on another tab. That is what made the context
	// window behave like one setting shared by Plan/Act and Vision, reported as
	// "context window seems to be a global setting, and changing it on the vision
	// tab doesn't set it only for the vision tab". A scoped panel owns its own
	// entry, and an empty one means empty rather than "borrow the other model's".
	const legacyNumCtx = scope ? Number.NaN : Number.parseInt(apiConfiguration?.ollamaApiOptionsCtxNum || "", 10)
	const ollamaNumCtx = config?.contextWindow || legacyNumCtx
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
	// The level is derived from the two things that actually go on the wire
	// rather than stored a third time. An effort means that level; no effort but
	// a `think_budget` means Custom; neither means unset. Because the two are
	// mutually exclusive by construction, the dropdown cannot disagree with what
	// is sent -- which is what "the dropdown is the master" has to mean.
	const storedThinkBudget = typeof config?.sampling?.thinkBudget === "string" ? config.sampling.thinkBudget.trim() : ""
	const thinkingLevel: OllamaThinkingLevel =
		config?.reasoning?.effort && (OLLAMA_THINKING_LEVELS as readonly string[]).includes(config.reasoning.effort)
			? (config.reasoning.effort as OllamaThinkingLevel)
			: storedThinkBudget !== ""
				? "custom"
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

	// Sampling is edited as text and committed on blur: these are numbers a user
	// types digit by digit, and writing on every keystroke would persist "0." and
	// "1e" as settings.
	const [samplingExpanded, setSamplingExpanded] = useState(false)
	const [samplingDraft, setSamplingDraft] = useState<SamplingDraft>({})

	const storedSampling = config?.sampling
	// The stored values are the source of truth; the draft only holds what is
	// being typed right now, so a write from anywhere else still shows up.
	const samplingValue = useCallback(
		(key: OllamaSamplingFieldKey | "stop" | "thinkBudget" | "thinkBudgetMessage"): string => {
			const draft = samplingDraft[key]
			if (draft !== undefined) {
				return draft
			}
			if (!storedSampling) {
				return ""
			}
			if (key === "stop") {
				return (storedSampling.stop ?? []).join("\n")
			}
			const stored = storedSampling[key as keyof typeof storedSampling]
			return stored === undefined || stored === null ? "" : String(stored)
		},
		[samplingDraft, storedSampling],
	)

	const buildSamplingPatch = useCallback(
		(draft: SamplingDraft): ProviderSamplingPatch => {
			// The patch shape is the proto one, where `stop` is a plain repeated
			// field and therefore always present; every other parameter is
			// optional and stays absent when the user left it blank.
			const next: ProviderSamplingPatch = { stop: [] }
			for (const field of OLLAMA_SAMPLING_FIELDS) {
				const raw =
					draft[field.key] ?? (storedSampling?.[field.key] !== undefined ? String(storedSampling[field.key]) : "")
				const parsed = parseSamplingNumber(raw, field.kind)
				if (parsed !== undefined) {
					next[field.key] = parsed
				}
			}
			const stopRaw = draft.stop ?? (storedSampling?.stop ?? []).join("\n")
			const stop = stopRaw
				.split("\n")
				.map((entry) => entry.trim())
				.filter((entry) => entry !== "")
			next.stop = stop
			for (const key of ["thinkBudget", "thinkBudgetMessage"] as const) {
				const raw = (draft[key] ?? storedSampling?.[key] ?? "").trim()
				if (raw !== "") {
					next[key] = raw
				}
			}
			return next
		},
		[storedSampling],
	)

	const commitSampling = useCallback(
		(draft: SamplingDraft) => {
			// An empty object clears the section — the patch layer reads "no
			// parameters set" as a request to stop sending any.
			void write({ sampling: buildSamplingPatch(draft) }).catch((error) =>
				console.error("Failed to update Ollama sampling:", error),
			)
		},
		[write, buildSamplingPatch],
	)

	const handleThinkingLevelChange = useCallback(
		(level: OllamaThinkingLevel) => {
			// Choosing a level clears `think_budget`, in the same write that sets
			// the effort. Leaving it stored would leave two live answers to one
			// question, and the user's rule is that the dropdown decides: a budget
			// left over from an earlier Custom must not quietly outrank the level
			// now on screen. Custom is the only setting that keeps one.
			const patch =
				level === "custom"
					? { reasoning: { enabled: true, effort: undefined } }
					: {
							reasoning: { enabled: true, effort: level === "unset" ? undefined : level },
							sampling: buildSamplingPatch({ thinkBudget: "" }),
						}
			void write(patch).catch((error) => console.error("Failed to update Ollama thinking level:", error))
		},
		[write, buildSamplingPatch],
	)

	const handleSamplingChange = useCallback(
		(key: OllamaSamplingFieldKey | "stop" | "thinkBudget" | "thinkBudgetMessage", value: string) => {
			setSamplingDraft((current) => ({ ...current, [key]: value }))
		},
		[],
	)

	const handleSamplingCommit = useCallback(() => {
		setSamplingDraft((current) => {
			commitSampling(current)
			return {}
		})
	}, [commitSampling])

	const handleSamplingReset = useCallback(() => {
		setSamplingDraft({})
		// An empty patch is how the section is cleared: no parameter set means
		// nothing to send, which the write path stores as no sampling at all.
		void write({ sampling: { stop: [] } }).catch((error) => console.error("Failed to clear Ollama sampling:", error))
	}, [write])

	const samplingCount = useMemo(() => {
		if (!storedSampling) {
			return 0
		}
		return Object.entries(storedSampling).filter(([, value]) =>
			Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "",
		).length
	}, [storedSampling])

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

	// What the selected model's own Modelfile sets, so a blank field can say
	// which value it is leaving in force instead of only that it is leaving one.
	const [modelParameters, setModelParameters] = useState<Record<string, string>>({})
	const selectedModelId = selectedModel.modelId

	useEffect(() => {
		if (!selectedModelId) {
			setModelParameters({})
			return
		}
		let cancelled = false
		void ModelsServiceClient.getOllamaModelParameters(
			OllamaModelParametersRequest.create({ baseUrl: ollamaBaseUrl || "", modelId: selectedModelId }),
		)
			.then((response) => {
				if (!cancelled) {
					setModelParameters(response?.parameters ?? {})
				}
			})
			.catch(() => {
				// Placeholder text only: an Ollama that is not reachable leaves the
				// fields reading "model default", which is what they said before.
				if (!cancelled) {
					setModelParameters({})
				}
			})
		return () => {
			cancelled = true
		}
	}, [ollamaBaseUrl, selectedModelId])

	/**
	 * Placeholder for a sampling field the user has not filled in.
	 *
	 * Named by Ollama's own spelling, which is what the labels already are. When
	 * the model sets the parameter its value is shown; when it does not, the
	 * field falls back to saying the default is out of our hands.
	 *
	 * Shortened for display because not every parameter is a number: measured on
	 * `v7-coder_tb:vision-iq4_nl`, `think_budget_message` is three paragraphs,
	 * and a placeholder that long buries the field it belongs to.
	 */
	const samplingPlaceholder = useCallback(
		(name: string): string => {
			const value = modelParameters[name]
			if (value === undefined) {
				return "model default"
			}
			const collapsed = value.replace(/\s+/g, " ").trim()
			return collapsed.length > SAMPLING_PLACEHOLDER_MAX_LENGTH
				? `${collapsed.slice(0, SAMPLING_PLACEHOLDER_MAX_LENGTH - 1)}…`
				: collapsed
		},
		[modelParameters],
	)

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
							{thinkingLevel === "custom" && (
								<div className="mt-2">
									<DebouncedTextField
										className="w-full"
										initialValue={samplingValue("thinkBudget")}
										onChange={(value: string) => {
											handleSamplingChange("thinkBudget", value)
											handleSamplingCommit()
										}}
										placeholder={samplingPlaceholder("think_budget")}>
										<span className="font-medium text-xs">think_budget</span>
									</DebouncedTextField>
									<p className="text-xs mt-1 mb-0 text-description">
										A token count, or an effort level (minimal / low / medium / high / max). Sent only while
										Custom is selected; picking any other level above clears it.
									</p>
								</div>
							)}
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
						the default. Setting <code>num_predict</code> under Sampling overrides this.
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

			{/* Sampling. Collapsed by default: these are the model's own knobs and
			    most sessions never touch them, but when a model misbehaves they
			    are the only thing that changes its behaviour. */}
			{config !== undefined && (
				<div className="flex flex-col gap-1">
					<button
						aria-expanded={samplingExpanded}
						className="flex items-center gap-1 bg-transparent border-0 p-0 cursor-pointer text-left text-foreground"
						onClick={() => setSamplingExpanded((expanded) => !expanded)}
						type="button">
						<span className={`codicon codicon-chevron-${samplingExpanded ? "down" : "right"} text-xs`} />
						<span className="text-xs font-medium uppercase tracking-wider">Advanced</span>
						{samplingCount > 0 && (
							<span className="text-xs text-description">
								({samplingCount} sampling {samplingCount === 1 ? "parameter" : "parameters"} set)
							</span>
						)}
					</button>
					{samplingExpanded && (
						<div className="flex flex-col gap-2 mt-1">
							<p className="text-xs mt-0 mb-1 text-description">
								Sampling parameters sent with every request. Leave a field empty to not send it at all, which
								leaves whatever the model was built with in force — a Modelfile's own values are not overwritten
								by an empty field here. Anything you do set overrides the model's value for this provider. A
								greyed value is the one this model's Modelfile sets; fields reading “model default” are not set by
								the model either, and fall back to Ollama's own.
							</p>
							<div className="grid grid-cols-2 gap-2">
								{OLLAMA_SAMPLING_FIELDS.map((field) => (
									<div key={field.key}>
										<DebouncedTextField
											className="w-full"
											initialValue={samplingValue(field.key)}
											onChange={(value: string) => {
												handleSamplingChange(field.key, value)
												handleSamplingCommit()
											}}
											placeholder={samplingPlaceholder(field.label)}>
											<span className="font-medium text-xs">{field.label}</span>
										</DebouncedTextField>
										<p className="text-xs mt-0 mb-0 text-description">{field.hint}</p>
									</div>
								))}
							</div>
							<div>
								<DebouncedTextField
									className="w-full"
									initialValue={samplingValue("stop")}
									onChange={(value: string) => {
										handleSamplingChange("stop", value)
										handleSamplingCommit()
									}}
									placeholder={modelParameters.stop ? samplingPlaceholder("stop") : "one sequence per line"}>
									<span className="font-medium text-xs">stop</span>
								</DebouncedTextField>
								<p className="text-xs mt-0 mb-0 text-description">Sequences that end generation, one per line.</p>
							</div>
							<div>
								<DebouncedTextArea
									className="w-full"
									initialValue={samplingValue("thinkBudgetMessage")}
									onChange={(value: string) => {
										handleSamplingChange("thinkBudgetMessage", value)
										handleSamplingCommit()
									}}
									// The model's own message runs to several paragraphs, so
									// the placeholder is the whole of it rather than the
									// truncated one line the other fields use: this is the
									// value the user is deciding whether to replace.
									placeholder={modelParameters.think_budget_message ?? "the model's own message"}>
									<span className="font-medium text-xs">think_budget_message</span>
								</DebouncedTextArea>
								<p className="text-xs mt-0 mb-0 text-description">
									Written into the thinking block just before the closing tag is forced, so the model reads that
									it has to answer now rather than being cut off with no explanation.
								</p>
							</div>
							{samplingCount > 0 && (
								<VSCodeLink
									className="text-xs self-start"
									href="#"
									onClick={(event) => {
										event.preventDefault()
										handleSamplingReset()
									}}>
									Clear all sampling parameters
								</VSCodeLink>
							)}
						</div>
					)}
				</div>
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

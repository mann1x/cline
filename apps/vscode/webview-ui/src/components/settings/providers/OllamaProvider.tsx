import { openAiModelInfoSafeDefaults } from "@shared/api"
import { StringRequest } from "@shared/proto/cline/common"
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
import { ContextMinimumWarning } from "../common/ContextMinimumWarning"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { OllamaAccountStrip } from "../common/OllamaAccountStrip"
import { RequestTimingsToggle } from "../common/RequestTimingsToggle"
import { SamplingSection } from "../common/SamplingSection"
import { useSamplingWrite } from "../common/sampling-fields"
import { readStoredThinkingLevel } from "../common/ThinkingBudgetField"
import OllamaModelPicker from "../OllamaModelPicker"
import { useApiConfigurationScope } from "../utils/ApiConfigurationScopeContext"
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

/** The `think_budget` placeholder is shown in a sidebar; this is what fits. */
const SAMPLING_PLACEHOLDER_MAX_LENGTH = 48

/** The three numbers that are not sampling parameters but behave like them. */
type NumericFieldKey = "contextWindow" | "toolResultChars" | "maxTokens" | "requestTimeout"

/**
 * The Ollama provider configuration component
 */
export const OllamaProvider = ({ showModelOptions, isPopup, currentMode }: OllamaProviderProps) => {
	const { apiConfiguration, maxToolResultChars, activeApiConfigurationProfile } = useExtensionState()
	const { handleFieldChange } = useApiConfigurationHandlers()
	const { config, write, commitSelection } = useProviderConfig("ollama")
	// The sampler is written whole and two controls on this panel write it --
	// the thinking level clears `think_budget` as it sets an effort. The shared
	// hook is what keeps the second write composing from the first one rather
	// than from the copy it rendered with.
	const { sampling, composeAndWrite } = useSamplingWrite("ollama", "ollama")
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
	// This configuration's own window, and only its own — the same rule the cap
	// below follows, and the same fault it had. The legacy key is a migration
	// seed: it keeps an entry that predates providers.json resolving a window.
	// Rendered as the field's *value* it refilled a cleared box with the number
	// being erased, and the next write then saved the borrowed number as though
	// it had been chosen here. The reporter's log shows 110000 — a number in no
	// providers.json entry — arriving exactly that way during profile work.
	const scopedNumCtx = config?.contextWindow
	// What applies when the field is left blank: the size the model is described
	// at, and the ceiling a per-turn output cap is clamped to. It belongs in
	// those two places and in the placeholder, not in the box.
	const ollamaNumCtx = scopedNumCtx || legacyNumCtx
	// This configuration's tool-result cap, and only its own. The global setting
	// is what applies when this is blank, so it belongs in the placeholder:
	// rendered as the field's *value* it refilled the box with the very number
	// being erased, so clearing the cap to retype put 64000 straight back, and
	// the next write sent the borrowed number as though it had been chosen here.
	// Reported as "I still can't change from 64000", and as blank and 64000
	// marking the profile identically — which is what one value in two roles
	// looks like from the outside.
	const scopedToolResultChars = config?.maxToolResultChars
	// What the panel says will happen if this is left blank. A scoped tab has no
	// business naming the global one: its own model is the one being capped.
	const fallbackToolResultChars = scope ? undefined : maxToolResultChars
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
	// Custom is the exception: until a count is typed it stores nothing of its
	// own, so on disk it is indistinguishable from Default. The pick is
	// remembered here, and any stored answer outranks it.
	const storedThinkBudget = typeof sampling?.thinkBudget === "string" ? sampling.thinkBudget.trim() : ""
	const [customPicked, setCustomPicked] = useState(false)
	const thinkingLevel: OllamaThinkingLevel =
		readStoredThinkingLevel({ effort: config?.reasoning?.effort, thinkBudget: storedThinkBudget }) ??
		(customPicked ? "custom" : "unset")

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

	/**
	 * The same draft, for the three numbers above the sampling section.
	 *
	 * They have the sampling fields' problem and the tool-result cap has it
	 * twice over: clearing the box to retype writes a zero, a zero clears this
	 * configuration's own value, and the panel then borrows the global one and
	 * puts it straight back in the field. Reported as "I have it at 64000 and I
	 * cannot change it" — the field was refilling itself from the global faster
	 * than it could be typed into.
	 */
	const [numericDraft, setNumericDraft] = useState<Partial<Record<NumericFieldKey, string>>>({})
	/** What to show: what is being typed, or the stored value if nothing is. */
	const numericValue = useCallback(
		(key: NumericFieldKey, stored: string): string => numericDraft[key] ?? stored,
		[numericDraft],
	)
	const noteNumeric = useCallback((key: NumericFieldKey, value: string) => {
		setNumericDraft((current) => ({ ...current, [key]: value }))
	}, [])

	/** What is being typed into `think_budget`, which outlives the write. */
	const [thinkBudgetDraft, setThinkBudgetDraft] = useState<string | undefined>(undefined)
	const thinkBudgetValue = thinkBudgetDraft ?? storedThinkBudget
	const handleThinkBudgetChange = useCallback(
		(value: string) => {
			setThinkBudgetDraft(value)
			// Returned so the field's flush can be awaited.
			return composeAndWrite({ thinkBudget: value })
		},
		[composeAndWrite],
	)

	const handleThinkingLevelChange = useCallback(
		(level: OllamaThinkingLevel) => {
			// Choosing a level clears `think_budget`, in the same write that sets
			// the effort. Leaving it stored would leave two live answers to one
			// question, and the user's rule is that the dropdown decides: a budget
			// left over from an earlier Custom must not quietly outrank the level
			// now on screen. Custom is the only setting that keeps one.
			// "" rather than undefined for the two levels that mean "no level":
			// the store skips an undefined field, so it never cleared the stored
			// level and Default and Custom could not be selected at all.
			setCustomPicked(level === "custom")
			if (level === "custom") {
				void write({ reasoning: { enabled: true, effort: "" } }).catch((error) =>
					console.error("Failed to update Ollama thinking level:", error),
				)
				return
			}
			setThinkBudgetDraft(undefined)
			composeAndWrite({ thinkBudget: "" }, { reasoning: { enabled: true, effort: level === "unset" ? "" : level } })
		},
		[write, composeAndWrite],
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

	// What the selected model's own Modelfile sets, so a blank field can say
	// which value it is leaving in force instead of only that it is leaving one.
	const [modelParameters, setModelParameters] = useState<Record<string, string>>({})
	const selectedModelId = selectedModel.modelId

	// The draft belongs to the model, the tab it was typed on, and the profile it
	// was typed under. It survives a write, which is what makes a decimal
	// typeable, so something has to end it: without this, switching model or
	// scope would carry the previous one's half-typed numbers across and show
	// them as though they were stored.
	//
	// Loading a profile is the third way, and it was missing. A profile load
	// replaces providers.json wholesale — it is exactly the "write from
	// somewhere else" the draft is designed to ignore — so the panel went on
	// showing the sampler typed under the previous profile, and
	// the patch builder reads `draft[key] ?? stored[key]`, which carries every
	// drafted field into the next write and puts the old value back. Reported as
	// "I changed typical_p, updated the profile, switched to a profile without it
	// and it was still there". Switching model happened to cover most of it,
	// which is why it only shows when two profiles share a model.
	//
	// The sampler's own draft is discarded by the same three, through the
	// section's `resetKey`; these are the ones this panel still holds.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the draft is cleared because these changed, so they are the dependencies even though the body does not read them
	useEffect(() => {
		setNumericDraft({})
		setThinkBudgetDraft(undefined)
	}, [selectedModelId, scope, activeApiConfigurationProfile])

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

			{/* What the server says about the account and the selected model:
			    whether it is a cloud model at all, which plan it needs, and the
			    window and thinking settings its publisher states. All read;
			    none of it inferred from the model's name. */}
			<OllamaAccountStrip modelId={selectedModel.modelId || undefined} providerId="ollama" />

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
										initialValue={thinkBudgetValue}
										numeric
										onChange={handleThinkBudgetChange}
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
					initialValue={numericValue(
						"contextWindow",
						Number.isFinite(scopedNumCtx) && (scopedNumCtx ?? 0) > 0 ? String(scopedNumCtx) : "",
					)}
					numeric
					onChange={(v) => {
						noteNumeric("contextWindow", v)
						const contextWindow = Number.parseInt(v, 10)
						const numCtx = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined
						// The debounced input also fires for its initial value and
						// external prop syncs — only persist actual changes.
						// Against this configuration's own window, so that clearing
						// the box is a change even when a legacy key would fill it.
						const currentNumCtx = Number.isFinite(scopedNumCtx) && (scopedNumCtx ?? 0) > 0 ? scopedNumCtx : undefined
						if (numCtx === currentNumCtx) {
							return
						}
						// Persist to providers.json (`contextWindow`); the store
						// mirrors the value to the legacy state key for older
						// readers. Zero clears the setting.
						//
						// Sequenced, not fired together. These are two writes to
						// one providers.json entry: the second rebuilds the entry
						// from a fresh read, and `commitModelSelection` follows it
						// with a read that republishes the entry to every panel.
						// Issued side by side they raced, so the selection write
						// could rebuild from a record that did not have the new
						// context window in it yet and the republished entry put
						// the old number back on screen. That is the shape of
						// issue 67 -- the panel matched what was stored, so no
						// unsaved change was reported either -- and it was fixed
						// for the scoped tabs' writer without reaching here.
						void (async () => {
							await write({ contextWindow: numCtx ?? 0 })
							if (!selectedModel.modelId) {
								return
							}
							await commitModelSelection({
								modelId: selectedModel.modelId,
								modelInfo: {
									...openAiModelInfoSafeDefaults,
									name: selectedModel.modelId,
									...(numCtx ? { contextWindow: numCtx } : {}),
								},
							})
						})().catch((error) => console.error("Failed to update Ollama context window:", error))
					}}
					placeholder={`Default: ${Number.isFinite(legacyNumCtx) && legacyNumCtx > 0 ? legacyNumCtx : 32768}`}
					style={{ width: "100%" }}>
					<span className="font-semibold">Model Context Window</span>
				</DebouncedTextField>
			)}
			{/* Below the fixed price plus the output room a turn cannot fit.
			    Warned, not blocked: the value above still saves. The window
			    judged is the one the box shows, its placeholder when empty. */}
			{config !== undefined && (
				<ContextMinimumWarning
					contextWindow={
						Number.isFinite(scopedNumCtx) && (scopedNumCtx ?? 0) > 0
							? scopedNumCtx
							: Number.isFinite(legacyNumCtx) && legacyNumCtx > 0
								? legacyNumCtx
								: 32768
					}
					providerId="ollama"
				/>
			)}

			{/* The two budgets that decide how much of the context window the
			    session is allowed to spend, sitting under the window itself
			    because that is the number they are read against. */}
			{config !== undefined && (
				<>
					<DebouncedTextField
						initialValue={numericValue("toolResultChars", scopedToolResultChars ? String(scopedToolResultChars) : "")}
						numeric
						onChange={(v) => {
							noteNumeric("toolResultChars", v)
							const parsed = Number.parseInt(v, 10)
							const next = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
							// Against this configuration's own value, not the one
							// on screen: an unscoped panel with nothing set here
							// shows the global, and comparing against that made
							// typing the global's number a no-op — which is the
							// one way to pin it so a later change to the global
							// does not move it.
							if (next === (config?.maxToolResultChars ?? 0)) {
								return
							}
							// Written to this configuration rather than to the one
							// global setting. The cap is read against a context
							// window, and Plan, Act, Vision and Agents each have a
							// window of their own; one shared number meant a profile
							// with a 256k window and one with 8k had to agree. Zero
							// clears it, and the global setting decides again.
							// Returned so a boundary that flushes this field can wait.
							return write({ maxToolResultChars: next }).catch((error) =>
								console.error("Failed to update tool result cap:", error),
							)
						}}
						placeholder={`Default: ${fallbackToolResultChars ?? DEFAULT_TOOL_RESULT_CHARS_HINT}`}
						style={{ width: "100%" }}>
						<span className="font-semibold">Tool Results Character Cap</span>
					</DebouncedTextField>
					<p className="text-xs mt-0 text-description">
						How much of a single tool result reaches the model. Anything longer keeps its start and its end and loses
						the middle, with a note saying Cerebriline removed it. Belongs to this configuration, so a profile carries
						it and the Vision and Agents tabs each have their own. Blank falls back to the global setting.
					</p>

					<DebouncedTextField
						initialValue={numericValue("maxTokens", committedMaxTokens ? String(committedMaxTokens) : "")}
						numeric
						onChange={(v) => {
							noteNumeric("maxTokens", v)
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
							// Returned so a boundary that flushes this field can wait.
							return commitModelSelection({
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
						initialValue={numericValue(
							"requestTimeout",
							apiConfiguration?.requestTimeoutMs ? apiConfiguration.requestTimeoutMs.toString() : "300000",
						)}
						numeric
						onChange={(value) => {
							// The draft is what makes this editable at all: this
							// field falls back to "300000" when it holds nothing,
							// so emptying it to retype put 300000 straight back in
							// on the next render.
							noteNumeric("requestTimeout", value)
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

			{/* The sampler, shared with the OpenAI-compatible form so llama.cpp
			    and opencoti show the same fields under the same names. */}
			<SamplingSection
				dialect="ollama"
				footer={
					/* Ollama is one of the two engines that reports its own
					   timings, so the switch is offered where those numbers
					   come from -- it is a single global setting, not a
					   per-provider one. */
					<RequestTimingsToggle engineNote="Ollama also reports its own model load time and the split between reading the prompt and generating the answer, which are shown when you expand the line." />
				}
				modelParameters={modelParameters}
				providerId="ollama"
				resetKey={`${selectedModelId ?? ""}::${scope?.scopeKey ?? "session"}::${activeApiConfigurationProfile ?? ""}`}
				showThinkBudgetMessage
			/>

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
					(<span style={{ fontWeight: 500 }}>Note:</span> Cerebriline uses complex prompts, so behavior can vary across
					models. Less capable models may not work as expected.)
				</span>
			</p>
		</div>
	)
}

import type { ApiProvider } from "@shared/api"
import type { Mode } from "@shared/storage/types"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import Fuse from "fuse.js"
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react"
import styled from "styled-components"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PLATFORM_CONFIG, PlatformType } from "@/config/platform.config"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useDynamicProviderSelection } from "@/hooks/useDynamicProviderSelection"
import { useProviderListings } from "@/hooks/useProviderListings"
import { ClinePassHint } from "./ClinePassHint"
import { AgentWindowField } from "./common/AgentWindowField"
import { OutputBudgetField } from "./common/OutputBudgetField"
import ParallelSessionsField, { parallelSessionsDescription, useOpencotiEngineMode } from "./common/ParallelSessionsField"
import { PolykvSection } from "./common/PolykvSection"
import { ReasoningHistoryField } from "./common/ReasoningHistoryField"
import { ToolsSection } from "./common/ToolsSection"
import { OPENROUTER_MODEL_PICKER_Z_INDEX } from "./OpenRouterModelPicker"
import { AIhubmixProvider } from "./providers/AihubmixProvider"
import { AnthropicProvider } from "./providers/AnthropicProvider"
import { AskSageProvider } from "./providers/AskSageProvider"
import { BasetenProvider } from "./providers/BasetenProvider"
import { BedrockProvider } from "./providers/BedrockProvider"
import { ClaudeCodeProvider } from "./providers/ClaudeCodeProvider"
import { ClinePassProvider } from "./providers/ClinePassProvider"
import { ClineProvider } from "./providers/ClineProvider"
import { DifyProvider } from "./providers/DifyProvider"
import { GenericProviderSettings } from "./providers/GenericProviderSettings"
import { GroqProvider } from "./providers/GroqProvider"
import { HicapProvider } from "./providers/HicapProvider"
import { HuggingFaceProvider } from "./providers/HuggingFaceProvider"
import { LiteLlmProvider } from "./providers/LiteLlmProvider"
import { LMStudioProvider } from "./providers/LMStudioProvider"
import { MoonshotProvider } from "./providers/MoonshotProvider"
import { OcaProvider } from "./providers/OcaProvider"
import { OllamaProvider } from "./providers/OllamaProvider"
import { OpenAICompatibleProvider } from "./providers/OpenAICompatible"
import { OpenAINativeProvider } from "./providers/OpenAINative"
import { OpenAiCodexProvider } from "./providers/OpenAiCodexProvider"
import { OpenRouterProvider } from "./providers/OpenRouterProvider"
import {
	getFallbackGenericProviderSettings,
	getGenericProviderSettings,
	hasCustomProviderSettings,
	isKnownGenericProvider,
} from "./providers/providerSettingsRegistry"
import { QwenCodeProvider } from "./providers/QwenCodeProvider"
import { QwenProvider } from "./providers/QwenProvider"
import { RequestyProvider } from "./providers/RequestyProvider"
import { SapAiCoreProvider } from "./providers/SapAiCoreProvider"
import { VercelAIGatewayProvider } from "./providers/VercelAIGatewayProvider"
import { VertexProvider } from "./providers/VertexProvider"
import { VSCodeLmProvider } from "./providers/VSCodeLmProvider"
import { XaiProvider } from "./providers/XaiProvider"
import { ZAiProvider } from "./providers/ZAiProvider"
import { useApiConfigurationScope } from "./utils/ApiConfigurationScopeContext"
import { useApiConfigurationHandlers } from "./utils/useApiConfigurationHandlers"

interface ApiOptionsProps {
	showModelOptions: boolean
	apiErrorMessage?: string
	modelIdErrorMessage?: string
	isPopup?: boolean
	currentMode: Mode
	initialModelTab?: "recommended" | "free"
}

// This is necessary to ensure dropdown opens downward, important for when this is used in popup
export const DROPDOWN_Z_INDEX = OPENROUTER_MODEL_PICKER_Z_INDEX + 2 // Higher than the OpenRouterModelPicker's and ModelSelectorTooltip's z-index

/**
 * The layer a modal in the settings view sits on: above every dropdown in it.
 *
 * Tailwind's `z-50` is 50, and every model picker in this view raises its open
 * list to 1,000 — so a dialog on `z-50` was painted *under* the Model ID list,
 * which covered its buttons. Derived from the dropdown layer rather than
 * written as a number, so raising one raises the other and the two cannot drift
 * into the same order again.
 */
export const SETTINGS_MODAL_Z_INDEX = DROPDOWN_Z_INDEX + 10

export const DropdownContainer = styled.div<{ zIndex?: number }>`
	position: relative;
	z-index: ${(props) => props.zIndex || DROPDOWN_Z_INDEX};

	// Force dropdowns to open downward
	& vscode-dropdown::part(listbox) {
		position: absolute !important;
		top: 100% !important;
		bottom: auto !important;
	}
`

declare module "vscode" {
	interface LanguageModelChatSelector {
		vendor?: string
		family?: string
		version?: string
		id?: string
	}
}

const ApiOptions = ({
	showModelOptions,
	apiErrorMessage,
	modelIdErrorMessage,
	isPopup,
	currentMode,
	initialModelTab,
}: ApiOptionsProps) => {
	// Use full context state for immediate save payload
	const { apiConfiguration, remoteConfigSettings } = useExtensionState()

	const selectedProvider =
		(currentMode === "plan" ? apiConfiguration?.planModeApiProvider : apiConfiguration?.actModeApiProvider) || "anthropic"
	const { providers: catalogProviderListings } = useProviderListings()
	const catalogProviderListing = useMemo(
		() => catalogProviderListings.find((provider) => provider.id === selectedProvider),
		[catalogProviderListings, selectedProvider],
	)
	// A provider is custom/unknown when we ship neither a dedicated settings
	// component nor a curated generic form for it. These are edited through the
	// OpenAI-compatible form so they always get Base URL, Custom Headers, Model
	// Configuration and Reasoning Effort sections — regardless of whether the id
	// happens to appear in providers.json.
	const isCustomProvider = !hasCustomProviderSettings(selectedProvider) && !isKnownGenericProvider(selectedProvider)
	// `ApiProvider` is the legacy hardcoded union and carries none of the
	// catalog-only ids — which is why opencoti lands in the branch above as a
	// custom provider in the first place. Compared as a string rather than by
	// widening that union, which a dozen exhaustive switches still depend on.
	const isOpencoti = (selectedProvider as string) === "opencoti"
	// Whether this opencoti decides its own concurrency, asked of the server:
	// the parallel-sessions copy gives opposite advice in the two cases.
	const opencotiEngine = useOpencotiEngineMode(selectedProvider)
	// An agent node's tab: Node1 and every node past it share this scope key
	// prefix, and only they get the "Agent window" slider.
	const scope = useApiConfigurationScope()
	const isAgentNode = scope?.scopeKey?.startsWith("agentsModeApiConfiguration") === true
	// The window the selected model reports, for the output budget to fall back
	// on. Provider-level `contextWindow` is only written when the box is edited,
	// so a profile that predates that write has none -- and the budget's slider
	// is a percentage of a window. Resolved here rather than inside the field
	// because this is where the configuration and the mode already are.
	const { selectedModelInfo: budgetModelInfo } = useDynamicProviderSelection(selectedProvider, apiConfiguration, currentMode)
	const genericProviderSettings = isCustomProvider
		? undefined
		: (getGenericProviderSettings(selectedProvider, catalogProviderListing) ??
			getFallbackGenericProviderSettings(selectedProvider))

	const { handleModeFieldChange } = useApiConfigurationHandlers()

	// Provider search state
	const [searchTerm, setSearchTerm] = useState("")
	const [isDropdownVisible, setIsDropdownVisible] = useState(false)
	const [selectedIndex, setSelectedIndex] = useState(-1)
	const dropdownRef = useRef<HTMLDivElement>(null)
	const itemRefs = useRef<(HTMLDivElement | null)[]>([])
	const dropdownListRef = useRef<HTMLDivElement>(null)

	const providerOptions = useMemo(() => {
		// Source the list from the live SDK provider catalog (same data the
		// hub client uses) so user-configured/custom providers appear too,
		// instead of a static hand-maintained list.
		let providers = catalogProviderListings.map((provider) => ({
			value: provider.id,
			label: provider.name,
		}))
		// Filter by platform
		if (PLATFORM_CONFIG.type !== PlatformType.VSCODE) {
			// Don't include VS Code LM API for non-VSCode platforms
			providers = providers.filter((option) => option.value !== "vscode-lm")
		}

		// Filter by remote config if remoteConfiguredProviders is set
		const remoteProviders: string[] = remoteConfigSettings?.remoteConfiguredProviders || []
		if (remoteProviders.length > 0) {
			providers = providers.filter((option) => remoteProviders.includes(option.value))
		}

		return providers
	}, [catalogProviderListings, remoteConfigSettings])

	const currentProviderLabel = useMemo(() => {
		return providerOptions.find((option) => option.value === selectedProvider)?.label || selectedProvider
	}, [providerOptions, selectedProvider])

	// Sync search term with current provider when not searching
	useEffect(() => {
		if (!isDropdownVisible) {
			setSearchTerm(currentProviderLabel)
		}
	}, [currentProviderLabel, isDropdownVisible])

	const searchableItems = useMemo(() => {
		return providerOptions.map((option) => ({
			value: option.value,
			html: option.label,
		}))
	}, [providerOptions])

	const fuse = useMemo(() => {
		return new Fuse(searchableItems, {
			keys: ["html"],
			threshold: 0.3,
			shouldSort: true,
			isCaseSensitive: false,
			ignoreLocation: false,
			includeMatches: true,
			minMatchCharLength: 1,
		})
	}, [searchableItems])

	const providerSearchResults = useMemo(() => {
		return searchTerm && searchTerm !== currentProviderLabel ? fuse.search(searchTerm)?.map((r) => r.item) : searchableItems
	}, [searchableItems, searchTerm, fuse, currentProviderLabel])

	const handleProviderChange = (newProvider: string) => {
		// Cast to the union the field is typed as, not to `any`. The comment on
		// `isCustomProvider` above says why one is needed at all: `ApiProvider`
		// is the legacy hardcoded union and carries none of the catalog-only
		// ids, opencoti among them. Narrowing it here keeps the other end of
		// the call type-checked.
		handleModeFieldChange({ plan: "planModeApiProvider", act: "actModeApiProvider" }, newProvider as ApiProvider, currentMode)
		setIsDropdownVisible(false)
		setSelectedIndex(-1)
	}

	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (!isDropdownVisible) {
			return
		}

		switch (event.key) {
			case "ArrowDown":
				event.preventDefault()
				setSelectedIndex((prev) => (prev < providerSearchResults.length - 1 ? prev + 1 : prev))
				break
			case "ArrowUp":
				event.preventDefault()
				setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev))
				break
			case "Enter":
				event.preventDefault()
				if (selectedIndex >= 0 && selectedIndex < providerSearchResults.length) {
					handleProviderChange(providerSearchResults[selectedIndex].value)
				}
				break
			case "Escape":
				setIsDropdownVisible(false)
				setSelectedIndex(-1)
				setSearchTerm(currentProviderLabel)
				break
		}
	}

	// Close dropdown when clicking outside
	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
				setIsDropdownVisible(false)
				setSearchTerm(currentProviderLabel)
			}
		}

		document.addEventListener("mousedown", handleClickOutside)
		return () => {
			document.removeEventListener("mousedown", handleClickOutside)
		}
	}, [currentProviderLabel])

	// Reset selection when search term changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: `searchTerm` is the trigger, not a value the body reads -- a new search is what makes the old highlight and scroll position wrong. Dropping it, as the rule suggests, would run this once and never again.
	useEffect(() => {
		setSelectedIndex(-1)
		if (dropdownListRef.current) {
			dropdownListRef.current.scrollTop = 0
		}
	}, [searchTerm])

	// Scroll selected item into view
	useEffect(() => {
		if (selectedIndex >= 0 && itemRefs.current[selectedIndex]) {
			itemRefs.current[selectedIndex]?.scrollIntoView({
				block: "nearest",
				behavior: "smooth",
			})
		}
	}, [selectedIndex])

	/*
	VSCodeDropdown has an open bug where dynamically rendered options don't auto select the provided value prop. You can see this for yourself by comparing  it with normal select/option elements, which work as expected.
	https://github.com/microsoft/vscode-webview-ui-toolkit/issues/433

	In our case, when the user switches between providers, we recalculate the selectedModelId depending on the provider, the default model for that provider, and a modelId that the user may have selected. Unfortunately, the VSCodeDropdown component wouldn't select this calculated value, and would default to the first "Select a model..." option instead, which makes it seem like the model was cleared out when it wasn't.

	As a workaround, we create separate instances of the dropdown for each provider, and then conditionally render the one that matches the current provider.
	*/

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 5,
				marginBottom: isPopup ? -10 : 0,
			}}>
			<style>
				{`
				.provider-item-highlight {
					background-color: var(--vscode-editor-findMatchHighlightBackground);
					color: inherit;
				}
				`}
			</style>
			<DropdownContainer className="dropdown-container">
				{remoteConfigSettings?.remoteConfiguredProviders && remoteConfigSettings.remoteConfiguredProviders.length > 0 ? (
					<Tooltip>
						<TooltipTrigger>
							<div className="flex items-center gap-2 mb-1">
								<label htmlFor="api-provider">
									<span style={{ fontWeight: 500 }}>API Provider</span>
								</label>
								<i className="codicon codicon-lock text-description text-sm" />
							</div>
						</TooltipTrigger>
						<TooltipContent>Provider options are managed by your organization's remote configuration</TooltipContent>
					</Tooltip>
				) : (
					<label htmlFor="api-provider">
						<span style={{ fontWeight: 500 }}>API Provider</span>
					</label>
				)}
				<ProviderDropdownWrapper ref={dropdownRef}>
					<VSCodeTextField
						data-testid="provider-selector-input"
						id="api-provider"
						onFocus={() => {
							setIsDropdownVisible(true)
							setSearchTerm("")
						}}
						onInput={(e) => {
							setSearchTerm((e.target as HTMLInputElement)?.value || "")
							setIsDropdownVisible(true)
						}}
						onKeyDown={handleKeyDown}
						placeholder="Search and select provider..."
						role="combobox"
						style={{
							width: "100%",
							zIndex: DROPDOWN_Z_INDEX,
							position: "relative",
							minWidth: 130,
						}}
						value={searchTerm}>
						{searchTerm && searchTerm !== currentProviderLabel && (
							<button
								aria-label="Clear search"
								className="input-icon-button codicon codicon-close"
								onClick={() => {
									setSearchTerm("")
									setIsDropdownVisible(true)
								}}
								slot="end"
								style={{
									display: "flex",
									justifyContent: "center",
									alignItems: "center",
									height: "100%",
									background: "none",
									border: "none",
									padding: 0,
									color: "inherit",
								}}
								type="button"
							/>
						)}
					</VSCodeTextField>
					{isDropdownVisible && (
						<ProviderDropdownList ref={dropdownListRef} role="listbox">
							{providerSearchResults.map((item, index) => (
								<ProviderDropdownItem
									data-testid={`provider-option-${item.value}`}
									isSelected={index === selectedIndex}
									key={item.value}
									onClick={() => handleProviderChange(item.value)}
									onMouseEnter={() => setSelectedIndex(index)}
									ref={(el) => {
										itemRefs.current[index] = el
									}}
									role="option">
									<span>{item.html}</span>
								</ProviderDropdownItem>
							))}
						</ProviderDropdownList>
					)}
				</ProviderDropdownWrapper>
			</DropdownContainer>

			{!isPopup && <ClinePassHint currentMode={currentMode} selectedProvider={selectedProvider} />}

			{apiConfiguration && selectedProvider === "hicap" && (
				<HicapProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "cline" && (
				<ClineProvider
					currentMode={currentMode}
					initialModelTab={initialModelTab}
					isPopup={isPopup}
					showModelOptions={showModelOptions}
				/>
			)}

			{apiConfiguration && selectedProvider === "cline-pass" && (
				<ClinePassProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "asksage" && (
				<AskSageProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "anthropic" && (
				<AnthropicProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "claude-code" && (
				<ClaudeCodeProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "openai-native" && (
				<OpenAINativeProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "openai-codex" && (
				<OpenAiCodexProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "qwen" && (
				<QwenProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "qwen-code" && (
				<QwenCodeProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "openrouter" && (
				<OpenRouterProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && genericProviderSettings && (
				<GenericProviderSettings
					{...genericProviderSettings}
					currentMode={currentMode}
					isPopup={isPopup}
					showModelOptions={showModelOptions}
				/>
			)}

			{apiConfiguration && selectedProvider === "vercel-ai-gateway" && !genericProviderSettings && (
				<VercelAIGatewayProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "bedrock" && (
				<BedrockProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "vertex" && (
				<VertexProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "requesty" && (
				<RequestyProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "vscode-lm" && <VSCodeLmProvider currentMode={currentMode} />}

			{apiConfiguration && selectedProvider === "groq" && !genericProviderSettings && (
				<GroqProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}
			{apiConfiguration && selectedProvider === "baseten" && !genericProviderSettings && (
				<BasetenProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}
			{apiConfiguration && selectedProvider === "litellm" && (
				<LiteLlmProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "lmstudio" && (
				<LMStudioProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "ollama" && (
				<OllamaProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{/* xOllama speaks Ollama's API, so it takes Ollama's form under its own id. */}
			{apiConfiguration && (selectedProvider as string) === "xollama" && (
				<OllamaProvider
					currentMode={currentMode}
					isPopup={isPopup}
					providerId="xollama"
					showModelOptions={showModelOptions}
				/>
			)}

			{apiConfiguration && selectedProvider === "moonshot" && (
				<MoonshotProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "huggingface" && !genericProviderSettings && (
				<HuggingFaceProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "xai" && (
				<XaiProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "sapaicore" && (
				<SapAiCoreProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "dify" && (
				<DifyProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "zai" && (
				<ZAiProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && selectedProvider === "oca" && <OcaProvider currentMode={currentMode} isPopup={isPopup} />}

			{apiConfiguration && selectedProvider === "aihubmix" && (
				<AIhubmixProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
			)}

			{apiConfiguration && (selectedProvider === "openai" || isCustomProvider) && (
				<OpenAICompatibleProvider
					currentMode={currentMode}
					isPopup={isPopup}
					providerId={selectedProvider}
					showModelOptions={showModelOptions}
				/>
			)}

			{/* opencoti's control plane, offered where opencoti is configured.
			    Rendered beside the OpenAI-compatible form rather than inside a
			    panel of its own: the chat half of opencoti IS the compatible
			    form, and duplicating it to bolt one section on would give two
			    copies to keep in step. */}
			{apiConfiguration && showModelOptions && isOpencoti && <PolykvSection providerId={selectedProvider} />}

			{/* "Agent window", per agent node (ruled 2026-09-25): the least window
			    this node's agents accept, as a share from the minimum a turn
			    needs to the node's window. Shown on every node so the setting is
			    findable; live only where the provider negotiates (opencoti). */}
			{apiConfiguration && showModelOptions && isAgentNode && selectedProvider && (
				<AgentWindowField negotiates={isOpencoti} providerId={selectedProvider} />
			)}

			{/* Every provider, for the same reason as the fields below: the tool
			    schemas are sent to every endpoint there is, and what they cost is
			    read against that endpoint's window. Placed here rather than in
			    each panel so two dozen of them cannot disagree about where it
			    lives. */}
			{apiConfiguration && showModelOptions && <ToolsSection providerId={selectedProvider} />}

			{/* Every provider, not a chosen few: the number describes an
			    arrangement with an endpoint, and every endpoint has one — slots on
			    a local server, a plan's concurrency allowance on a hosted one.
			    Placed here rather than in each panel so the two dozen of them
			    cannot disagree about where it lives or what it is called. */}
			{/* Every provider, for the same reason as the field below: every
			    endpoint holds a reply to some length, and one field in one place
			    is what stops two dozen panels disagreeing about what it is
			    called. It replaces the `numPredict` in the advanced sampler,
			    which was read for Ollama alone. */}
			{apiConfiguration && showModelOptions && selectedProvider && (
				<OutputBudgetField fallbackContextWindow={budgetModelInfo?.contextWindow} providerId={selectedProvider} />
			)}
			{apiConfiguration && showModelOptions && selectedProvider && <ReasoningHistoryField providerId={selectedProvider} />}

			{apiConfiguration && showModelOptions && selectedProvider && (
				<div className="mb-[5px]">
					<ParallelSessionsField engine={opencotiEngine} providerId={selectedProvider} />
					<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
						{parallelSessionsDescription(selectedProvider, opencotiEngine)}
					</p>
				</div>
			)}

			{apiErrorMessage && (
				<p
					style={{
						margin: "-10px 0 4px 0",
						fontSize: 12,
						color: "var(--vscode-errorForeground)",
					}}>
					{apiErrorMessage}
				</p>
			)}
			{modelIdErrorMessage && (
				<p
					style={{
						margin: "-10px 0 4px 0",
						fontSize: 12,
						color: "var(--vscode-errorForeground)",
					}}>
					{modelIdErrorMessage}
				</p>
			)}
		</div>
	)
}

export default ApiOptions

const ProviderDropdownWrapper = styled.div`
	position: relative;
	width: 100%;
`

const ProviderDropdownList = styled.div`
	position: absolute;
	top: calc(100% - 3px);
	left: 0;
	width: calc(100% - 2px);
	max-height: 200px;
	overflow-y: auto;
	background-color: var(--vscode-dropdown-background);
	border: 1px solid var(--vscode-list-activeSelectionBackground);
	z-index: ${DROPDOWN_Z_INDEX - 1};
	border-bottom-left-radius: 3px;
	border-bottom-right-radius: 3px;
`

const ProviderDropdownItem = styled.div<{ isSelected: boolean }>`
	padding: 5px 10px;
	cursor: pointer;
	word-break: break-all;
	white-space: normal;

	background-color: ${({ isSelected }) => (isSelected ? "var(--vscode-list-activeSelectionBackground)" : "inherit")};
	color: ${({ isSelected }) => (isSelected ? "var(--vscode-list-activeSelectionForeground, inherit)" : "inherit")};

	&:hover {
		background-color: var(--vscode-list-activeSelectionBackground);
		color: var(--vscode-list-activeSelectionForeground, inherit);
	}
`

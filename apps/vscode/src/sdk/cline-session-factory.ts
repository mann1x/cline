// Replaces classic task creation from src/core/task/index.ts (see origin/main)
//
// Creates and manages SDK sessions using ClineCore. This factory handles:
// - Creating ClineCore instances with proper configuration
// - Building session config from legacy state (provider, model, API key)
// - Custom session persistence adapter reading ~/.cline/data/tasks/
// - Mapping HistoryItem ↔ SDK session fields
//
// The factory does NOT handle UI concerns — that's the SdkController's job.

import {
	type ClineCoreStartInput,
	type CoreSessionConfig,
	createPromptTemplateHooks,
	type DelegatedAgentConnectionOverride,
	getProviderAuthHandler,
	mergeAgentHooks,
	type ProviderSettings,
	readCompactionStrategyGlobally,
	resolveProviderApiKeyFromSettings,
	type StartSessionResult,
} from "@cline/core"
import type { ProviderApiLine, ProviderSamplingOptions, ModelInfo as SdkModelInfo } from "@cline/llms"
import {
	DEFAULT_GATEWAY_MAX_OUTPUT_TOKENS,
	getGeneratedModelsForProvider,
	getModelsForProvider,
	isProviderApiLine,
	MODEL_COLLECTIONS_BY_PROVIDER_ID,
	OLLAMA_DEFAULT_CONTEXT_WINDOW,
	OLLAMA_DEFAULT_REASONING_EFFORT,
	primeDeclaredNumCtx,
	readDeclaredNumCtx,
} from "@cline/llms"
import { type AgentHooks, buildClineSystemPrompt, type RenderedPromptTemplate } from "@cline/shared"
import type { ApiConfiguration } from "@shared/api"
import { profileProviderSettingsFor } from "@shared/api-config-profiles"
import { ClineClient } from "@shared/cline"
import type { HistoryItem } from "@shared/HistoryItem"
import { DEFAULT_LANGUAGE_SETTINGS, getLanguageKey, type LanguageDisplay } from "@shared/Languages"
import { toLegacyApiProvider } from "@shared/model-catalog/provider-helpers"
import {
	resolveScopedModelStatus,
	snapshotModelId,
	snapshotProviderId,
	snapshotProviderSettings,
} from "@shared/model-scope-config"
import { Logger } from "@shared/services/Logger"
import type { Settings } from "@shared/storage/state-keys"
import type { Mode } from "@shared/storage/types"
import { reasoningEffortFromThinkingBudget } from "@shared/utils/reasoning-support"
import { resolveVisionModelStatus, visionSnapshotProviderId } from "@shared/vision-config"
import { stringifyVsCodeLmModelSelector } from "@shared/vsCodeSelectorUtils"
import { StateManager } from "@/core/storage/StateManager"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import { getDistinctId } from "@/services/logging/distinctId"
import { fetch } from "@/shared/net"
import { type BedrockProviderConfig, buildBedrockProviderConfig } from "./bedrock-config"
import { createEditorDiagnosticsHooks } from "./editor-diagnostics"
import { buildAgentHooks } from "./hooks-adapter"
import { readTaskHistory, resolveDataDir } from "./legacy-state-reader"
import type { ResolvedModelSelection } from "./model-catalog/contracts"
import { nonNegativeFiniteNumber, positiveFiniteNumber, toSdkApiFormat } from "./model-catalog/model-values"
import { parseProviderId } from "./model-catalog/provider-id"
import { toSdkProviderId } from "./model-catalog/sdk-provider-id"
import { createProviderConfigStore, resolveRuntimeModelSelection } from "./model-catalog/store"
import {
	resolveOllamaContextWindow,
	resolveOllamaImageSupport,
	resolveOllamaModelParameters,
	resolveOllamaThinkBudget,
} from "./ollama-model-family"
import { resolveSessionPromptTemplate } from "./prompt-templates"
import { getProviderSettingsManager } from "./provider-migration"
import { buildSapProviderConfig, type SapProviderConfig } from "./sap-config"
import type { SdkSessionHost } from "./session-host"
import { buildScopedApiConfiguration, buildVisionApiConfiguration, createVisionImageDescriber } from "./vision-model"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for creating a new session */
export interface SessionConfigInput {
	/** The user's prompt */
	prompt?: string
	/** Images attached to the message */
	images?: string[]
	/** Files attached to the message */
	files?: string[]
	/** History item to resume (for task resumption) */
	historyItem?: HistoryItem
	/** Task-specific settings overrides */
	taskSettings?: Partial<Settings>
	/** Working directory */
	cwd: string
	/** Workspace root */
	workspaceRoot?: string
	/** Current mode (act/plan) */
	mode?: Mode
}

/** Active session state tracked by the factory */
export interface ActiveSession {
	/** The session ID */
	sessionId: string
	/** The config used to start the active session. */
	startConfig?: Pick<CoreSessionConfig, "providerId" | "modelId">
	/** The runtime host instance managing this session (VscodeSessionHost) */
	sdkHost: SdkSessionHost
	/** Unsubscribe function for session events */
	unsubscribe: () => void
	/** The start result from the session */
	startResult?: StartSessionResult
	/** Whether the session is currently running */
	isRunning: boolean
	/**
	 * When the current request started, in epoch ms.
	 *
	 * Set when the session goes from idle to running and read when it goes back,
	 * so it measures one request — from the message that started the work to the
	 * turn that ends it — rather than the age of the session. A follow-up
	 * question answered in twenty seconds and an hour of fixing a file are the
	 * two cases this has to tell apart.
	 */
	runStartedAt?: number
}

function createSdkLogger() {
	return {
		debug: (message: string, metadata?: Record<string, unknown>) => {
			Logger.debug(message, metadata)
		},
		log: (message: string, metadata?: Record<string, unknown>) => {
			Logger.log(message, metadata)
		},
		error: (message: string, metadata?: Record<string, unknown>) => {
			Logger.error(message, metadata)
		},
	}
}

/**
 * Host identity for the session's client context, resolved through HostProvider
 * rather than the `vscode` module directly: this file is also bundled into the
 * standalone cline-core (JetBrains), where `vscode` is a Proxy-stub module and
 * direct API reads would yield non-string values. The hostbridge returns the
 * per-host values (e.g. "Cline for JetBrains" + IDE version on JetBrains).
 */
async function resolveHostIdentity() {
	try {
		return await HostProvider.env.getHostVersion({})
	} catch (error) {
		Logger.debug("Failed to resolve host version for client identity", error)
		return undefined
	}
}

async function resolveIsMultiRootWorkspace(): Promise<boolean> {
	try {
		const { paths } = await HostProvider.workspace.getWorkspacePaths({})
		return paths.length > 1
	} catch {
		return false
	}
}

function resolveWorkspaceName(workspacePath: string): string {
	const trimmed = workspacePath.trim()
	const withoutTrailingSeparators = trimmed.replace(/[\\/]+$/, "")
	const name = withoutTrailingSeparators.split(/[\\/]/).filter(Boolean).pop()?.trim()
	return name || "workspace"
}

type ReasoningEffort = NonNullable<CoreSessionConfig["reasoningEffort"]>
type ProviderReasoningSettings = NonNullable<ProviderSettings["reasoning"]>
type SessionReasoningConfig = Pick<CoreSessionConfig, "thinking" | "reasoningEffort">

/**
 * The efforts the SDK actually accepts, not a subset of them.
 *
 * `minimal` and `max` were missing here while the gateway parses the full
 * `ReasoningEffortSchema`, so a provider UI offering either wrote a value this
 * guard then dropped on the way to the session config -- the setting appeared
 * to save and never reached the wire.
 */
function isReasoningEffort(value: unknown): value is ReasoningEffort {
	return (
		value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
	)
}

function hasStaleDisabledReasoningFields(reasoning: ProviderReasoningSettings | undefined): boolean {
	return reasoning?.enabled === false && (reasoning.effort !== undefined || reasoning.budgetTokens !== undefined)
}

function providerSettingsProviderId(providerId: string): string {
	return toSdkProviderId(providerId)
}

/**
 * Convert SDK provider-level reasoning settings into the SDK session fields that
 * are actually forwarded as model options. Keep `thinking` and
 * `reasoningEffort` coherent: a disabled/none state must never carry an effort.
 *
 * A persisted `budgetTokens` without an effort (written by older extension
 * versions or the legacy-state migration) is honored by mapping the budget
 * onto the effort scale, so users who had extended thinking enabled keep it
 * enabled after upgrading to the effort-based control.
 */
export function normalizeProviderReasoningSettings(reasoning: ProviderReasoningSettings | undefined): SessionReasoningConfig {
	if (!reasoning) {
		return {}
	}

	if (reasoning.enabled === false || reasoning.effort === "none") {
		return { thinking: false }
	}

	const effort = isReasoningEffort(reasoning.effort)
		? reasoning.effort
		: reasoningEffortFromThinkingBudget(reasoning.budgetTokens)

	if (reasoning.enabled === true) {
		return {
			thinking: true,
			...(effort ? { reasoningEffort: effort } : {}),
		}
	}

	if (isReasoningEffort(reasoning.effort)) {
		return { reasoningEffort: reasoning.effort }
	}

	// Legacy budget with no explicit enabled/effort: treat as thinking-on.
	return effort ? { thinking: true, reasoningEffort: effort } : {}
}

function resolveProviderReasoningConfig(providerId: string): SessionReasoningConfig {
	try {
		const manager = getProviderSettingsManager(resolveDataDir())
		const settings = manager.getProviderSettings(providerSettingsProviderId(providerId))
		if (!settings) {
			return {}
		}

		if (hasStaleDisabledReasoningFields(settings.reasoning)) {
			const sanitizedSettings: ProviderSettings = {
				...settings,
				reasoning: { enabled: false },
			}
			manager.saveProviderSettings(sanitizedSettings, { setLastUsed: false })
			Logger.warn(`[SessionFactory] Cleared stale disabled reasoning fields for provider=${providerId}`)
			return normalizeProviderReasoningSettings(sanitizedSettings.reasoning)
		}

		return normalizeProviderReasoningSettings(settings.reasoning)
	} catch (error) {
		Logger.warn("[SessionFactory] Provider reasoning resolution failed:", error)
		return {}
	}
}

function resolveOcaReasoningConfig(mode: Mode, apiConfig: ApiConfiguration | undefined): SessionReasoningConfig | undefined {
	const rawEffort = mode === "plan" ? apiConfig?.planModeOcaReasoningEffort : apiConfig?.actModeOcaReasoningEffort
	const effort = rawEffort?.trim().toLowerCase()
	if (!effort) {
		return undefined
	}

	if (effort === "none") {
		return { thinking: false }
	}

	return isReasoningEffort(effort) ? { thinking: true, reasoningEffort: effort } : undefined
}

function resolveOpenAiCompatibleMaxTokens(config: ApiConfiguration | undefined, mode: Mode): number | undefined {
	const modelInfo = mode === "plan" ? config?.planModeOpenAiModelInfo : config?.actModeOpenAiModelInfo
	return positiveFiniteNumber(modelInfo?.maxTokens)
}

function toSdkModelInfo(selection: ResolvedModelSelection): SdkModelInfo {
	const modelInfo = selection.modelInfo
	const capabilities = new Set<NonNullable<SdkModelInfo["capabilities"]>[number]>(
		(selection.overrides?.capabilities ?? []) as NonNullable<SdkModelInfo["capabilities"]>,
	)
	const setCapability = (capability: NonNullable<SdkModelInfo["capabilities"]>[number], enabled: boolean): void => {
		if (enabled) capabilities.add(capability)
		else capabilities.delete(capability)
	}
	if (modelInfo.supportsImages !== undefined) setCapability("images", modelInfo.supportsImages)
	setCapability("prompt-cache", modelInfo.supportsPromptCache)
	if (modelInfo.supportsReasoning !== undefined) setCapability("reasoning", modelInfo.supportsReasoning)
	if (selection.overrides?.supportsAttachments !== undefined) setCapability("files", selection.overrides.supportsAttachments)

	const maxTokens = positiveFiniteNumber(modelInfo.maxTokens)
	const contextWindow = positiveFiniteNumber(modelInfo.contextWindow)
	const maxInputTokens = positiveFiniteNumber(selection.overrides?.maxInputTokens)
	const temperature = nonNegativeFiniteNumber(modelInfo.temperature)
	const inputPrice = nonNegativeFiniteNumber(modelInfo.inputPrice)
	const outputPrice = nonNegativeFiniteNumber(modelInfo.outputPrice)
	const cacheRead = nonNegativeFiniteNumber(modelInfo.cacheReadsPrice)
	const cacheWrite = nonNegativeFiniteNumber(modelInfo.cacheWritesPrice)
	const apiFormat = toSdkApiFormat(modelInfo.apiFormat)
	const hasPricing =
		inputPrice !== undefined || outputPrice !== undefined || cacheRead !== undefined || cacheWrite !== undefined

	return {
		id: selection.modelId,
		name: modelInfo.name ?? selection.modelId,
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
		...(capabilities.size > 0 ? { capabilities: [...capabilities] } : {}),
		...(apiFormat !== undefined ? { apiFormat } : {}),
		...(temperature !== undefined ? { temperature } : {}),
		...(hasPricing
			? {
					pricing: {
						...(inputPrice !== undefined ? { input: inputPrice } : {}),
						...(outputPrice !== undefined ? { output: outputPrice } : {}),
						...(cacheRead !== undefined ? { cacheRead } : {}),
						...(cacheWrite !== undefined ? { cacheWrite } : {}),
					},
				}
			: {}),
	}
}

/**
 * The share of the cap a model is told to aim for when the cap is effectively
 * the whole context window, leaving the rest for the conversation.
 */
const OUTPUT_BUDGET_SAFE_SHARE = 0.75

/**
 * The point at which a per-turn cap stops being a cap and becomes the context
 * window: at or above this share of it, filling the cap leaves nothing for
 * anything else.
 */
const OUTPUT_BUDGET_WINDOW_SHARE_THRESHOLD = 0.9

/**
 * Build the system-prompt section describing the per-turn output cap.
 *
 * Every request carries a `maxOutputTokens` the provider truncates at
 * (`num_predict`, for Ollama), and nothing in the prompt mentions it: the model
 * is asked for a full plan plus edits with no idea its reply will be cut off
 * mid-sentence, thinking included, and the turn wasted. When no per-model
 * override exists the value is the gateway default of 32,000, which on a
 * 32,768-token model is the entire context window — filling it leaves nothing
 * for the conversation and forces a compaction round trip.
 *
 * `thinking` names the share of that cap the model may spend reasoning, when
 * the provider enforces one. Ollama does: a level is a fraction of
 * `min(num_predict, num_ctx)`, computed server-side, and a model told only the
 * outer cap reads the whole of it as available to think in. Sessions ended on
 * "reached the maximum output token limit" with the entire allowance spent
 * inside the thinking block and no answer written.
 *
 * Exported for tests: the wording is the whole behaviour.
 */
export function buildOutputBudgetSection(
	outputCap: number,
	contextWindow: number | undefined,
	thinking?: { level: string; budgetTokens: number },
): string {
	let section =
		`\n\n# Output Budget\n\nEach reply you produce is capped at ${outputCap} tokens, thinking included. ` +
		"Anything past the cap is cut off mid-sentence and the turn is wasted."
	if (thinking && thinking.budgetTokens > 0) {
		section +=
			` Of that, at most ${thinking.budgetTokens} tokens may be spent thinking (effort ${thinking.level}); ` +
			"reasoning past that point is cut short, so reach a decision inside it and write the answer with what is left."
	}
	if (contextWindow !== undefined && outputCap >= contextWindow * OUTPUT_BUDGET_WINDOW_SHARE_THRESHOLD) {
		const safeCap = Math.floor(outputCap * OUTPUT_BUDGET_SAFE_SHARE)
		const reservedPercent = Math.round((1 - OUTPUT_BUDGET_SAFE_SHARE) * 100)
		section +=
			` That cap is effectively the whole ${contextWindow}-token context window, so keep each reply under ` +
			`${safeCap} tokens and leave the remaining ${reservedPercent}% free for compaction.`
	} else if (contextWindow !== undefined) {
		section += ` The context window is ${contextWindow} tokens.`
	}
	section +=
		" Prefer several focused tool calls over one oversized reply: if the remaining work does not fit, " +
		"do the part that fits, call the tools it needs, and continue in the next turn."
	return section
}

/**
 * The thinking allowance an Ollama turn will actually be held to.
 *
 * Asked of the server, never derived here. The budget is a share of the room
 * the response has, resolved by Ollama from its own table, so a copy of that
 * table on this side would have to be kept in step with it — and a stale copy
 * would put a bound in the system prompt that the model is not held to, which
 * is worse than saying nothing. `/api/show` answers for the think value and
 * options this session will actually send.
 *
 * Returns undefined for every other provider, and for an Ollama that does not
 * report a budget: no other provider here enforces a separate thinking cap, and
 * an invented figure would be worse than silence.
 */
export async function resolveOllamaThinkingAllowance(
	providerId: string,
	reasoning: SessionReasoningConfig,
	outputCap: number,
	contextWindow: number | undefined,
	baseUrl: string | undefined,
	modelId: string | undefined,
): Promise<{ level: string; budgetTokens: number } | undefined> {
	if (toSdkProviderId(providerId) !== "ollama" || reasoning.thinking === false || !modelId) {
		return undefined
	}

	let numPredict: number | undefined
	try {
		const settings = getProviderSettingsManager(resolveDataDir()).getProviderSettings(providerSettingsProviderId(providerId))
		numPredict = positiveFiniteNumber(settings?.sampling?.numPredict)
	} catch (error) {
		// Advisory: the session's own cap is the sensible stand-in.
		Logger.warn("[SessionFactory] Failed to read Ollama sampling settings:", error)
	}

	// The level this session will send. The vendor fills in its default when
	// nothing set one, so that is the level to ask about — asking about "no
	// level" would answer for a request this session never makes.
	const think = reasoning.reasoningEffort ?? OLLAMA_DEFAULT_REASONING_EFFORT
	return resolveOllamaThinkBudget(baseUrl, modelId, {
		think,
		// A configured num_predict is the cap the server will apply; the
		// agent's own per-turn cap only stands in when nothing more specific
		// was set.
		numPredict: numPredict ?? outputCap,
		numCtx: contextWindow,
	})
}

function resolveCommittedRuntimeModel(
	providerId: string,
	mode: Mode,
	modelId: string | undefined,
): ResolvedModelSelection | undefined {
	if (!modelId) {
		return undefined
	}
	try {
		const parsedProviderId = parseProviderId(providerId)
		const selection = createProviderConfigStore().readSelection(parsedProviderId, mode)
		return selection?.modelId === modelId ? selection : resolveRuntimeModelSelection(parsedProviderId, modelId)
	} catch (error) {
		Logger.warn(`[SessionFactory] Failed to resolve committed model settings for provider=${providerId}:`, error)
		return undefined
	}
}

// ---------------------------------------------------------------------------
// Provider → API key field mapping
// ---------------------------------------------------------------------------

/**
 * Maps a provider ID to the corresponding API key field name in ApiConfiguration.
 * This covers all 30+ providers supported by the classic extension.
 */
const PROVIDER_API_KEY_MAP: Record<string, keyof ApiConfiguration> = {
	anthropic: "apiKey",
	openrouter: "openRouterApiKey",
	openai: "openAiApiKey",
	"openai-native": "openAiNativeApiKey",
	bedrock: "awsBedrockApiKey",
	vertex: "geminiApiKey",
	gemini: "geminiApiKey",
	deepseek: "deepSeekApiKey",
	cline: "clineApiKey",
	"cline-pass": "clineApiKey",
	ollama: "ollamaApiKey",
	lmstudio: "apiKey", // LM Studio doesn't need a key but uses the generic field
	requesty: "requestyApiKey",
	together: "togetherApiKey",
	fireworks: "fireworksApiKey",
	qwen: "qwenApiKey",
	doubao: "doubaoApiKey",
	mistral: "mistralApiKey",
	litellm: "liteLlmApiKey",
	asksage: "asksageApiKey",
	xai: "xaiApiKey",
	moonshot: "moonshotApiKey",
	zai: "zaiApiKey",
	huggingface: "huggingFaceApiKey",
	nebius: "nebiusApiKey",
	sambanova: "sambanovaApiKey",
	cerebras: "cerebrasApiKey",
	groq: "groqApiKey",
	baseten: "basetenApiKey",
	"huawei-cloud-maas": "huaweiCloudMaasApiKey",
	dify: "difyApiKey",
	minimax: "minimaxApiKey",
	hicap: "hicapApiKey",
	aihubmix: "aihubmixApiKey",
	nousResearch: "nousResearchApiKey",
	"vercel-ai-gateway": "vercelAiGatewayApiKey",
	claude_code: "apiKey", // Claude Code uses anthropic key
	wandb: "wandbApiKey",
	"qwen-code": "qwenApiKey",
	oca: "ocaApiKey",
}

/**
 * Maps a provider ID to the mode-specific model ID field name in ApiConfiguration.
 * For providers that have dedicated model ID fields per mode.
 */
const PROVIDER_MODEL_ID_MAP: Record<string, { plan: keyof ApiConfiguration; act: keyof ApiConfiguration }> = {
	anthropic: { plan: "planModeApiModelId", act: "actModeApiModelId" },
	openrouter: { plan: "planModeOpenRouterModelId", act: "actModeOpenRouterModelId" },
	openai: { plan: "planModeOpenAiModelId", act: "actModeOpenAiModelId" },
	"openai-native": { plan: "planModeApiModelId", act: "actModeApiModelId" },
	"openai-codex": { plan: "planModeApiModelId", act: "actModeApiModelId" },
	ollama: { plan: "planModeOllamaModelId", act: "actModeOllamaModelId" },
	lmstudio: { plan: "planModeLmStudioModelId", act: "actModeLmStudioModelId" },
	gemini: { plan: "planModeApiModelId", act: "actModeApiModelId" },
	bedrock: { plan: "planModeApiModelId", act: "actModeApiModelId" },
	vertex: { plan: "planModeApiModelId", act: "actModeApiModelId" },
	deepseek: { plan: "planModeApiModelId", act: "actModeApiModelId" },
	cline: { plan: "planModeClineModelId", act: "actModeClineModelId" },
	"cline-pass": { plan: "planModeClinePassModelId", act: "actModeClinePassModelId" },
	litellm: { plan: "planModeLiteLlmModelId", act: "actModeLiteLlmModelId" },
	requesty: { plan: "planModeRequestyModelId", act: "actModeRequestyModelId" },
	together: { plan: "planModeTogetherModelId", act: "actModeTogetherModelId" },
	fireworks: { plan: "planModeFireworksModelId", act: "actModeFireworksModelId" },
	groq: { plan: "planModeGroqModelId", act: "actModeGroqModelId" },
	baseten: { plan: "planModeBasetenModelId", act: "actModeBasetenModelId" },
	huggingface: { plan: "planModeHuggingFaceModelId", act: "actModeHuggingFaceModelId" },
	"huawei-cloud-maas": { plan: "planModeHuaweiCloudMaasModelId", act: "actModeHuaweiCloudMaasModelId" },
	oca: { plan: "planModeOcaModelId", act: "actModeOcaModelId" },
	aihubmix: { plan: "planModeAihubmixModelId", act: "actModeAihubmixModelId" },
	hicap: { plan: "planModeHicapModelId", act: "actModeHicapModelId" },
	nousResearch: { plan: "planModeNousResearchModelId", act: "actModeNousResearchModelId" },
	"vercel-ai-gateway": { plan: "planModeVercelAiGatewayModelId", act: "actModeVercelAiGatewayModelId" },
}

// ---------------------------------------------------------------------------
// Provider/model defaults
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER_ID = "cline"

/**
 * Providers whose model list comes from a live local endpoint (Ollama's
 * `/api/tags`, LM Studio's `/v1/models`). Their installed models are the only
 * meaningful catalog; a bundled-catalog default would silently select a model
 * the user never installed (e.g. an Ollama Cloud nemotron model).
 */
function providerHasLocalModelSource(providerId: string): boolean {
	return Boolean(MODEL_COLLECTIONS_BY_PROVIDER_ID[toSdkProviderId(providerId)]?.provider.modelsSourceUrl)
}

export function getDefaultModelIdForProvider(providerId: string): string | undefined {
	const sdkProviderId = toSdkProviderId(providerId)
	if (providerHasLocalModelSource(providerId)) {
		return undefined
	}
	const collection = MODEL_COLLECTIONS_BY_PROVIDER_ID[sdkProviderId]
	if (!collection) {
		return undefined
	}

	const generatedModels = getGeneratedModelsForProvider(sdkProviderId)
	const defaultModelId = collection.provider.defaultModelId?.trim()
	if (defaultModelId && (generatedModels[defaultModelId] || collection.models?.[defaultModelId])) {
		return defaultModelId
	}

	return Object.keys(generatedModels)[0] || Object.keys(collection.models ?? {})[0] || undefined
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the API key for a given provider from the ApiConfiguration.
 *
 * For SDK-managed OAuth providers, reads the OAuth token from providers.json
 * via ProviderSettingsManager (the single source of truth for credentials).
 */
export function resolveApiKey(providerId: string, config: ApiConfiguration): string | undefined {
	const authHandler = getProviderAuthHandler(providerId)
	if (authHandler) {
		const keyField = PROVIDER_API_KEY_MAP[providerId]
		const configuredApiKey = keyField ? (config[keyField] as string | undefined)?.trim() : undefined
		if (configuredApiKey) {
			return configuredApiKey
		}

		// Read from providers.json via the shared ProviderSettingsManager. This is
		// intentionally keyed by the requested provider so SDK auth metadata can
		// resolve shared storage (e.g. cline-pass -> cline) without VS Code
		// hardcoding provider exceptions.
		try {
			const manager = getProviderSettingsManager()
			const apiKey = resolveProviderApiKeyFromSettings(manager, providerSettingsProviderId(providerId))?.trim()
			if (apiKey) {
				return apiKey
			}
		} catch {
			Logger.warn(`[SessionFactory] Failed to read ${providerId} credentials from providers.json`)
		}

		return undefined
	}

	// For all other providers, look up the API key field name
	const keyField = PROVIDER_API_KEY_MAP[providerId]
	if (keyField) {
		const apiKey = config[keyField] as string | undefined
		if (apiKey) {
			return apiKey
		}
	}

	// SDK-backed API-key providers save credentials in providers.json instead
	// of legacy ApiConfiguration fields. Fall back to that store so providers
	// exposed through the SDK settings UI still receive credentials at task
	// startup.
	try {
		const manager = getProviderSettingsManager()
		const apiKey = resolveProviderApiKeyFromSettings(manager, providerSettingsProviderId(providerId))?.trim()
		if (apiKey) {
			return apiKey
		}
	} catch {
		Logger.warn(`[SessionFactory] Failed to read ${providerId} API key from providers.json`)
	}

	return undefined
}

/**
 * Resolve the model ID for a given provider and mode from the ApiConfiguration.
 * Uses mode-specific model ID fields when available, falls back to generic fields.
 */
export function resolveModelId(providerId: string, mode: Mode, config: ApiConfiguration): string | undefined {
	// VS Code LM has no plain model-id field: the selected model is stored as a
	// structured LanguageModelChatSelector ({vendor, family, ...}) in
	// plan/actModeVsCodeLmModelSelector. The SDK ProviderConfig only carries a
	// string modelId, so we stringify the selector to "vendor/family[/version/id]"
	// and the VS Code LM handler parses it back. See sdk/vscode-lm/vscode-lm-handler.ts.
	if (providerId === "vscode-lm") {
		const selector = mode === "plan" ? config.planModeVsCodeLmModelSelector : config.actModeVsCodeLmModelSelector
		return selector ? stringifyVsCodeLmModelSelector(selector) || undefined : undefined
	}

	if (providerId === "sapaicore") {
		const genericField = mode === "plan" ? "planModeApiModelId" : "actModeApiModelId"
		const legacyField = mode === "plan" ? "planModeSapAiCoreModelId" : "actModeSapAiCoreModelId"
		return (
			(config[genericField] as string | undefined)?.trim() ||
			(config[legacyField] as string | undefined)?.trim() ||
			undefined
		)
	}

	// Check provider-specific mode model ID fields.
	// If the provider has a dedicated field, do not fall back to generic
	// *ModeApiModelId. Those generic slots may contain a stale model from a
	// previous provider (for example openai/gpt-5.4), which would make the SDK
	// session use a different model than the Cline provider UI shows.
	const modelFields = PROVIDER_MODEL_ID_MAP[providerId]
	if (modelFields) {
		const field = mode === "plan" ? modelFields.plan : modelFields.act
		return (config[field] as string | undefined)?.trim() || undefined
	}

	// Fallback to generic mode model ID fields only for providers without a
	// dedicated model field.
	const genericField = mode === "plan" ? "planModeApiModelId" : "actModeApiModelId"
	return (config[genericField] as string | undefined)?.trim() || undefined
}

/**
 * Resolve the base URL for a given provider from the ApiConfiguration.
 */
/**
 * Put a scheme back on a base URL that lost one.
 *
 * Reported live: a remote Ollama at `http://192.168.1.100:30068` ended up
 * stored without its scheme, and every request then died on
 * `Failed to parse URL from 192.168.1.100:30068/api/chat` -- the provider
 * unusable, with nothing on screen connecting the two. Whatever dropped it,
 * `host:port` has exactly one sensible reading, and refusing to take it is
 * worse than assuming it.
 *
 * `http`, not `https`: this is the spelling a local or LAN Ollama answers on,
 * and it is the one the field's own placeholder shows. Anything that already
 * names a scheme is left alone.
 */
export function ensureBaseUrlScheme(value: string): string {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
		return value
	}
	// A bare `localhost:11434` parses as a URL whose *protocol* is `localhost:`,
	// so `URL.canParse` cannot be used to tell a scheme-less authority from a
	// real one. The shape is what distinguishes them.
	return `http://${value.replace(/^\/+/, "")}`
}

export function normalizeSdkBaseUrl(providerId: string, baseUrl: unknown): string | undefined {
	if (typeof baseUrl !== "string") {
		return undefined
	}

	const trimmed = ensureBaseUrlScheme(baseUrl.trim())
	if (!trimmed || trimmed === "http://") {
		return undefined
	}

	const providerDefaultBaseUrl = MODEL_COLLECTIONS_BY_PROVIDER_ID[toSdkProviderId(providerId)]?.provider.baseUrl
	if (!providerDefaultBaseUrl) {
		return trimmed
	}

	try {
		const configuredUrl = new URL(trimmed)
		const defaultUrl = new URL(providerDefaultBaseUrl)
		const configuredHasPath = configuredUrl.pathname !== "/"
		const defaultHasPath = defaultUrl.pathname !== "/"

		if (!configuredHasPath && defaultHasPath) {
			configuredUrl.pathname = defaultUrl.pathname
			return configuredUrl.toString().replace(/\/$/, "")
		}
	} catch {
		return trimmed
	}

	return trimmed
}

export function resolveVertexProviderConfig(config: ApiConfiguration): Pick<ProviderSettings, "gcp" | "region"> {
	let providerSettingsProjectId: string | undefined
	let providerSettingsRegion: string | undefined
	try {
		const settings = getProviderSettingsManager().getProviderSettings("vertex")
		providerSettingsProjectId = settings?.gcp?.projectId?.trim() || undefined
		providerSettingsRegion = settings?.gcp?.region?.trim() || settings?.region?.trim() || undefined
	} catch {
		Logger.warn("[SessionFactory] Failed to read Vertex settings from providers.json")
	}

	const region = (providerSettingsRegion ?? config.vertexRegion?.trim()) || undefined
	return {
		region,
		gcp: {
			projectId: (providerSettingsProjectId ?? config.vertexProjectId?.trim()) || undefined,
			region,
		},
	}
}

type OllamaProviderConfig = {
	modelInfo?: { id: string; name: string; contextWindow: number }
	timeoutMs?: number
	/**
	 * The sampler as configured. Read here for the output budget (`numPredict`),
	 * and carried to the wire by `buildGatewayProviderOptions`, which lifts it
	 * into the gateway's `options` bag where the Ollama vendor looks for it.
	 */
	sampling?: ProviderSamplingOptions
}

/**
 * Resolve the user's "Model Context Window" setting for Ollama and surface it
 * as the selected model's `contextWindow`. The gateway carries it on the
 * resolved model definition, and the Ollama vendor maps it onto the wire as
 * `options.num_ctx` — without it Ollama loads every model with its 4096-token
 * server default. Keeping it on the model also means context management
 * budgets against the window Ollama actually applies (Ollama truncates the
 * prompt to `num_ctx` server-side).
 */
export function resolveOllamaProviderConfig(
	config: ApiConfiguration,
	modelId: string | undefined,
	overrideSettings?: Record<string, unknown>,
): OllamaProviderConfig {
	// providers.json (`contextWindow`) is the source of truth; the legacy
	// StateManager string is a migration fallback (the config store mirrors
	// writes to both).
	let settingsContextWindow: number | undefined
	try {
		const value = (overrideSettings ?? getProviderSettingsManager().getProviderSettings("ollama"))?.contextWindow
		settingsContextWindow = typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
	} catch {
		Logger.warn("[SessionFactory] Failed to read Ollama settings from providers.json")
	}
	let sampling: ProviderSamplingOptions | undefined
	try {
		const stored = (overrideSettings ?? getProviderSettingsManager().getProviderSettings("ollama"))?.sampling
		sampling = stored && typeof stored === "object" ? (stored as ProviderSamplingOptions) : undefined
	} catch {
		Logger.warn("[SessionFactory] Failed to read Ollama sampling settings from providers.json")
	}
	// A scoped configuration owns its own entry, so an empty context window on it
	// means empty rather than "borrow the other model's".
	//
	// `ollamaApiOptionsCtxNum` is a single global value, and reaching for it here
	// is what made the setting behave as a global one: the Vision tab holds its
	// settings in its own snapshot, so when it named no window this fell through
	// to the number the primary model had been given and loaded the vision model
	// with it. The webview stopped doing this in 4.100.25 and this did not, so the
	// panel showed the right thing while the request carried the wrong one —
	// a display fixed over a behaviour that was not.
	const scoped = overrideSettings !== undefined
	const raw = scoped ? undefined : config.ollamaApiOptionsCtxNum?.trim()
	const parsed = raw ? Number(raw) : Number.NaN
	const legacyContextWindow = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
	// The model's own `num_ctx` sits between the user's setting and the
	// constant. Without it a model whose Modelfile says 128000 was loaded at
	// 32768: sending a default overrides the model's own value, and Ollama
	// cannot tell a considered 32768 from a placeholder one. Primed by
	// `buildSessionConfig` before this runs, so the first request already has
	// it — a `num_ctx` that changes between turns reloads the model mid-task.
	const declaredContextWindow = readDeclaredNumCtx(config.ollamaBaseUrl, modelId)
	const contextWindow = settingsContextWindow ?? legacyContextWindow ?? declaredContextWindow ?? OLLAMA_DEFAULT_CONTEXT_WINDOW
	const timeoutMs = config.requestTimeoutMs
	return {
		...(typeof timeoutMs === "number" && timeoutMs > 0 ? { timeoutMs } : {}),
		...(sampling ? { sampling } : {}),
		...(modelId ? { modelInfo: { id: modelId, name: modelId, contextWindow } } : {}),
	}
}

export function resolveBaseUrl(providerId: string, config: ApiConfiguration): string | undefined {
	const baseUrlMap: Record<string, keyof ApiConfiguration> = {
		anthropic: "anthropicBaseUrl",
		openai: "openAiBaseUrl",
		// The OpenAI Compatible provider may be stored under its SDK spelling
		// (settings written through the SDK settings store) instead of the
		// extension's legacy "openai" id; both use the same legacy state field.
		"openai-compatible": "openAiBaseUrl",
		ollama: "ollamaBaseUrl",
		lmstudio: "lmStudioBaseUrl",
		gemini: "geminiBaseUrl",
		requesty: "requestyBaseUrl",
		litellm: "liteLlmBaseUrl",
		asksage: "asksageApiUrl",
		oca: "ocaBaseUrl",
		aihubmix: "aihubmixBaseUrl",
		dify: "difyBaseUrl",
	}

	const field = baseUrlMap[providerId]
	if (field) {
		const fromState = normalizeSdkBaseUrl(providerId, config[field])
		if (fromState) {
			return fromState
		}
	}

	// SDK-backed providers save their base URL in providers.json instead of
	// legacy ApiConfiguration fields. Fall back to that store (mirroring
	// resolveApiKey) so ProviderConfig consumers that don't re-resolve settings
	// themselves — e.g. the compaction summarizer's createHandlerAsync — still
	// reach the configured endpoint instead of the provider default.
	try {
		const manager = getProviderSettingsManager()
		const settingsBaseUrl = manager.getProviderSettings(providerSettingsProviderId(providerId))?.baseUrl
		const normalized = normalizeSdkBaseUrl(providerId, settingsBaseUrl)
		if (normalized) {
			return normalized
		}
	} catch {
		Logger.warn(`[SessionFactory] Failed to read ${providerId} base URL from providers.json`)
	}

	return undefined
}

/**
 * Resolve the regional API line ("china" | "international") for providers with
 * regional endpoints (Qwen, Moonshot, Z AI, MiniMax and their coding
 * variants). Resolution order:
 *
 * 1. The provider's own legacy StateManager field (mirroring resolveBaseUrl).
 * 2. The provider's own providers.json `apiLine` (SDK-store fallback).
 * 3. For coding variants without their own legacy field or stored line, the
 *    base provider's legacy field (qwen-code shares Qwen's DashScope region,
 *    zai-coding-plan shares Z AI's account region) — so a variant-specific
 *    providers.json setting still wins over the shared field.
 *
 * The SDK gateway maps the line to the provider's regional base URL when no
 * explicit base URL is configured.
 */
export function resolveApiLine(providerId: string, config: ApiConfiguration): ProviderApiLine | undefined {
	const apiLineMap: Record<string, keyof ApiConfiguration> = {
		qwen: "qwenApiLine",
		moonshot: "moonshotApiLine",
		zai: "zaiApiLine",
		minimax: "minimaxApiLine",
	}
	const sharedApiLineMap: Record<string, keyof ApiConfiguration> = {
		"qwen-code": "qwenApiLine",
		"zai-coding-plan": "zaiApiLine",
	}

	const field = apiLineMap[providerId]
	if (field) {
		const fromState = config[field]
		if (isProviderApiLine(fromState)) {
			return fromState
		}
	}

	try {
		const settingsApiLine = getProviderSettingsManager().getProviderSettings(providerSettingsProviderId(providerId))?.apiLine
		if (isProviderApiLine(settingsApiLine)) {
			return settingsApiLine
		}
	} catch {
		Logger.warn(`[SessionFactory] Failed to read ${providerId} API line from providers.json`)
	}

	const sharedField = sharedApiLineMap[providerId]
	if (sharedField) {
		const fromSharedState = config[sharedField]
		if (isProviderApiLine(fromSharedState)) {
			return fromSharedState
		}
	}

	return undefined
}

// ---------------------------------------------------------------------------
// Session config builder
// ---------------------------------------------------------------------------

/**
 * Assemble the session's hook stack.
 *
 * Every layer a session runs with is listed here and nowhere else. It used to
 * be assembled in two places — here and again in `SdkSessionConfigBuilder`,
 * which rebuilds the file-hook layer with a message emitter — and the second
 * one assigned `config.hooks` outright, so the layers added here never reached
 * a real session. Only the tests, which call `buildSessionConfig` directly, saw
 * the full stack. A caller that needs to swap a layer rebuilds the stack
 * through this function rather than replacing the result of it.
 *
 * Order matters: the file-based hook adapter goes first, because a user hook
 * script that stops the run should do so before anything is appended to a
 * result nobody will read.
 */
export function composeSessionHooks(
	fileHooks: AgentHooks | undefined,
	cwd: string,
	rendered?: RenderedPromptTemplate,
): AgentHooks | undefined {
	return mergeAgentHooks([fileHooks, createEditorDiagnosticsHooks({ cwd }), createPromptTemplateHooks({ rendered })])
}

/**
 * The connection subagents and teammates run on, from the Agents tab.
 *
 * Resolved the same way the session's own connection is, from the tab's stored
 * snapshot rather than from `providers.json`: that file holds one entry per
 * provider, the session's model owns it, and a second configuration on the same
 * provider would overwrite the first. Reading the agents' context window out of
 * their own snapshot is what stops Plan, Act, Vision and Agents sharing one.
 *
 * `undefined` means the tab named no provider or no model, which is the signal
 * to leave delegated agents inheriting the session's connection as before.
 */
export async function buildDelegatedAgentConnection(
	primary: ApiConfiguration | undefined,
	storedSnapshot: string | undefined,
): Promise<DelegatedAgentConnectionOverride | undefined> {
	const configuration = buildScopedApiConfiguration(primary, storedSnapshot)
	const namedProvider = snapshotProviderId(storedSnapshot)
	const modelId = snapshotModelId(storedSnapshot)
	if (!configuration || !namedProvider || !modelId) {
		return undefined
	}
	// State written by older builds may carry SDK catalog spellings; the
	// resolvers below are keyed by the legacy ones.
	const providerId = toLegacyApiProvider(namedProvider) ?? namedProvider
	const apiKey = resolveApiKey(providerId, configuration)
	const baseUrl = resolveBaseUrl(providerId, configuration)
	const providerSettings = snapshotProviderSettings(storedSnapshot)

	let ollamaConfig: ReturnType<typeof resolveOllamaProviderConfig> | undefined
	if (providerId === "ollama") {
		// Same priming as the session's own model: ask the server what window
		// this one was built with before resolving one for it, so the first
		// request already carries it rather than reloading the model mid-run.
		await primeDeclaredNumCtx(configuration.ollamaBaseUrl, modelId, fetch)
		// The tab's own settings, passed as the override — so an Agents tab that
		// names no window falls through to what the model itself declares rather
		// than to the number the session's model was given.
		ollamaConfig = resolveOllamaProviderConfig(configuration, modelId, providerSettings ?? {})
	}

	const sdkProviderId = toSdkProviderId(providerId)
	let knownModels: Awaited<ReturnType<typeof getModelsForProvider>> | undefined
	try {
		knownModels = await getModelsForProvider(sdkProviderId)
	} catch (error) {
		Logger.warn(`[Agents] Failed to resolve known models for provider=${sdkProviderId}:`, error)
	}
	const hasKnownModels = !!knownModels && Object.keys(knownModels).length > 0

	return {
		providerId: sdkProviderId,
		modelId,
		...(apiKey ? { apiKey } : {}),
		...(baseUrl !== undefined ? { baseUrl } : {}),
		...(hasKnownModels ? { knownModels } : {}),
		// The proxy/CA-aware fetch belongs here for the same reason it does on
		// the session's own config: without it the agents' model calls fall back
		// to bare global fetch.
		providerConfig: {
			...(ollamaConfig ?? {}),
			providerId: sdkProviderId,
			modelId,
			...(apiKey ? { apiKey } : {}),
			...(baseUrl !== undefined ? { baseUrl } : {}),
			...(hasKnownModels ? { knownModels } : {}),
			fetch,
		},
	}
}

/**
 * Build a CoreSessionConfig from the current state.
 *
 * Reads provider settings from the classic StateManager's ApiConfiguration
 * (which correctly reads from globalState.json + secrets.json), then resolves
 * the provider, model, and API key for the current mode (plan/act).
 *
 * This replaces the previous two-path approach (SDK ProviderSettingsManager +
 * StateManager.buildApiHandlerSettings) which both failed silently.
 */
export async function buildSessionConfig(input: SessionConfigInput): Promise<CoreSessionConfig> {
	const cwd = input.cwd
	if (!cwd) {
		throw new Error("buildSessionConfig requires a cwd resolved by the host controller")
	}
	const workspaceRoot = input.workspaceRoot?.trim() || cwd
	const mode: Mode = input.mode ?? "act"
	const sdkLogger = createSdkLogger()
	const distinctId = getDistinctId()

	let providerId: string | undefined
	let modelId: string | undefined
	let apiKey: string | undefined
	let baseUrl: string | undefined
	let apiLine: ProviderApiLine | undefined
	let apiConfig: ApiConfiguration | undefined
	// Cloud-provider structured options. The core runtime reads these from
	// CoreSessionConfig.providerConfig; without them the SDK gateway never receives
	// region/project/auth fields for inference calls.
	let bedrockProviderConfig: BedrockProviderConfig | undefined
	let vertexProviderConfig: Pick<ProviderSettings, "gcp" | "region"> | undefined
	let sapProviderConfig: SapProviderConfig | undefined
	let ollamaProviderConfig: ReturnType<typeof resolveOllamaProviderConfig> | undefined

	try {
		const stateManager = StateManager.get()
		apiConfig = stateManager.getApiConfiguration()

		// Resolve the provider for the current mode. State written by older
		// builds or other hosts may carry SDK catalog spellings (e.g.
		// `openai-compatible`); fold them back to the legacy spelling the
		// provider-keyed maps below are keyed by.
		const modeProvider = mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider
		providerId = modeProvider ? toLegacyApiProvider(modeProvider) : modeProvider

		if (providerId) {
			// Resolve API key
			apiKey = resolveApiKey(providerId, apiConfig)

			// Resolve model ID
			modelId = resolveModelId(providerId, mode, apiConfig)

			// Resolve base URL
			baseUrl = resolveBaseUrl(providerId, apiConfig)

			// Resolve the regional API line (Qwen/Moonshot/Z AI/MiniMax). The
			// SDK gateway routes to the line's regional endpoint when no
			// explicit base URL is set.
			apiLine = resolveApiLine(providerId, apiConfig)

			// Resolve Bedrock region + AWS authentication options from the legacy
			// ApiConfiguration (StateManager is the VSCode source of truth, not
			// providers.json).
			if (providerId === "bedrock") {
				bedrockProviderConfig = buildBedrockProviderConfig(apiConfig, mode)
			}

			if (providerId === "vertex") {
				vertexProviderConfig = resolveVertexProviderConfig(apiConfig)
			}

			if (providerId === "sapaicore") {
				sapProviderConfig = buildSapProviderConfig(apiConfig, mode)
				baseUrl = sapProviderConfig.baseUrl
			}

			if (providerId === "ollama") {
				// Ask the server what window this model was built with before
				// resolving one for it. Cached per server and model, so this
				// costs one request the first time a model is used and nothing
				// afterwards; a server that will not answer leaves the previous
				// behaviour exactly as it was.
				await primeDeclaredNumCtx(apiConfig.ollamaBaseUrl, modelId, fetch)
				// The window belongs to the profile in force for this mode, not to
				// the provider. `providers.json` has one entry per provider, and
				// Plan and Act are in force at the same time — so two profiles on
				// the same provider had one place between them to keep a context
				// window, whichever was loaded last won, and the other quietly ran
				// on that number. A profile already carries these fields in its
				// snapshot; this is what reads them back per scope.
				const profileSettings = profileProviderSettingsFor(
					stateManager.getGlobalSettingsKey("apiConfigurationProfiles"),
					stateManager.getGlobalSettingsKey("activeApiConfigurationProfile"),
					mode,
				)
				if (profileSettings) {
					Logger.log(`[SessionFactory] Provider settings for ${mode} came from its profile, not the shared entry`)
				}
				ollamaProviderConfig = resolveOllamaProviderConfig(apiConfig, modelId, profileSettings)
			}

			Logger.log(
				`[SessionFactory] Resolved from StateManager: provider=${providerId}, model=${modelId}, hasApiKey=${!!apiKey}`,
			)
		}
	} catch (error) {
		Logger.warn("[SessionFactory] StateManager credential resolution failed:", error)
	}

	// Fallback: try SDK's ProviderSettingsManager only when StateManager did not
	// resolve a provider at all. If the user selected a provider but credentials
	// are missing, keep that provider/model so the UI can surface the right auth
	// state instead of silently switching to a previous provider.
	if (!providerId) {
		try {
			const dataDir = resolveDataDir()
			const manager = getProviderSettingsManager(dataDir)
			const lastUsed = manager.getLastUsedProviderSettings({
				isClinePassEnabled: true,
			})

			if (lastUsed?.provider && lastUsed?.apiKey) {
				// providers.json stores SDK provider ids (e.g. `openai-compatible`);
				// normalize to the legacy spelling used across this factory.
				providerId = toLegacyApiProvider(lastUsed.provider)
				modelId = lastUsed.model
				apiKey = lastUsed.apiKey
				baseUrl = lastUsed.baseUrl
				apiLine = isProviderApiLine(lastUsed.apiLine) ? lastUsed.apiLine : undefined
				Logger.log(`[SessionFactory] Using SDK provider fallback: ${providerId}/${modelId}`)
			}
		} catch (error) {
			Logger.warn("[SessionFactory] SDK ProviderSettingsManager fallback failed:", error)
		}
	}

	// Final defaults. Keep this aligned with the provider catalog so the UI and
	// session factory share one source of truth for default models.
	providerId = providerId ?? DEFAULT_PROVIDER_ID
	if (!modelId && providerHasLocalModelSource(providerId)) {
		// Local-model-source providers: the committed selection lives in
		// providers.json when the legacy state slot is empty (e.g. configs
		// created through the SDK settings store). Never fall through to a
		// catalog default — an empty model id surfaces an explicit "select a
		// model" state instead of silently running a model the user never chose.
		try {
			modelId = getProviderSettingsManager().getProviderSettings(providerSettingsProviderId(providerId))?.model?.trim()
		} catch {
			Logger.warn(`[SessionFactory] Failed to read ${providerId} model from providers.json`)
		}
		modelId = modelId || ""
	} else {
		modelId = modelId ?? getDefaultModelIdForProvider(providerId) ?? getDefaultModelIdForProvider(DEFAULT_PROVIDER_ID) ?? ""
	}
	if (!apiKey && apiConfig) {
		apiKey = resolveApiKey(providerId, apiConfig)
	}
	apiKey = apiKey ?? ""
	const committedRuntimeModel = resolveCommittedRuntimeModel(providerId, mode, modelId)
	const overriddenMaxTokens = committedRuntimeModel?.overrides?.maxTokens
	const maxTokensPerTurn =
		positiveFiniteNumber(overriddenMaxTokens) ??
		(providerId === "openai" ? resolveOpenAiCompatibleMaxTokens(apiConfig, mode) : undefined)
	const temperature = nonNegativeFiniteNumber(committedRuntimeModel?.overrides?.temperature)
	const reasoningConfig =
		providerId === "oca"
			? (resolveOcaReasoningConfig(mode, apiConfig) ?? resolveProviderReasoningConfig(providerId))
			: resolveProviderReasoningConfig(providerId)

	// Build the system prompt using the shared prompt builder. Core still
	// expects callers to provide a concrete systemPrompt, but the prompt builder
	// can derive baseline workspace context from the root path and workspace
	// name, so we avoid duplicating core's richer workspace metadata pass here.
	// Which prompt template governs this session. Resolved once, here: reading
	// the template directories, asking Ollama what a local model actually is,
	// and merging the winner over default.md all happen at this point and
	// nowhere else. A failure leaves `rendered` undefined and the session runs
	// on the built-in prompt, which is what it did before templates existed.
	let renderedTemplate: Awaited<ReturnType<typeof resolveSessionPromptTemplate>>["rendered"]
	try {
		renderedTemplate = (
			await resolveSessionPromptTemplate({
				providerId,
				modelId,
				workspaceRoot,
				baseUrl: apiConfig ? resolveBaseUrl(providerId, apiConfig) : undefined,
			})
		).rendered
	} catch (error) {
		Logger.warn("[SessionFactory] Failed to resolve a prompt template:", error)
	}

	let systemPrompt = ""
	try {
		const workspaceName = resolveWorkspaceName(cwd)
		systemPrompt = buildClineSystemPrompt({
			ide: "VS Code",
			workspaceRoot,
			workspaceName,
			mode: mode === "plan" ? "plan" : "act",
			providerId,
			platform: process.platform,
			basePrompt: renderedTemplate?.system,
		})
		Logger.log(`[SessionFactory] Built system prompt: ${systemPrompt.length} chars`)
	} catch (error) {
		Logger.warn("[SessionFactory] Failed to build system prompt, using minimal fallback:", error)
		systemPrompt = "You are Cline, a highly skilled software engineer. Help the user with their request."
	}

	// Inject preferred language instructions when a non-default language is selected.
	// Mirrors classic src/core/task/index.ts preferredLanguage handling.
	try {
		const preferredLanguageRaw = StateManager.get().getGlobalSettingsKey("preferredLanguage")
		const preferredLanguage = getLanguageKey(preferredLanguageRaw as LanguageDisplay | undefined)
		if (preferredLanguage && preferredLanguage !== DEFAULT_LANGUAGE_SETTINGS) {
			systemPrompt = `${systemPrompt}\n\n# Preferred Language\n\nSpeak in ${preferredLanguage}.`
		}
	} catch (error) {
		Logger.warn("[SessionFactory] Failed to inject preferredLanguage instructions:", error)
	}

	// The one context window for this session.
	//
	// Everything that budgets against the window has to read this and nothing
	// else. They did not, and the consequences were not subtle: the wire carried
	// `num_ctx: 110000` from providers.json while the compaction trigger was
	// computed from a catalog-shaped 128,000, putting the trigger at 115,200 --
	// five thousand tokens beyond the end of the real window. Auto-compaction
	// could never fire, and every long session ran until its per-turn output cap
	// collapsed to nothing.
	//
	// The order is what the user asked for, and it is the order that cannot
	// surprise them: a context size they set is the context size, whatever the
	// model would allow. Asking for 128k from a model that supports 512k means
	// 128k. Only when they have set nothing does the model get to answer, and for
	// Ollama it can answer exactly -- `num_ctx` is in the Modelfile and
	// `/api/show` reports it -- rather than being guessed at by a catalog that
	// has never heard of a local model.
	const configuredContextWindow = positiveFiniteNumber(ollamaProviderConfig?.modelInfo?.contextWindow)
	const declaredContextWindow =
		configuredContextWindow === undefined && toSdkProviderId(providerId) === "ollama"
			? await resolveOllamaContextWindow(apiConfig ? resolveBaseUrl(providerId, apiConfig) : undefined, modelId)
			: undefined
	const sessionContextWindow =
		configuredContextWindow ?? declaredContextWindow ?? positiveFiniteNumber(committedRuntimeModel?.modelInfo?.contextWindow)

	// The per-turn thinking allowance, once it is known. The system prompt states
	// it, and the capped-thinking condenser needs it to tell a turn that stopped
	// thinking from one that ran out of room to think.
	let thinkingBudgetTokens: number | undefined

	// What the server appends to reasoning it cut at the budget, when there is
	// anything to know. Cline's own setting goes on the wire and overrides the
	// model file, so it is the answer where it is set; otherwise the model's own
	// is what will be appended, and Ollama reports it. A model with neither
	// leaves this undefined, and the condenser measures instead of matching.
	let thinkingBudgetMessage: string | undefined

	// The per-turn output cap, resolved once: the system prompt states it, and
	// compaction budgets against it. A configured `num_predict` goes on the wire
	// ahead of the session's cap and wins, so it is the answer wherever the
	// question is "how long can this reply be".
	const configuredNumPredict = positiveFiniteNumber(ollamaProviderConfig?.sampling?.numPredict)
	// What the user or the session actually chose, as opposed to the figure used
	// when nobody has chosen anything. Only the former may overrule a model's own
	// published cap.
	const explicitOutputCap = configuredNumPredict ?? maxTokensPerTurn
	const sessionOutputCap = explicitOutputCap ?? DEFAULT_GATEWAY_MAX_OUTPUT_TOKENS

	// Tell the model about the cap its reply will actually be truncated at.
	try {
		// Both figures below answer the same question: what will the server
		// actually hold this reply to. A configured `num_predict` is that
		// answer — it goes on the wire ahead of the session's cap and wins — so
		// the prompt has to say it. Stating the fallback while sending something
		// smaller tells the model it has room it does not have, which is the
		// same defect as the context window and fails the same way.
		const outputCap = sessionOutputCap
		const contextWindow = sessionContextWindow
		const thinking = await resolveOllamaThinkingAllowance(
			providerId,
			reasoningConfig,
			outputCap,
			contextWindow,
			apiConfig ? resolveBaseUrl(providerId, apiConfig) : undefined,
			modelId,
		)
		systemPrompt = `${systemPrompt}${buildOutputBudgetSection(outputCap, contextWindow, thinking)}`
		thinkingBudgetTokens = thinking?.budgetTokens
		const configuredBudgetMessage = ollamaProviderConfig?.sampling?.thinkBudgetMessage?.trim()
		if (configuredBudgetMessage) {
			thinkingBudgetMessage = configuredBudgetMessage
		} else if (providerId === "ollama" && modelId) {
			const parameters = await resolveOllamaModelParameters(
				apiConfig ? resolveBaseUrl(providerId, apiConfig) : undefined,
				modelId,
			)
			thinkingBudgetMessage = parameters.think_budget_message?.trim() || undefined
		}
		Logger.log(
			`[SessionFactory] Output budget: cap=${outputCap} contextWindow=${contextWindow ?? "unknown"}` +
				(thinking ? ` thinking=${thinking.budgetTokens} (${thinking.level})` : ""),
		)
	} catch (error) {
		Logger.warn("[SessionFactory] Failed to inject output budget instructions:", error)
	}

	const stateManager = StateManager.get()
	// Auto compact is on by default; keep this fallback aligned with the
	// `useAutoCondense` default in shared/storage/state-keys.ts.
	const globalUseAutoCondense = stateManager.getGlobalSettingsKey("useAutoCondense") ?? true
	const compactionStrategy = readCompactionStrategyGlobally()
	const compactionPrompt = (stateManager.getGlobalSettingsKey("compactionPrompt") ?? "").trim()
	// Second-phase retrospective over the reasoning compaction discards.
	// Defaults on: the summary alone leaves a resumed task with no memory of
	// having been wrong, which is how a long run repeats its own mistakes.
	const thinkingCompactionEnabled = stateManager.getGlobalSettingsKey("thinkingCompactionEnabled") ?? true
	const thinkingCompactionPrompt = (stateManager.getGlobalSettingsKey("thinkingCompactionPrompt") ?? "").trim()
	// The condenser that replaces an abandoned think with a note of what it
	// settled. Also defaults on, and stands down by itself where no thinking
	// budget is known, so the switch is about turning it off deliberately.
	const cappedThinkingEnabled = stateManager.getGlobalSettingsKey("cappedThinkingEnabled") ?? true
	const cappedThinkingPrompt = (stateManager.getGlobalSettingsKey("cappedThinkingPrompt") ?? "").trim()
	// Per-tool-result cap. Stored as 0 when unset, which is not "keep nothing":
	// it hands the decision back to the SDK default.
	const maxToolResultChars = positiveFiniteNumber(stateManager.getGlobalSettingsKey("maxToolResultChars"))
	const enableCheckpoints = stateManager.getGlobalSettingsKey("enableCheckpointsSetting") ?? true
	// A second model that reads images for the primary one. Only installed when
	// the user has both enabled it and picked a model for it: without a
	// describer the runtime keeps its existing behaviour of sending images
	// straight through, and falling back to a refusal if the model objects.
	// The vision tab's own provider settings, held in its snapshot rather than
	// in providers.json — the shared entry belongs to the primary model.
	const visionProviderSettings = (() => {
		try {
			const raw = stateManager.getGlobalSettingsKey("visionModeApiConfiguration")
			const parsed = typeof raw === "string" && raw ? JSON.parse(raw) : undefined
			const held = parsed?.providerConfig
			return held && typeof held === "object" ? (held as Record<string, unknown>) : undefined
		} catch {
			return undefined
		}
	})()
	const visionSnapshot = stateManager.getGlobalSettingsKey("visionModeApiConfiguration")
	const visionStatus = resolveVisionModelStatus(stateManager.getGlobalSettingsKey("visionModelEnabled"), visionSnapshot)
	const visionApiConfiguration = visionStatus === "ready" ? buildVisionApiConfiguration(apiConfig, visionSnapshot) : undefined
	// Said out loud, because the silence was the bug: a tester's twenty-thousand
	// line log of a session that failed on "this model does not support image
	// input" contained no line mentioning vision at all, so there was no way to
	// tell a describer that failed from one that was never installed.
	if (visionStatus === "unconfigured") {
		// Which half is missing, not merely that something is. A Vision tab
		// holding a provider and no model reads as configured to anyone looking
		// at it, and said so in the log too.
		const namedProvider = visionSnapshotProviderId(visionSnapshot)
		Logger.warn(
			`[Vision] Vision model is enabled but the Vision tab names ${
				namedProvider ? `no model (provider=${namedProvider})` : "no provider"
			}; images will not be described`,
		)
	} else if (visionApiConfiguration) {
		Logger.log(
			`[Vision] Describer installed: provider=${visionSnapshotProviderId(visionSnapshot)} model=${
				(visionProviderSettings?.selectedModelId as string | undefined) ?? "unset"
			}`,
		)
	}

	// Delegated agents: their own connection, when the Agents tab names one. The
	// same arrangement as vision, for the same reason — `providers.json` holds
	// one entry per provider and the session's model owns it, so a second and a
	// third configuration on that provider have to live in snapshots of their
	// own. That is what gives Plan, Act, Vision and Agents four context windows
	// rather than one shared between whichever of them are on one provider.
	const agentsSnapshot = stateManager.getGlobalSettingsKey("agentsModeApiConfiguration")
	const agentsStatus = resolveScopedModelStatus(stateManager.getGlobalSettingsKey("agentsModelEnabled"), agentsSnapshot)
	const delegatedAgentConnection =
		agentsStatus === "ready" ? await buildDelegatedAgentConnection(apiConfig, agentsSnapshot) : undefined
	if (agentsStatus === "unconfigured") {
		const namedProvider = snapshotProviderId(agentsSnapshot)
		Logger.warn(
			`[Agents] A separate agents model is enabled but the Agents tab names ${
				namedProvider ? `no model (provider=${namedProvider})` : "no provider"
			}; delegated agents will run on the session's model`,
		)
	} else if (delegatedAgentConnection) {
		Logger.log(
			`[Agents] Delegated agents configured: provider=${delegatedAgentConnection.providerId} model=${delegatedAgentConnection.modelId}`,
		)
	}
	const useAutoCondense = input.taskSettings?.useAutoCondense ?? globalUseAutoCondense

	// Core resolves providers against the SDK registry, which uses the SDK's
	// own provider id spelling (e.g. "openai-compatible" rather than the
	// extension's "openai"). Convert before handing the id to core.
	const sdkProviderId = toSdkProviderId(providerId)
	const hostIdentity = await resolveHostIdentity()
	const isMultiRoot = await resolveIsMultiRootWorkspace()
	let knownModels: Awaited<ReturnType<typeof getModelsForProvider>> | undefined
	try {
		// Constructing the settings manager loads providers.json and models.json into
		// the @cline/llms registry. Reading models from that registry ensures custom
		// model overrides are included in the inference provider config, not just in
		// the webview/display path.
		getProviderSettingsManager(resolveDataDir())
		knownModels = await getModelsForProvider(sdkProviderId)
		// Only inject host-resolved metadata that carries real information
		// (catalog/state base or user overrides). Pure fallback fabrications
		// must not reach the runtime; the SDK's own resolution handles those.
		const isPureFallbackModel = committedRuntimeModel?.modelInfoSource === "fallback" && !committedRuntimeModel.overrides
		if (committedRuntimeModel && !isPureFallbackModel && !knownModels?.[modelId]) {
			knownModels = {
				...(knownModels ?? {}),
				[modelId]: toSdkModelInfo(committedRuntimeModel),
			}
		}
	} catch (error) {
		Logger.warn(`[SessionFactory] Failed to resolve known models for provider=${sdkProviderId}:`, error)
	}

	// Ask Ollama whether this model reads images, rather than guessing.
	//
	// The catalog is silent for every model it has never heard of — all the
	// local ones, and anything published since the last catalog build — and the
	// default there is optimistic. That is how a browser screenshot reached a
	// model that could not read one. Ollama reports the answer, so for this
	// provider the tools that attach images can be told before they attach one,
	// instead of the model refusing the turn after the fact.
	const ollamaImageSupport =
		sdkProviderId === "ollama" && modelId ? await resolveOllamaImageSupport(baseUrl, modelId) : undefined
	if (ollamaImageSupport !== undefined) {
		const existing = knownModels?.[modelId]
		const capabilities = new Set<string>(existing?.capabilities ?? [])
		if (ollamaImageSupport) {
			capabilities.add("images")
		} else {
			capabilities.delete("images")
		}
		knownModels = {
			...(knownModels ?? {}),
			[modelId]: { ...(existing ?? {}), capabilities: [...capabilities] },
		} as typeof knownModels
	}

	// The window compaction budgets against.
	//
	// `knownModels[modelId]` is where the runtime reads it from, and for a local
	// model it was filled from the resolved model selection -- catalog, state
	// hint, or fallback -- none of which consult the setting that decides what
	// actually goes on the wire. Writing the session's window here is what makes
	// the compaction trigger and `num_ctx` the same number.
	//
	// `maxInputTokens` goes too, and has to: left at the model's own figure it
	// outranks `contextWindow` in `resolveEffectiveMaxInputTokens`, which is how
	// the stale window survived into the trigger in the first place.
	// Only a window that was actually reported gets written here. The resolved
	// model's own figure can be a catalog guess or a pure fallback, and writing
	// that would fabricate model metadata for a provider whose lookup failed —
	// which is the one thing the known-model path is careful not to do. An
	// existing entry is still amended, because there the metadata is real and
	// only the window is in question.
	const reportedContextWindow = configuredContextWindow ?? declaredContextWindow
	if (sessionContextWindow !== undefined && (reportedContextWindow !== undefined || knownModels?.[modelId])) {
		const existing = knownModels?.[modelId]
		// Spread rather than assigned: writing `undefined` still creates the key,
		// and a key that exists with no value is not the same as no key -- the
		// `-1`-sentinel path asserts the difference.
		const resolvedMaxTokens =
			explicitOutputCap ?? existing?.maxTokens ?? (sdkProviderId === "ollama" ? sessionOutputCap : undefined)
		knownModels = {
			...(knownModels ?? {}),
			[modelId]: {
				...(existing ?? {}),
				contextWindow: sessionContextWindow,
				maxInputTokens: Math.min(existing?.maxInputTokens ?? sessionContextWindow, sessionContextWindow),
				// The per-turn cap belongs here too. Compaction reads it as
				// `model.info.maxTokens` to decide how far a long conversation should
				// be compacted, and for a local model it was never set: every
				// diagnostic read `modelMaxTokens: null`, so the branch aiming at a
				// third of the window was unreachable and the target silently fell
				// back to 70% of the trigger. Measured live, that is a compaction
				// aiming at 54,600 instead of 36,300 -- one reclaimed 10% and the
				// very next turn triggered another.
				// A configured cap is what goes on the wire, so it wins. Absent one,
				// a model that publishes its own figure keeps it -- overwriting a
				// catalog model's real 128,000 with a fallback would be inventing
				// metadata, which is the mistake the guard above exists to prevent.
				// The synthesized default is written only for Ollama, where the model
				// publishes nothing and the session's cap is what the wire will carry;
				// that is what finally gives the long-conversation target its number.
				...(resolvedMaxTokens !== undefined ? { maxTokens: resolvedMaxTokens } : {}),
			},
		} as typeof knownModels
		Logger.log(
			`[SessionFactory] Context window: ${sessionContextWindow} maxTokens=${resolvedMaxTokens ?? "unset"} (model=${modelId})`,
		)
	}

	// Always pass a providerConfig so the proxy/CA-aware fetch reaches the SDK
	// gateway; without it the agent loop uses bare global fetch and corporate
	// proxy/self-signed CA setups fail on JetBrains and CLI. Cloud providers
	// additionally need structured options (region/project/auth/SAP OAuth), which core
	// reads from providerConfig in createAgentModelFromConfig.
	const cloudProviderConfig = bedrockProviderConfig ?? vertexProviderConfig ?? sapProviderConfig ?? ollamaProviderConfig
	// Spread the cloud config first so the explicit fields below — notably the
	// proxy/CA-aware fetch — can never be clobbered if those types gain matching keys.
	const providerConfig = {
		...(cloudProviderConfig ?? {}),
		providerId: sdkProviderId,
		modelId,
		...(apiKey ? { apiKey } : {}),
		...(baseUrl !== undefined ? { baseUrl } : {}),
		...(apiLine !== undefined ? { apiLine } : {}),
		...(knownModels && Object.keys(knownModels).length > 0 ? { knownModels } : {}),
		fetch,
	}

	const config: CoreSessionConfig = {
		providerId: sdkProviderId,
		modelId,
		apiKey,
		baseUrl,
		providerConfig,
		// Also expose the catalog at the top level: manual compaction
		// (sdk-compaction.ts) budgets against config.knownModels[modelId] and
		// otherwise falls back to a conservative 64k input budget.
		...(knownModels && Object.keys(knownModels).length > 0 ? { knownModels } : {}),
		...(delegatedAgentConnection ? { delegatedAgentConnection } : {}),
		cwd,
		workspaceRoot,
		systemPrompt,
		enableTools: true,
		checkpoint: {
			enabled: enableCheckpoints,
		},
		enableSpawnAgent: false,
		enableAgentTeams: false,
		// Sent whether or not auto compaction is on. `enabled` is the only thing
		// that decides whether the transcript gets compacted — the runtime
		// returns no compaction pass without it — but this object is also where
		// the capped-thinking condenser reads its settings, and that condenser
		// has nothing to do with compaction: it rewrites one turn's abandoned
		// reasoning whatever the transcript is doing. Omitting the object when
		// auto-condense was off silently took the condenser with it.
		compaction: {
			enabled: useAutoCondense,
			...(useAutoCondense
				? {
						strategy: compactionStrategy,
						...(compactionPrompt ? { summaryPrompt: compactionPrompt } : {}),
						thinkingSummaryEnabled: thinkingCompactionEnabled,
						...(thinkingCompactionPrompt ? { thinkingSummaryPrompt: thinkingCompactionPrompt } : {}),
					}
				: {}),
			// A turn that ran out of thinking budget is cut mid-sentence and the
			// next turn re-derives the same reasoning from the start. Needs the
			// allowance to detect it, so it stands down on any provider that
			// does not report one.
			...(thinkingBudgetTokens ? { thinkingBudgetTokens } : {}),
			// Turns a good measurement into a statement: where the wording is
			// known, its presence at the end of the reasoning is the server
			// saying it stopped there.
			...(thinkingBudgetMessage ? { cappedThinkingBudgetMessage: thinkingBudgetMessage } : {}),
			cappedThinkingEnabled,
			...(cappedThinkingPrompt ? { cappedThinkingPrompt } : {}),
		},
		disableMcpSettingsTools: true,
		mode: mode === "plan" ? "plan" : "act",
		...reasoningConfig,
		...(maxTokensPerTurn !== undefined ? { maxTokensPerTurn } : {}),
		...(maxToolResultChars !== undefined ? { maxToolResultChars: Math.floor(maxToolResultChars) } : {}),
		...(temperature !== undefined ? { temperature } : {}),
		maxIterations: undefined,
		logger: sdkLogger,
		extensionContext: {
			user: distinctId ? { distinctId } : undefined,
			client: {
				name: hostIdentity?.clineType || ClineClient.VSCode,
				version: hostIdentity?.clineVersion || ExtensionRegistryInfo.version,
				platform: hostIdentity?.platform || undefined,
				platformVersion: hostIdentity?.version || undefined,
				isMultiRoot,
			},
			workspace: {
				rootPath: workspaceRoot,
				cwd,
				workspaceName: resolveWorkspaceName(workspaceRoot),
				ide: "VS Code",
				platform: process.platform,
				mode: mode === "plan" ? "plan" : "act",
			},
			logger: sdkLogger,
		},
		hooks: composeSessionHooks(buildAgentHooks(StateManager.get()), cwd, renderedTemplate),
		...(visionApiConfiguration
			? {
					describeImages: createVisionImageDescriber(visionApiConfiguration, visionProviderSettings),
					// Configuring a vision model means the primary model is not
					// meant to see the image, whether or not it could have.
					alwaysDescribeImages: true,
					// And it means images are usable in this session even though
					// the primary model cannot read one. The tools guard on the
					// primary's own capability, which is the right question when
					// the image would reach it — with a describer installed it
					// never does, so a screenshot the browser tool refused to
					// attach was refused on behalf of a model that was never
					// going to see it.
					//
					// `modelSupportsImages` on the agent config is deliberately
					// left alone: that one decides whether an image the vision
					// model *failed* to describe may be left in place, and the
					// honest answer there is still no.
					toolContextMetadata: { modelSupportsImages: true },
				}
			: {}),
	}

	return config
}

// ---------------------------------------------------------------------------
// Session factory
// ---------------------------------------------------------------------------

/**
 * Build the StartSessionInput for a new task.
 *
 * IMPORTANT: We pass `interactive: true` but NO `prompt`. This creates the
 * session and returns immediately — the runtime host only executes a turn when
 * a prompt is sent. The caller should then call `core.send({ sessionId, prompt })`
 * to run the first turn. This cleanly separates session creation from
 * inference, preventing the gRPC handler from blocking until the first
 * agent turn completes.
 */
export function buildStartSessionInput(config: CoreSessionConfig, input: SessionConfigInput): ClineCoreStartInput {
	return {
		config,
		// Do NOT pass prompt here — start() should return immediately.
		// The prompt is sent separately via core.send() after session creation.
		prompt: undefined,
		interactive: true, // VSCode extension always uses interactive mode
		userImages: input.images,
		userFiles: input.files,
	}
}

/**
 * Build the StartSessionInput for resuming an existing task.
 *
 * When resuming, we don't pass initialMessages — the SDK's session
 * persistence handles loading the conversation history from disk.
 */
export function buildResumeSessionInput(
	sessionId: string,
	prompt: string,
	images?: string[],
	files?: string[],
): { sessionId: string; prompt: string; userImages?: string[]; userFiles?: string[] } {
	return {
		sessionId,
		prompt,
		userImages: images,
		userFiles: files,
	}
}

// ---------------------------------------------------------------------------
// Task history helpers
// ---------------------------------------------------------------------------

/**
 * Get a HistoryItem by ID from the task history.
 */
export function getHistoryItemById(taskId: string, dataDir?: string): HistoryItem | undefined {
	const history = readTaskHistory(dataDir)
	return history.find((item) => item.id === taskId)
}

/**
 * Update a HistoryItem in the task history.
 * Returns the updated history array.
 */
export function updateHistoryItem(item: HistoryItem, dataDir?: string): HistoryItem[] {
	const history = readTaskHistory(dataDir)
	const index = history.findIndex((h) => h.id === item.id)
	if (index >= 0) {
		history[index] = item
	} else {
		history.unshift(item)
	}
	return history
}

/**
 * Create a new HistoryItem from a session start result.
 */
export function createHistoryItemFromSession(sessionId: string, prompt: string, modelId?: string, cwd?: string): HistoryItem {
	return {
		id: sessionId,
		ts: Date.now(),
		task: prompt,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		modelId,
		cwdOnTaskInitialization: cwd,
	}
}

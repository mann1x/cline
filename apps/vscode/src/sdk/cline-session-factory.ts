// Replaces classic task creation from src/core/task/index.ts (see origin/main)
//
// Creates and manages SDK sessions using ClineCore. This factory handles:
// - Creating ClineCore instances with proper configuration
// - Building session config from legacy state (provider, model, API key)
// - Custom session persistence adapter reading ~/.cline/data/tasks/
// - Mapping HistoryItem ↔ SDK session fields
//
// The factory does NOT handle UI concerns — that's the SdkController's job.

import { join } from "node:path"
import {
	type AgentProviderConnection,
	buildWorkspaceMetadata,
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
	type StruggleThresholds,
	toProviderConfig,
} from "@cline/core"
import type { ProviderApiLine, ProviderSamplingOptions, ModelInfo as SdkModelInfo } from "@cline/llms"
import {
	getGeneratedModelsForProvider,
	getModelsForProvider,
	isProviderApiLine,
	MODEL_COLLECTIONS_BY_PROVIDER_ID,
	normalizeParallelSessions,
	OLLAMA_DEFAULT_CONTEXT_WINDOW,
	OLLAMA_DEFAULT_REASONING_EFFORT,
	primeDeclaredNumCtx,
	probeOpencotiProps,
	readResolvedOllamaWindow,
	resolveAgentSlotLimit,
	resolveDefaultMaxOutputTokens,
	resolveLlamaCppThinkBudgetTokens,
	resolveLlamaCppThinkBudgetWindow,
} from "@cline/llms"
import {
	type AgentHooks,
	buildClineSystemPrompt,
	buildOutputBudgetSection,
	isClineProvider,
	isOllamaNativeProvider,
	normalizeAgentWindowShare,
	type PromptTemplateCompactionId,
	type RenderedPromptTemplate,
	resolveOutputBudgetTokens,
} from "@cline/shared"
import { agentNodeLabels, PRIMARY_AGENT_NODE_ID, parseAgentNodes, polykvPriorityZeroApplies } from "@shared/agent-nodes"
import type { ApiConfiguration } from "@shared/api"
import { profileProviderSettingsFor } from "@shared/api-config-profiles"
import { scopedContextWindow } from "@shared/api-config-snapshot"
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
import { getProviderModelIdKey } from "@shared/storage/provider-keys"
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
import {
	createAgentProfileConnectionResolver,
	createAgentProfileNameLister,
	listAgentProfileEndpoints,
} from "./agent-profile-connection"
import { type BedrockProviderConfig, buildBedrockProviderConfig } from "./bedrock-config"
import { createEditorDiagnosticsHooks } from "./editor-diagnostics"
import { createEscalationApprover } from "./escalation-approval"
import { buildAgentHooks } from "./hooks-adapter"
import { appraiseEscalationWithJev, buildJevPromptSection, isJevConfigured, readJevSettings } from "./jev-config"
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
	resolveOllamaToolSupport,
} from "./ollama-model-family"
import { withOllamaNativeDefault } from "./ollama-native"
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
	// Seed from the SDK capability list preserved at the catalog boundary
	// (`adaptSdkModelInfo`), then layer user overrides and the legacy boolean
	// projections on top. The preserved list is the only source that carries
	// capabilities without a legacy boolean (e.g. `tools`), and the SDK treats
	// a populated capabilities array as authoritative — reconstructing one
	// purely from the booleans silently disables everything they don't cover.
	const preservedCapabilities = modelInfo.capabilities as NonNullable<SdkModelInfo["capabilities"]> | undefined
	const capabilities = new Set<NonNullable<SdkModelInfo["capabilities"]>[number]>([
		...(preservedCapabilities ?? []),
		...((selection.overrides?.capabilities ?? []) as NonNullable<SdkModelInfo["capabilities"]>),
	])
	const setCapability = (capability: NonNullable<SdkModelInfo["capabilities"]>[number], enabled: boolean): void => {
		if (enabled) capabilities.add(capability)
		else capabilities.delete(capability)
	}
	if (modelInfo.supportsImages !== undefined) setCapability("images", modelInfo.supportsImages)
	setCapability("prompt-cache", modelInfo.supportsPromptCache)
	if (modelInfo.supportsReasoning !== undefined) setCapability("reasoning", modelInfo.supportsReasoning)
	if (selection.overrides?.supportsAttachments !== undefined) setCapability("files", selection.overrides.supportsAttachments)
	if (preservedCapabilities === undefined || preservedCapabilities.length === 0) {
		// No authoritative SDK list survived to here (dynamic-list snapshot,
		// fallback metadata, or a custom model). The array we are rebuilding
		// from booleans must still carry a definitive tool-calling signal,
		// because a non-empty capabilities array without "tools" reads as
		// "cannot call tools" to the SDK runtime. Legacy metadata only models
		// tool support for OpenAI-compatible entries via `supportsTools`.
		//
		// An EMPTY array is the same "no signal" state as an absent one —
		// modelHasCapability treats both as unspecified — and configs carried
		// over from before the field existed (or round-tripped through a
		// boundary that defaults it to []) land exactly here. Guarding only
		// `undefined` let those custom models keep a non-empty, tool-less
		// array once any boolean projection (e.g. reasoning) populated it,
		// silently disabling tool calling at the runtime gate (#13463).
		const supportsTools = (modelInfo as { supportsTools?: boolean }).supportsTools
		setCapability("tools", supportsTools !== false)
	}

	const maxTokens = positiveFiniteNumber(modelInfo.maxTokens)
	const contextWindow = positiveFiniteNumber(modelInfo.contextWindow)
	const maxInputTokens =
		positiveFiniteNumber(selection.overrides?.maxInputTokens) ?? positiveFiniteNumber(modelInfo.maxInputTokens)
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
		...(modelInfo.operation !== undefined ? { operation: modelInfo.operation } : {}),
		...(modelInfo.operationModes !== undefined ? { operationModes: [...modelInfo.operationModes] } : {}),
		...(modelInfo.modalities !== undefined ? { modalities: modelInfo.modalities } : {}),
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
/**
 * Engines that take a per-turn thinking budget, and where the number comes from.
 *
 * Ollama resolves the budget itself from an effort level, so it is asked. A
 * llama.cpp server -- opencoti included -- takes `reasoning_budget_tokens`, an
 * absolute count, and has no notion of a level and no endpoint that would
 * answer for one: the number has to be resolved here, from the same table, so
 * that `high` means the same thing whichever engine answers.
 */
function thinkingEngine(providerId: string): "ollama" | "llamacpp" | undefined {
	const sdkProviderId = toSdkProviderId(providerId)
	if (isOllamaNativeProvider(sdkProviderId)) {
		return "ollama"
	}
	return sdkProviderId === "opencoti" || sdkProviderId === "openai-compatible" ? "llamacpp" : undefined
}

/**
 * The budget message this session sends, for any provider that has one.
 *
 * Only the value Cerebriline itself puts on the wire; a model's own default is
 * Ollama's to report and is read separately. Advisory throughout -- a condenser
 * with no message to match measures instead.
 */
function readConfiguredThinkBudgetMessage(providerId: string): string | undefined {
	try {
		const settings = getProviderSettingsManager(resolveDataDir()).getProviderSettings(providerSettingsProviderId(providerId))
		return settings?.sampling?.thinkBudgetMessage?.trim() || undefined
	} catch (error) {
		Logger.warn("[SessionFactory] Failed to read the configured think budget message:", error)
		return undefined
	}
}

/**
 * The thinking budget this session will actually send, whoever computes it.
 *
 * This used to answer only for Ollama, and the omission was invisible in the
 * worst way: the fork already sends `reasoning_budget_tokens` to a llama.cpp
 * server, so the budget went out on the wire while the session knew nothing
 * about it. The system prompt stated no thinking bound, and the discarded-turn
 * retrospective had no budget message to recognise a capped think by -- so a
 * turn that spent its whole allowance reasoning was discarded with its
 * reasoning unread, which is the one case that machinery exists for.
 */
/**
 * This provider's stored settings, or nothing if they cannot be read.
 *
 * Every caller here wants one field off the same record and each was reaching
 * for it differently -- one through `ollamaProviderConfig`, one through a
 * try/catch around the manager. Both failure modes are advisory: a settings
 * store that will not answer must leave the session on its defaults rather than
 * fail to start.
 */
function readProviderStoredSettings(providerId: string): Record<string, unknown> | undefined {
	try {
		return getProviderSettingsManager(resolveDataDir()).getProviderSettings(providerSettingsProviderId(providerId)) as
			| Record<string, unknown>
			| undefined
	} catch (error) {
		Logger.warn("[SessionFactory] Failed to read provider settings:", error)
		return undefined
	}
}

function readProviderSampling(providerId: string): { numPredict?: number } | undefined {
	return readProviderStoredSettings(providerId)?.sampling as { numPredict?: number } | undefined
}

function readProviderOutputBudget(providerId: string): { mode?: "auto" | "manual"; maxTokens?: number } | undefined {
	return readProviderStoredSettings(providerId)?.outputBudget as { mode?: "auto" | "manual"; maxTokens?: number } | undefined
}

export async function resolveThinkingAllowance(
	providerId: string,
	reasoning: SessionReasoningConfig,
	outputCap: number,
	contextWindow: number | undefined,
	baseUrl: string | undefined,
	modelId: string | undefined,
): Promise<{ level: string; budgetTokens: number } | undefined> {
	const engine = thinkingEngine(providerId)
	if (!engine || reasoning.thinking === false || !modelId) {
		return undefined
	}

	let numPredict: number | undefined
	let configuredBudget: string | undefined
	try {
		const settings = getProviderSettingsManager(resolveDataDir()).getProviderSettings(providerSettingsProviderId(providerId))
		numPredict = positiveFiniteNumber(settings?.sampling?.numPredict)
		configuredBudget = settings?.sampling?.thinkBudget?.trim() || undefined
	} catch (error) {
		// Advisory: the session's own cap is the sensible stand-in.
		Logger.warn("[SessionFactory] Failed to read sampling settings:", error)
	}

	// The level this session will send. The vendor fills in its default when
	// nothing set one, so that is the level to ask about — asking about "no
	// level" would answer for a request this session never makes.
	const think = reasoning.reasoningEffort ?? OLLAMA_DEFAULT_REASONING_EFFORT
	// A configured num_predict is the cap the server will apply; the agent's own
	// per-turn cap only stands in when nothing more specific was set.
	const effectiveNumPredict = numPredict ?? outputCap

	if (engine === "llamacpp") {
		// A configured `thinkBudget` may be a bare token count, in which case it
		// is the answer and no level is involved. Same tri-valued field the
		// sampler reads, resolved by the same function, so the prompt cannot
		// state a bound different from the one on the wire.
		const level = configuredBudget || think
		const budgetTokens = resolveLlamaCppThinkBudgetTokens(
			level,
			resolveLlamaCppThinkBudgetWindow(contextWindow, effectiveNumPredict),
		)
		return budgetTokens === undefined ? undefined : { level, budgetTokens }
	}

	return resolveOllamaThinkBudget(baseUrl, modelId, {
		think,
		numPredict: effectiveNumPredict,
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
 * What this host calls itself, in the prompt.
 *
 * One constant because it is now read twice: the system prompt's `IDE:` line
 * and the `{{IDE_NAME}}` token a tool description may carry. Two spellings of
 * the same host would be the sort of drift nothing reports.
 */
const HOST_IDE_NAME = "VS Code"

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
	// Ollama or xOllama: both keep these settings under their own id.
	providerId = "ollama",
): OllamaProviderConfig {
	// providers.json (`contextWindow`) is the source of truth; the legacy
	// StateManager string is a migration fallback (the config store mirrors
	// writes to both).
	let settingsContextWindow: number | undefined
	try {
		const value = (overrideSettings ?? getProviderSettingsManager().getProviderSettings(providerId))?.contextWindow
		settingsContextWindow = typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
	} catch {
		Logger.warn("[SessionFactory] Failed to read Ollama settings from providers.json")
	}
	let sampling: ProviderSamplingOptions | undefined
	try {
		const stored = (overrideSettings ?? getProviderSettingsManager().getProviderSettings(providerId))?.sampling
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
	// The legacy global field is Ollama's alone.
	const scoped = overrideSettings !== undefined || providerId !== "ollama"
	const raw = scoped ? undefined : config.ollamaApiOptionsCtxNum?.trim()
	const parsed = raw ? Number(raw) : Number.NaN
	const legacyContextWindow = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
	// The model's own `num_ctx` sits between the user's setting and the
	// constant. Without it a model whose Modelfile says 128000 was loaded at
	// 32768: sending a default overrides the model's own value, and Ollama
	// cannot tell a considered 32768 from a placeholder one. Primed by
	// `buildSessionConfig` before this runs, so the first request already has
	// it — a `num_ctx` that changes between turns reloads the model mid-task.
	// A cloud model declares no `num_ctx` at all -- its `/api/show` carries no
	// `parameters` block -- so this reads the published window from the
	// recommendations list, or the trained one from `model_info`, for those.
	const declaredContextWindow = readResolvedOllamaWindow(ollamaNativeBaseUrl(providerId, config), modelId)
	const contextWindow = settingsContextWindow ?? legacyContextWindow ?? declaredContextWindow ?? OLLAMA_DEFAULT_CONTEXT_WINDOW
	const timeoutMs = config.requestTimeoutMs
	return {
		...(typeof timeoutMs === "number" && timeoutMs > 0 ? { timeoutMs } : {}),
		...(sampling ? { sampling } : {}),
		...(modelId ? { modelInfo: { id: modelId, name: modelId, contextWindow } } : {}),
	}
}

/**
 * The server an Ollama-API provider talks to. Ollama's is its legacy field,
 * exactly as stored: the per-server caches (`num_ctx`, capabilities) are keyed
 * by it, so it is not normalized here. xOllama's is its configured base URL,
 * else its default port.
 */
export function ollamaNativeBaseUrl(providerId: string, config: ApiConfiguration): string | undefined {
	if (providerId === "ollama") {
		return config.ollamaBaseUrl
	}
	return withOllamaNativeDefault(providerId, resolveBaseUrl(providerId, config))
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
	return mergeAgentHooks([
		fileHooks,
		createEditorDiagnosticsHooks({ cwd }),
		createPromptTemplateHooks({
			rendered,
			ideName: HOST_IDE_NAME,
			// Both hosts report it, because the comparison that needs it is
			// between them: a difference in what the model was told about its
			// tools is invisible unless each side says what it sent.
			log: (message) => Logger.log(message),
		}),
	])
}

/**
 * Resolves a provider other than the session's, for a configured subagent whose
 * frontmatter names one.
 *
 * Core cannot do this itself: it would have to guess where the provider store
 * lives, and this host's follows its own data directory rather than the default
 * path. Without it a subagent on a second provider inherited the session's base
 * URL, key and context window along with the new provider id — a request to the
 * wrong server, which fails as an auth error or, worse, succeeds against a
 * model nobody chose.
 */
/**
 * The thresholds the tab holds, as a block core can read -- or nothing.
 *
 * Two absences have to stay distinguishable here. A field the user never
 * touched must not reach core at all, because core treats any number it is
 * given as the setting and only a missing one falls back to its own constant.
 * And the whole block is dropped when no field survives, so a session with an
 * untouched tab is byte-identical to one built before this setting existed.
 */
function pickThresholds(given: Record<string, number | undefined>): StruggleThresholds | undefined {
	const chosen = Object.entries(given).filter(([, value]) => typeof value === "number" && value > 0)
	return chosen.length > 0 ? (Object.fromEntries(chosen) as StruggleThresholds) : undefined
}

function resolveAgentProviderConnection(providerId: string): AgentProviderConnection | undefined {
	try {
		const stored = getProviderSettingsManager(resolveDataDir()).getProviderSettings(providerId)
		if (!stored) {
			return undefined
		}
		const providerConfig = toProviderConfig(stored)
		return {
			apiKey: providerConfig.apiKey,
			baseUrl: providerConfig.baseUrl,
			headers: providerConfig.headers,
			knownModels: providerConfig.knownModels,
			providerConfig,
		}
	} catch (error) {
		Logger.warn(`[Agents] Failed to resolve provider "${providerId}" for a subagent:`, error)
		return undefined
	}
}

/**
 * The parallel-session count stored on the shared provider entry.
 *
 * Only consulted when no profile is in force for the scope: a profile that
 * carries the field owns it, in the same way it owns the context window.
 */
function readStoredParallelSessions(providerId: string | undefined): unknown {
	if (!providerId) {
		return undefined
	}
	try {
		return getProviderSettingsManager().getProviderSettings(providerId)?.parallelSessions
	} catch {
		return undefined
	}
}

/**
 * How many agents each endpoint that is *not* the session's will serve at once.
 *
 * The session's own count is `maxConcurrentAgents`, and until now it was the
 * only one: every endpoint's gate was built from it, so an agent whose profile
 * named a four-slot server was still held to the lead's one and queued behind
 * its own siblings for slots that server had free.
 *
 * Only endpoints with a count actually configured are listed. An endpoint
 * nobody has answered for keeps inheriting the session's, which is exactly what
 * it did before this existed — the alternative, filing everything unanswered
 * under the honest default of one, would quietly serialise an agent on a cloud
 * provider that had been fanning out.
 *
 * Profiles first, because core takes the first entry naming an endpoint and a
 * profile's own count is the more specific answer; the shared provider entries
 * follow, for the agents that name a `providerId` and no profile.
 */
function collectAgentSlotLimits(
	storedProfiles: string | undefined,
	primary: ApiConfiguration | undefined,
): CoreSessionConfig["agentSlotLimits"] {
	const entries: Array<{ providerId?: string; baseUrl?: string; limit: number }> = []
	const add = (providerId: string, baseUrl: string | undefined, parallelSessions: unknown): void => {
		const limit = normalizeParallelSessions(parallelSessions)
		if (limit === undefined) {
			return
		}
		entries.push({ providerId, ...(baseUrl ? { baseUrl } : {}), limit })
	}

	for (const endpoint of listAgentProfileEndpoints({
		storedProfiles,
		primary,
		storedParallelSessions: readStoredParallelSessions,
	})) {
		add(endpoint.providerId, endpoint.baseUrl, endpoint.parallelSessions)
	}

	try {
		const manager = getProviderSettingsManager(resolveDataDir())
		for (const providerId of Object.keys(manager.read().providers ?? {})) {
			add(
				providerId,
				manager.getProviderConfig(providerId)?.baseUrl,
				manager.getProviderSettings(providerId)?.parallelSessions,
			)
		}
	} catch (error) {
		Logger.warn("[Agents] Failed to read stored providers for per-endpoint agent slots:", error)
	}

	return entries.length > 0 ? entries : undefined
}

/**
 * The tool-result cap stored on the shared provider entry.
 *
 * Read the same way as the parallel-session count, and for the same reason: a
 * profile that carries the field owns it, and the shared entry answers only
 * when no profile is in force. The global setting is the last word, so a
 * configuration written before this field existed behaves exactly as it did.
 */
function readStoredMaxToolResultChars(providerId: string | undefined): unknown {
	if (!providerId) {
		return undefined
	}
	try {
		return getProviderSettingsManager().getProviderSettings(providerId)?.maxToolResultChars
	} catch {
		return undefined
	}
}

/**
 * The tools this configuration withholds, from wherever it is configured.
 *
 * Shaped like `readStoredMaxToolResultChars` above and read the same way,
 * because it is the same kind of setting: it belongs to the configuration, not
 * to the provider. Plan, Act, Vision and Agents are in force at the same time
 * and providers.json has one entry per provider, so a profile's own snapshot
 * is asked first and the shared entry is the fallback.
 *
 * Only a deny list comes back. A selection can withhold a tool and nothing
 * else: whether a tool exists at all is answered by whatever configures it,
 * and a profile that could override that would be a switch that does nothing.
 */
function readToolSelection(
	value: unknown,
): { disabled?: string[]; readLimitEnabled?: boolean; readLimitChars?: number } | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined
	}
	const record = value as { disabled?: unknown; readLimitEnabled?: unknown; readLimitChars?: unknown }
	const names = Array.isArray(record.disabled)
		? record.disabled.filter((name): name is string => typeof name === "string" && name.trim() !== "")
		: []
	const readLimitChars =
		typeof record.readLimitChars === "number" && Number.isFinite(record.readLimitChars) && record.readLimitChars > 0
			? Math.floor(record.readLimitChars)
			: undefined
	const section = {
		...(names.length > 0 ? { disabled: names } : {}),
		// Only `false` counts: on is the default, so a stored `true` and an
		// absent field mean the same thing and are stored the same way.
		...(record.readLimitEnabled === false ? { readLimitEnabled: false } : {}),
		...(readLimitChars !== undefined ? { readLimitChars } : {}),
	}
	return Object.keys(section).length > 0 ? section : undefined
}

/**
 * The profile's provider settings laid over the shared entry.
 *
 * A profile that is silent about a field is not a profile that overrides it.
 * `resolveOllamaProviderConfig` picks its source with `??` on the *object*, so
 * handing it a profile snapshot made providers.json unreachable for every
 * field the snapshot happened not to carry -- and a window typed into the
 * panel then changed the panel, the context bar and nothing else, while the
 * session kept resolving from the model's declared `num_ctx`. There is no
 * scope boundary here to defend: loading a profile writes providers.json, so
 * the two are the same store seen at two moments, and the later one is the
 * user's most recent word.
 *
 * Scoped tabs are a different matter and keep their own rule -- an Agents tab
 * that names no window must fall to what the model declares rather than to the
 * session model's number -- which is why this merge is applied here and not
 * inside the resolver.
 */
function profileOverSharedEntry(
	profileSettings: Record<string, unknown> | undefined,
	providerId: string | undefined,
): Record<string, unknown> | undefined {
	if (!profileSettings) {
		return undefined
	}
	try {
		const shared = providerId ? getProviderSettingsManager().getProviderSettings(providerId) : undefined
		return shared && typeof shared === "object"
			? { ...(shared as Record<string, unknown>), ...profileSettings }
			: profileSettings
	} catch {
		return profileSettings
	}
}

function readStoredToolSelection(providerId: string | undefined): unknown {
	if (!providerId) {
		return undefined
	}
	try {
		return getProviderSettingsManager().getProviderSettings(providerId)?.tools
	} catch {
		return undefined
	}
}

/**
 * The connection a scoped tab names, for a model that is not the session's.
 *
 * Resolved the same way the session's own connection is, from the tab's stored
 * snapshot rather than from `providers.json`: that file holds one entry per
 * provider, the session's model owns it, and a second configuration on the same
 * provider would overwrite the first. Reading a tab's context window out of its
 * own snapshot is what stops Plan, Act, Vision, Agents and Escalation sharing
 * one.
 *
 * Two tabs resolve through here — Agents, whose model runs subagents and
 * teammates, and Escalation, whose model is the expert a stuck session hands
 * over to. The resolution is identical; only `label` differs, and it exists so
 * a log line says which tab was being read.
 *
 * `undefined` means the tab named no provider or no model, which is the signal
 * to leave the feature inheriting the session's connection, or off entirely.
 */
export async function buildDelegatedAgentConnection(
	primary: ApiConfiguration | undefined,
	storedSnapshot: string | undefined,
	label: "Agents" | "Escalation" = "Agents",
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
	if (isOllamaNativeProvider(providerId)) {
		// Same priming as the session's own model: ask the server what window
		// this one was built with before resolving one for it, so the first
		// request already carries it rather than reloading the model mid-run.
		await primeDeclaredNumCtx(ollamaNativeBaseUrl(providerId, configuration), modelId, fetch)
		// The tab's own settings, passed as the override — so an Agents tab that
		// names no window falls through to what the model itself declares rather
		// than to the number the session's model was given.
		ollamaConfig = resolveOllamaProviderConfig(configuration, modelId, providerSettings ?? {}, providerId)
	}

	const sdkProviderId = toSdkProviderId(providerId)
	let knownModels: Awaited<ReturnType<typeof getModelsForProvider>> | undefined
	try {
		knownModels = await getModelsForProvider(sdkProviderId)
	} catch (error) {
		Logger.warn(`[${label}] Failed to resolve known models for provider=${sdkProviderId}:`, error)
	}

	// The tab's own window, for every provider but Ollama (resolved above, with
	// the server's declared `num_ctx` behind it).
	//
	// Without this the agents took the `models.json` catalog entry for their
	// model id -- one entry per id, shared by every scope that names it, and on
	// pandorum written by an old unscoped edit: Node1 said 128000 and the agents
	// ran at 256000. Read by the resolver the tab displays from, so the number
	// in the box is the number the agents get. A tab that names none falls
	// through to the catalog, as before.
	const scopedWindow = isOllamaNativeProvider(providerId) ? undefined : scopedContextWindow(providerSettings)
	let scopedModelInfo: SdkModelInfo | undefined
	if (scopedWindow !== undefined) {
		const known = knownModels?.[modelId]
		scopedModelInfo = {
			...known,
			id: modelId,
			name: known?.name ?? modelId,
			contextWindow: scopedWindow,
			maxInputTokens: Math.min(known?.maxInputTokens ?? scopedWindow, scopedWindow),
		}
		// Into the catalog copy as well: the runtime reads `knownModels[modelId]`
		// ahead of `modelInfo`, so the catalog's 256000 left there still wins.
		knownModels = { ...(knownModels ?? {}), [modelId]: scopedModelInfo }
		Logger.log(`[${label}] Context window: ${scopedWindow} from the tab (model=${modelId})`)
	}
	const hasKnownModels = !!knownModels && Object.keys(knownModels).length > 0

	// The tab's own tool-result cap, when it names one. Absent, the delegated
	// agents keep the session's — the same rule the rest of this override
	// follows, and the reason a tab that changes nothing changes nothing.
	const scopedMaxToolResultChars = positiveFiniteNumber(providerSettings?.maxToolResultChars)

	// The tab's thinking, temperature and output cap. Each is taken only when
	// the tab states it, and then it is the tab's whole answer: a tab with
	// thinking off must not keep the lead's budget, and a tab on `auto` output
	// must not keep the lead's cap -- so those keys are present and undefined,
	// which is what overrides and pins them downstream.
	const scopedReasoning = providerSettings?.reasoning as ProviderReasoningSettings | undefined
	const reasoningOverride = scopedReasoning
		? { ...normalizeProviderReasoningSettings(scopedReasoning), thinkingBudgetTokens: undefined }
		: {}
	const scopedSampling = providerSettings?.sampling as { temperature?: unknown; numPredict?: unknown } | undefined
	const scopedTemperature =
		typeof scopedSampling?.temperature === "number" && Number.isFinite(scopedSampling.temperature)
			? scopedSampling.temperature
			: undefined
	const scopedOutputBudget = providerSettings?.outputBudget as { mode?: unknown; maxTokens?: unknown } | undefined
	const scopedOutputCap =
		positiveFiniteNumber(scopedSampling?.numPredict) ??
		(scopedOutputBudget?.mode === "manual" ? positiveFiniteNumber(scopedOutputBudget.maxTokens) : undefined)
	const outputCapOverride =
		scopedOutputCap !== undefined || scopedOutputBudget !== undefined ? { maxTokensPerTurn: scopedOutputCap } : {}

	// "Agent window" (ruled 2026-09-25), opencoti agent nodes only: the tab's
	// share of the way from the minimum a turn needs to the node's window,
	// which is what the agents floor their sessions at (`num_ctx_min`). The
	// window itself is the model's as this connection resolves it, and the
	// floor is measured at the wire, where the system prompt, the tool schemas
	// and the output cap are exact (`opencoti-agent-window.ts`). The Escalation
	// tab resolves through here too and has no slider, so the expert is left
	// as it was. Ollama and llama.cpp have no negotiation: the window is what
	// is sent, and the share is inert.
	const agentWindowOverride =
		label === "Agents" && sdkProviderId === "opencoti"
			? {
					agentWindow: {
						sharePercent: normalizeAgentWindowShare(
							(providerSettings?.agentWindow as { sharePercent?: unknown } | undefined)?.sharePercent,
						),
					},
				}
			: {}

	return {
		providerId: sdkProviderId,
		modelId,
		...(apiKey ? { apiKey } : {}),
		...(baseUrl !== undefined ? { baseUrl } : {}),
		...(hasKnownModels ? { knownModels } : {}),
		...(scopedMaxToolResultChars !== undefined ? { maxToolResultChars: scopedMaxToolResultChars } : {}),
		...reasoningOverride,
		...(scopedTemperature !== undefined ? { temperature: scopedTemperature } : {}),
		...outputCapOverride,
		// The proxy/CA-aware fetch belongs here for the same reason it does on
		// the session's own config: without it the agents' model calls fall back
		// to bare global fetch.
		providerConfig: {
			...(ollamaConfig ?? {}),
			...(scopedModelInfo ? { modelInfo: scopedModelInfo } : {}),
			// The tab's PolyKV section, which this list had been leaving out:
			// a node on an opencoti server ran with pooling and swarms off
			// whatever its tab said, and nothing could tell a node offered
			// swarms from one that was not.
			...(providerSettings?.polykv ? { polykv: providerSettings.polykv } : {}),
			// The tab's sampler, which this list had been leaving out the same
			// way: the request builders read `providerConfig.sampling`, so an
			// opencoti node sent the engine's defaults whatever its tab said.
			...(providerSettings?.sampling ? { sampling: providerSettings.sampling as ProviderSamplingOptions } : {}),
			...reasoningOverride,
			...agentWindowOverride,
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
 * One compaction prompt, by precedence: the matched template's
 * `# compaction: <id>` section, then the Features setting, then "" -- which
 * leaves the key unset so core uses its built-in prompt.
 */
export function resolveCompactionPrompt(
	templateCompaction: Readonly<Partial<Record<PromptTemplateCompactionId, string>>>,
	id: PromptTemplateCompactionId,
	setting: string,
): string {
	return templateCompaction[id]?.trim() || setting.trim()
}

/** `{ [key]: text }` when there is text, `{}` when there is none -- a blank must mean "the built-in". */
function optionalPrompt<K extends string>(key: K, text: string): Partial<Record<K, string>> {
	return text ? ({ [key]: text } as Record<K, string>) : {}
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
	// The provider settings the profile in force for this mode carries, or
	// `undefined` when this mode is running on the shared providers.json entry.
	// Hoisted because two things read it now: the Ollama context window, and the
	// parallel-session count, which every provider has.
	let profileSettings: Record<string, unknown> | undefined

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
			// The window and the slot count belong to the profile in force for this
			// mode, not to the provider. `providers.json` has one entry per provider,
			// and Plan and Act are in force at the same time — so two profiles on the
			// same provider had one place between them, whichever was loaded last won,
			// and the other quietly ran on that number. A profile already carries
			// these fields in its snapshot; this is what reads them back per scope.
			profileSettings = profileProviderSettingsFor(
				stateManager.getGlobalSettingsKey("apiConfigurationProfiles"),
				stateManager.getGlobalSettingsKey("activeApiConfigurationProfile"),
				mode,
			)
			if (profileSettings) {
				Logger.log(`[SessionFactory] Provider settings for ${mode} came from its profile, not the shared entry`)
			}

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

			if (isOllamaNativeProvider(providerId)) {
				// Ask the server what window this model was built with before
				// resolving one for it. Cached per server and model, so this
				// costs one request the first time a model is used and nothing
				// afterwards; a server that will not answer leaves the previous
				// behaviour exactly as it was.
				await primeDeclaredNumCtx(ollamaNativeBaseUrl(providerId, apiConfig), modelId, fetch)
				ollamaProviderConfig = resolveOllamaProviderConfig(
					apiConfig,
					modelId,
					profileOverSharedEntry(profileSettings, providerId),
					providerId,
				)
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
	// Include rich workspace metadata so Cline API observability can extract
	// git remotes and the latest commit hash from the system message.
	let workspaceMetadata: string | undefined
	if (isClineProvider(providerId)) {
		try {
			workspaceMetadata = await buildWorkspaceMetadata(workspaceRoot)
		} catch (error) {
			Logger.warn("[SessionFactory] Failed to build workspace metadata:", error)
		}
	}

	let systemPrompt = ""
	try {
		const workspaceName = resolveWorkspaceName(cwd)
		systemPrompt = buildClineSystemPrompt({
			ide: HOST_IDE_NAME,
			workspaceRoot,
			workspaceName,
			metadata: workspaceMetadata,
			mode: mode === "plan" ? "plan" : "act",
			providerId,
			platform: process.platform,
			basePrompt: renderedTemplate?.system,
			// opencoti lifts the per-session values into a turn of their own, so
			// every conversation on the server opens with the same system turn
			// and shares one prefix (sdk polykv-lead.ts).
			environmentTurn: providerId === "opencoti",
		})
		Logger.log(`[SessionFactory] Built system prompt: ${systemPrompt.length} chars`)
	} catch (error) {
		Logger.warn("[SessionFactory] Failed to build system prompt, using minimal fallback:", error)
		systemPrompt = "You are Cerebriline, a highly skilled software engineer. Help the user with their request."
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

	// When to reach for `jev`, only in a session that has it. Its description
	// says how to call it; this says when, which is the part a model skips.
	try {
		if (isJevConfigured()) {
			systemPrompt = `${systemPrompt}${buildJevPromptSection(readJevSettings())}`
		}
	} catch (error) {
		Logger.warn("[SessionFactory] Failed to add the Jev section:", error)
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
	//
	// Off Ollama the configured window is the one the profile in force for this
	// mode names, by the resolver every scoped tab uses. It used to be nothing:
	// an opencoti lead read only the `models.json` entry for its model id, which
	// every scope naming that id shares, so a profile with its own window ran
	// on whichever number the last unscoped edit had left in the catalog. With
	// no profile, or one that names no window, the catalog entry -- which is
	// what this mode's own panel writes -- stays the answer.
	const configuredContextWindow = isOllamaNativeProvider(toSdkProviderId(providerId))
		? positiveFiniteNumber(ollamaProviderConfig?.modelInfo?.contextWindow)
		: scopedContextWindow(profileSettings)
	const declaredContextWindow =
		configuredContextWindow === undefined && isOllamaNativeProvider(toSdkProviderId(providerId))
			? await resolveOllamaContextWindow(apiConfig ? resolveBaseUrl(providerId, apiConfig) : undefined, modelId)
			: undefined
	const sessionContextWindow =
		configuredContextWindow ?? declaredContextWindow ?? positiveFiniteNumber(committedRuntimeModel?.modelInfo?.contextWindow)

	// The per-turn thinking allowance, once it is known. The system prompt states
	// it, and the capped-thinking condenser needs it to tell a turn that stopped
	// thinking from one that ran out of room to think.
	let thinkingBudgetTokens: number | undefined

	// What the server appends to reasoning it cut at the budget, when there is
	// anything to know. Cerebriline's own setting goes on the wire and overrides the
	// model file, so it is the answer where it is set; otherwise the model's own
	// is what will be appended, and Ollama reports it. A model with neither
	// leaves this undefined, and the condenser measures instead of matching.
	let thinkingBudgetMessage: string | undefined

	// The per-turn output cap, resolved once: the system prompt states it, and
	// compaction budgets against it. A configured `num_predict` goes on the wire
	// ahead of the session's cap and wins, so it is the answer wherever the
	// question is "how long can this reply be".
	// Read for whichever provider is running, not for Ollama alone. It used to
	// come off `ollamaProviderConfig`, so an opencoti or llama.cpp user's typed
	// `numPredict` reached the wire through `buildLlamaCppSamplingOptions` and
	// reached neither the system prompt nor compaction's budget -- the model was
	// told one cap and held to another, which is the defect
	// `buildOutputBudgetSection` exists to prevent.
	const configuredNumPredict = positiveFiniteNumber(readProviderSampling(providerId)?.numPredict)
	// What the user or the session actually chose, as opposed to the figure used
	// when nobody has chosen anything. Only the former may overrule a model's own
	// published cap.
	//
	// `outputBudget` is the setting that owns this now; `sampling.numPredict` is
	// kept ahead of it because a profile written before the setting existed has
	// its value there and nowhere else, and silently halving that user's cap on
	// upgrade is worse than carrying the alias.
	const outputBudget = readProviderOutputBudget(providerId)
	const explicitOutputCap =
		configuredNumPredict ??
		maxTokensPerTurn ??
		(outputBudget?.mode === "manual" ? positiveFiniteNumber(outputBudget.maxTokens) : undefined)
	// The same default the gateway will synthesize for this request, asked of it
	// with the same model facts: it is a share of the window for a model that
	// publishes no cap of its own, and stating the flat anchor here would put a
	// smaller number in the prompt than the server enforces on every local model
	// with a window wider than 128k.
	const sessionOutputCap =
		explicitOutputCap ??
		resolveOutputBudgetTokens({
			mode: outputBudget?.mode ?? "auto",
			maxTokens: outputBudget?.maxTokens,
			contextWindow: sessionContextWindow,
			modelMaxOutputTokens: positiveFiniteNumber(committedRuntimeModel?.modelInfo?.maxTokens),
		}) ??
		resolveDefaultMaxOutputTokens({
			contextWindow: sessionContextWindow,
			maxOutputTokens: positiveFiniteNumber(committedRuntimeModel?.modelInfo?.maxTokens),
		})

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
		const thinking = await resolveThinkingAllowance(
			providerId,
			reasoningConfig,
			outputCap,
			contextWindow,
			apiConfig ? resolveBaseUrl(providerId, apiConfig) : undefined,
			modelId,
		)
		systemPrompt = `${systemPrompt}${buildOutputBudgetSection(outputCap, contextWindow, thinking)}`
		thinkingBudgetTokens = thinking?.budgetTokens
		// Read from the provider's own settings rather than off the Ollama-only
		// config object: `sampling.thinkBudgetMessage` is a generic field, it is
		// what the llama.cpp sampler sends as `reasoning_budget_message`, and
		// reading it only for Ollama left the retrospective on every other engine
		// with nothing to match a capped think against.
		const configuredBudgetMessage =
			ollamaProviderConfig?.sampling?.thinkBudgetMessage?.trim() || readConfiguredThinkBudgetMessage(providerId)
		if (configuredBudgetMessage) {
			thinkingBudgetMessage = configuredBudgetMessage
		} else if (isOllamaNativeProvider(providerId) && modelId) {
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
	// Which cut runs, and therefore which of the two prompts the summarizer is
	// given. The core picks the prompt from this flag rather than taking one
	// here, so a blank field falls back to the built-in written for that cut and
	// never to the other one's.
	const keepRecentMessagesAtCompaction = stateManager.getGlobalSettingsKey("keepRecentMessagesAtCompaction") ?? true
	// No `??` fallback: the state key carries the default, and `0` here is the
	// value that turns the behaviour off. Coalescing it would read "never" as
	// "unset" and hand core back its own default, turning it on again.
	const forceFullFromCompaction = stateManager.getGlobalSettingsKey("forceFullFromCompaction")
	const fullCompactionPrompt = (stateManager.getGlobalSettingsKey("fullCompactionPrompt") ?? "").trim()
	// Second-phase retrospective over the reasoning compaction discards.
	// Defaults on: the summary alone leaves a resumed task with no memory of
	// having been wrong, which is how a long run repeats its own mistakes.
	const thinkingCompactionEnabled = stateManager.getGlobalSettingsKey("thinkingCompactionEnabled") ?? true
	const councilCompactionEnabled = stateManager.getGlobalSettingsKey("councilCompactionEnabled") ?? true
	const thinkingCompactionPrompt = (stateManager.getGlobalSettingsKey("thinkingCompactionPrompt") ?? "").trim()
	const councilWriterPrompt = (stateManager.getGlobalSettingsKey("councilWriterPrompt") ?? "").trim()
	const councilCriticPrompt = (stateManager.getGlobalSettingsKey("councilCriticPrompt") ?? "").trim()
	const councilSynthesizerPrompt = (stateManager.getGlobalSettingsKey("councilSynthesizerPrompt") ?? "").trim()
	// A matched template's `# compaction: <id>` section, then the Features
	// setting, then the built-in. The template is the more specific of the
	// two -- it was written for this model, usually by translating the very
	// setting it now outranks -- and deleting the section from the template is
	// how a user goes back.
	const templateCompaction = renderedTemplate?.compaction ?? {}
	const fromTemplate = Object.entries(templateCompaction)
		.filter(([, text]) => text?.trim())
		.map(([id]) => id)
	if (fromTemplate.length > 0) {
		Logger.log(`[PromptTemplates] ${renderedTemplate?.name} supplies compaction prompts: ${fromTemplate.join(", ")}`)
	}
	const compactionPromptFor = (id: PromptTemplateCompactionId, setting: string): string =>
		resolveCompactionPrompt(templateCompaction, id, setting)
	// The condenser that replaces an abandoned think with a note of what it
	// settled. Also defaults on, and stands down by itself where no thinking
	// budget is known, so the switch is about turning it off deliberately.
	const cappedThinkingEnabled = stateManager.getGlobalSettingsKey("cappedThinkingEnabled") ?? true
	const cappedThinkingPrompt = (stateManager.getGlobalSettingsKey("cappedThinkingPrompt") ?? "").trim()
	// Per-tool-result cap. Stored as 0 when unset, which is not "keep nothing":
	// it hands the decision back to the SDK default.
	//
	// Resolved per configuration before falling back to the global setting: the
	// cap is a fraction of a context window, and Plan, Act, Vision and Agents
	// each have a window of their own. It was global on both sides, so a profile
	// carrying a 256k window shared its cap with one carrying 8k.
	const globalMaxToolResultChars = positiveFiniteNumber(stateManager.getGlobalSettingsKey("maxToolResultChars"))
	const maxToolResultChars =
		positiveFiniteNumber(profileSettings?.maxToolResultChars) ??
		positiveFiniteNumber(readStoredMaxToolResultChars(providerId)) ??
		globalMaxToolResultChars
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
		// The model *and* the window it will run with. The model line alone read
		// correct through four builds of #43 while every request went to the
		// primary model: it printed the tab's picker, and the handler read the
		// mode keys, and nothing said the two disagreed. They are reconciled in
		// `buildScopedApiConfiguration` now, and this prints what was resolved
		// rather than what was picked, so a future disagreement shows here.
		const visionProvider = visionSnapshotProviderId(visionSnapshot)
		const resolvedVisionModel = visionProvider
			? ((visionApiConfiguration as Record<string, unknown>)[getProviderModelIdKey(visionProvider, "act")] as
					| string
					| undefined)
			: undefined
		const visionContextWindow = visionProviderSettings?.contextWindow
		Logger.log(
			`[Vision] Describer installed: provider=${visionProvider} model=${resolvedVisionModel ?? "unset"}` +
				(typeof visionContextWindow === "number" ? ` contextWindow=${visionContextWindow}` : ""),
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

	// The expert: a second, costlier model a stuck session can hand the task
	// to. The fifth scope, resolved exactly like the Agents tab — and kept in a
	// snapshot of its own for the same reason, which matters more here than
	// anywhere else: an expert is usually the *larger* model, so borrowing the
	// session's context window would size it down to whatever the small model
	// was given.
	const escalationSettings = stateManager.getGlobalSettingsKey("escalationSettings")
	// The trigger's thresholds, carried across only where the tab actually
	// holds one. Core reads a present number as a setting, so an unset
	// threshold has to travel as an absence rather than as zero -- otherwise
	// the panel's blank box would be read as "fire on every turn".
	const struggleThresholds = pickThresholds({
		failedCalls: escalationSettings?.struggleFailedCalls,
		distressHits: escalationSettings?.struggleDistressHits,
		window: escalationSettings?.struggleWindow,
		minIteration: escalationSettings?.struggleMinIteration,
		maxPerTask: escalationSettings?.struggleMaxPerTask,
		editStreak: escalationSettings?.struggleEditStreak,
		failedTransactions: escalationSettings?.struggleFailedTransactions,
	})
	const escalationSnapshot = stateManager.getGlobalSettingsKey("escalationModeApiConfiguration")
	const escalationStatus = resolveScopedModelStatus(
		stateManager.getGlobalSettingsKey("escalationModelEnabled"),
		escalationSnapshot,
	)
	const escalationConnection =
		escalationStatus === "ready"
			? await buildDelegatedAgentConnection(apiConfig, escalationSnapshot, "Escalation")
			: undefined
	if (escalationStatus === "unconfigured") {
		// Worth a line of its own rather than being inferred later from an
		// escalation that did not happen: nothing else in the session says the
		// path is closed, and a tab holding a provider and no model reads as
		// configured to anyone looking at it.
		const namedProvider = snapshotProviderId(escalationSnapshot)
		Logger.warn(
			`[Escalation] An escalation model is enabled but the Escalation tab names ${
				namedProvider ? `no model (provider=${namedProvider})` : "no provider"
			}; there is no expert to hand a stuck task to`,
		)
	} else if (escalationConnection) {
		Logger.log(
			`[Escalation] Expert configured: provider=${escalationConnection.providerId} model=${escalationConnection.modelId}`,
		)
	}

	// The expert's own prompt template.
	//
	// Resolved here for the same reason the session's is: only the host can
	// read the template directories and ask `/api/show` what a local tag
	// actually is. It is resolved for the EXPERT's model, not the session's --
	// they are usually different models and often different families, and the
	// expert reading the session model's template would be the same defect as
	// reading none.
	//
	// A failure is not fatal. The expert then runs on its role preamble alone,
	// which is every build before this one.
	let escalationTemplate: Awaited<ReturnType<typeof resolveSessionPromptTemplate>>["rendered"]
	if (escalationConnection) {
		try {
			escalationTemplate = (
				await resolveSessionPromptTemplate({
					providerId: escalationConnection.providerId,
					modelId: escalationConnection.modelId,
					workspaceRoot,
					baseUrl: escalationConnection.baseUrl,
				})
			).rendered
			Logger.log(
				`[Escalation] Expert prompt template: ${escalationTemplate?.name ?? "none"}${
					escalationTemplate?.overlaid ? " over default" : ""
				}`,
			)
		} catch (error) {
			Logger.warn("[Escalation] Failed to resolve the expert's prompt template:", error)
		}
	}

	// How many agents this endpoint will actually serve at once. Asked of the
	// endpoint the *agents* call, which is not always the session's: an Agents
	// tab pointed at a second server has that server's slots, not the lead's.
	//
	// The number is configured rather than discovered because it is not on the
	// wire — Ollama does not report `OLLAMA_NUM_PARALLEL`, and a hosted plan's
	// concurrency allowance is not published — and the cost of getting it wrong
	// is silent: a server with no free slot queues the request instead of
	// refusing it, so over-spawning reads as a slow run rather than a blocked
	// one.
	const agentSlots = await resolveAgentSlotLimit({
		providerId: delegatedAgentConnection?.providerId ?? toSdkProviderId(providerId ?? ""),
		baseUrl: delegatedAgentConnection?.baseUrl ?? baseUrl,
		parallelSessions: delegatedAgentConnection
			? snapshotProviderSettings(agentsSnapshot)?.parallelSessions
			: (profileSettings?.parallelSessions ?? readStoredParallelSessions(providerId)),
		fetch,
	})
	Logger.log(`[Agents] Concurrency: ${agentSlots.limit === 0 ? "uncapped" : agentSlots.limit} — ${agentSlots.reason}`)
	// And the other endpoints an agent can name, which the session's count has
	// nothing to say about.
	const agentSlotLimits = collectAgentSlotLimits(stateManager.getGlobalSettingsKey("apiConfigurationProfiles"), apiConfig)
	if (agentSlotLimits) {
		Logger.log(
			`[Agents] Per-endpoint concurrency: ${agentSlotLimits
				.map((entry) => `${entry.providerId}${entry.baseUrl ? ` @ ${entry.baseUrl}` : ""}=${entry.limit}`)
				.join(", ")}`,
		)
	}
	// Agent nodes: the endpoints delegated agents are placed across.
	//
	// Node1 is the Agents tab itself and is already resolved above as
	// `delegatedAgentConnection`; a second node is what makes this a list
	// rather than a connection. So the list is built only when more than one
	// node actually resolves to a connection -- with one node the placement
	// engine would replace a slot gate that is already doing the same job, and
	// an install that predates nodes would change behaviour for no reason.
	//
	// Capacity is asked of each node's own endpoint. Two nodes on two servers
	// have two independent counts, and asking the lead's would spread a fan-out
	// across machines by a number that describes neither.
	const storedAgentNodes = parseAgentNodes(stateManager.getGlobalSettingsKey("agentNodes"))
	const agentNodes: Array<{
		id: string
		priority: number
		capacity: number
		label?: string
		connection: DelegatedAgentConnectionOverride
	}> = []
	// The names the Agents tab shows, from the stored list rather than the
	// placed one: a node that names no provider is skipped below, and
	// renumbering around the gap would call Node3 "Node2" on the one screen
	// where the user is telling them apart. The chat used to print the storage
	// key instead -- "on node-mucuczcm" -- which names nothing the panel shows.
	const nodeLabels = agentNodeLabels(storedAgentNodes)
	if (agentsStatus === "ready" && storedAgentNodes.length > 1) {
		for (const node of storedAgentNodes) {
			const snapshot = node.id === PRIMARY_AGENT_NODE_ID ? agentsSnapshot : node.snapshot
			const connection =
				node.id === PRIMARY_AGENT_NODE_ID
					? delegatedAgentConnection
					: await buildDelegatedAgentConnection(apiConfig, snapshot)
			if (!connection) {
				// A node that names no provider or no model is not a node that
				// is merely idle: it would take placements and run them on
				// nothing. Said out loud, because the tab looks configured.
				Logger.warn(`[Agents] Node ${node.id} names no provider and model; it will not be placed on`)
				continue
			}
			const slots = await resolveAgentSlotLimit({
				providerId: connection.providerId,
				baseUrl: connection.baseUrl,
				parallelSessions: snapshotProviderSettings(snapshot)?.parallelSessions,
				fetch,
			})
			agentNodes.push({
				id: node.id,
				priority: node.priority,
				// `resolveAgentSlotLimit` returns 0 for "the endpoint's own
				// admission control decides"; the placement engine reads 0 as
				// "node off, never place". Opposite meanings for one number,
				// so the elastic case is said as what it is -- no ceiling.
				capacity: slots.limit === 0 ? Number.POSITIVE_INFINITY : slots.limit,
				...(nodeLabels[node.id] ? { label: nodeLabels[node.id] } : {}),
				connection,
			})
		}
		if (agentNodes.length > 1) {
			Logger.log(
				`[Agents] ${agentNodes.length} nodes: ${agentNodes
					.map(
						(node) => `${node.id}(p${node.priority}, ${Number.isFinite(node.capacity) ? node.capacity : "uncapped"})`,
					)
					.join(", ")}`,
			)
		}
	}

	const useAutoCondense = input.taskSettings?.useAutoCondense ?? globalUseAutoCondense
	// Whether the model is offered subagents at all. Task settings win over the
	// global one, the same way every other setting here does.
	const subagentsEnabled =
		input.taskSettings?.subagentsEnabled ?? stateManager.getGlobalSettingsKey("subagentsEnabled") ?? false
	Logger.log(`[Agents] Subagents ${subagentsEnabled ? "enabled" : "disabled"}`)
	// Whether a delegated agent is offered `run_commands`. Its commands run in a
	// per-agent sandbox; off by default, and off means no shell rather than one
	// pointed at the real workspace.
	const subagentCommandsEnabled =
		input.taskSettings?.subagentCommandsEnabled ?? stateManager.getGlobalSettingsKey("subagentCommandsEnabled") ?? false
	// Whether the lead is offered the team_* tools. Its own setting, off by
	// default: eighteen tools in every request that most sessions never call.
	// Absent reads as off. Only meaningful with subagents on.
	const teammatesEnabled =
		input.taskSettings?.teammatesEnabled ?? stateManager.getGlobalSettingsKey("teammatesEnabled") ?? false
	if (subagentsEnabled) {
		Logger.log(`[Agents] Teammates ${teammatesEnabled ? "enabled" : "disabled"}`)
	}
	// Whether a turn that calls nothing is nudged to continue even when
	// nothing says work is unfinished. On by default, which is what the
	// extension did before this was a setting.
	const strongNudgesEnabled =
		input.taskSettings?.strongNudgesEnabled ?? stateManager.getGlobalSettingsKey("strongNudgesEnabled") ?? true

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

	// Ask Ollama what this model can do, rather than guessing.
	//
	// The catalog is silent for every model it has never heard of — all the
	// local ones, and anything published since the last catalog build — and the
	// default there is optimistic. That is how a browser screenshot reached a
	// model that could not read one. Ollama reports the answer, so for this
	// provider the tools that attach images can be told before they attach one,
	// instead of the model refusing the turn after the fact.
	//
	// Tool calling is read from the same cached `/api/show` response, and it is
	// not optional to read it. A capability list is only unspecified while it is
	// empty: the moment this writes one, every capability it leaves out reads as
	// an authoritative "cannot". Writing `["images"]` for a local vision model
	// therefore used to declare it unable to call tools, and the runtime handed
	// it an empty tool set — every call coming back "No tools are available"
	// while the system prompt still described them (mann1x/cline#63).
	const ollamaCapabilities =
		isOllamaNativeProvider(sdkProviderId) && modelId
			? {
					images: await resolveOllamaImageSupport(baseUrl, modelId),
					tools: await resolveOllamaToolSupport(baseUrl, modelId),
				}
			: undefined
	if (ollamaCapabilities?.images !== undefined || ollamaCapabilities?.tools !== undefined) {
		const existing = knownModels?.[modelId]
		const capabilities = new Set<string>(existing?.capabilities ?? [])
		const apply = (name: string, supported: boolean | undefined) => {
			if (supported === true) {
				capabilities.add(name)
			} else if (supported === false) {
				capabilities.delete(name)
			}
		}
		apply("images", ollamaCapabilities.images)
		apply("tools", ollamaCapabilities.tools)
		// Ollama did not say, and this list is about to stop being unspecified.
		// Everything else in the codebase assumes tool calling for a model that
		// never declared otherwise; a list written here must not quietly say the
		// opposite.
		if (ollamaCapabilities.tools === undefined && capabilities.size > 0) {
			capabilities.add("tools")
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
			explicitOutputCap ?? existing?.maxTokens ?? (isOllamaNativeProvider(sdkProviderId) ? sessionOutputCap : undefined)
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
	// The profile's own tool selection first, the shared provider entry second.
	// Carried on `providerConfig` because that is where the runtime builder
	// reads it, and it folds the names into the session's tool policies -- which
	// is the one filter every tool passes through, MCP tools included.
	const toolSelection = readToolSelection(profileSettings?.tools) ?? readToolSelection(readStoredToolSelection(providerId))
	if (toolSelection?.disabled?.length) {
		Logger.log(`[SessionFactory] Tools withheld by this configuration: ${toolSelection.disabled.join(", ")}`)
	}
	if (toolSelection?.readLimitEnabled === false) {
		Logger.log("[SessionFactory] The file-read size limit is off for this configuration")
	} else if (toolSelection?.readLimitChars) {
		Logger.log(`[SessionFactory] File reads are refused past ${toolSelection.readLimitChars} characters`)
	}
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
		// Mirror the user's Max Output Tokens for consumers that build handlers
		// straight from providerConfig — notably the compaction summarizer, which
		// otherwise falls back to a small default output cap (CLINE-2911).
		...(maxTokensPerTurn !== undefined ? { maxOutputTokens: maxTokensPerTurn } : {}),
		// The budget this session resolved for itself, and the figure
		// `buildOutputBudgetSection` just put in the system prompt. Without it
		// the gateway synthesizes its flat 32,000 anchor for any model that
		// publishes an output cap -- which, for a local model, is the very cap
		// this session wrote into `knownModels` a few lines below so compaction
		// could read it. Measured on pandorum 2026-09-18: the prompt said 82,500
		// with 66,000 for thinking, `num_predict` went out at 32,000, and the
		// turn was cut with its 25,600-token think spent and no tool call.
		...(sessionOutputCap !== undefined ? { defaultMaxOutputTokens: sessionOutputCap } : {}),
		...(toolSelection ? { tools: toolSelection } : {}),
		fetch,
	}

	// A global model override for delegated agents (Features panel): they run
	// this model on the session's own provider, overriding the lead's model for
	// them alone. Empty means no override. It is not per-provider and carries no
	// enable toggle — a value is the switch — and it never touches the lead. When
	// set it supersedes the Agents tab's own connection.
	const agentModelOverride = (stateManager.getGlobalSettingsKey("agentModelOverride") ?? "").trim()
	const effectiveDelegatedConnection: DelegatedAgentConnectionOverride | undefined = agentModelOverride
		? {
				providerId: sdkProviderId,
				modelId: agentModelOverride,
				...(apiKey ? { apiKey } : {}),
				...(baseUrl !== undefined ? { baseUrl } : {}),
				...(knownModels && Object.keys(knownModels).length > 0 ? { knownModels } : {}),
				// The lead's whole provider config with only the model swapped, so
				// the agents inherit its proxy-aware fetch, sampler and caps.
				providerConfig: {
					...providerConfig,
					modelId: agentModelOverride,
				},
			}
		: delegatedAgentConnection
	if (agentModelOverride) {
		Logger.log(`[Agents] Global model override: delegated agents run ${agentModelOverride} on provider=${sdkProviderId}`)
	}

	// "Use PolyKV agents as Priority 0" (PLANS §9g): agents first as sub-pools
	// of this session's own opencoti window, overflowing to the nodes above.
	// Asked of the Model's endpoint -- that is the window being lent -- and
	// only when the setting is on, so a session that never asked for it spends
	// no round trip. `/props` is cached per server by the probe.
	const polykvAgentsPriorityZeroSetting = stateManager.getGlobalSettingsKey("polykvAgentsPriorityZero") ?? false
	const polykvAgentsPriorityZero =
		polykvAgentsPriorityZeroSetting &&
		polykvPriorityZeroApplies({
			enabled: polykvAgentsPriorityZeroSetting,
			leadProviderId: sdkProviderId,
			poolsEnabled: sdkProviderId === "opencoti" ? (await probeOpencotiProps(baseUrl, fetch)).poolsEnabled : false,
		})
	if (polykvAgentsPriorityZeroSetting) {
		Logger.log(
			polykvAgentsPriorityZero
				? "[Agents] Priority 0: agents run first as sub-pools of this session's PolyKV window (at most 8), then on the nodes"
				: `[Agents] Priority 0 is on but does not apply: ${
						sdkProviderId === "opencoti"
							? "the Model's server did not confirm pools_enabled"
							: `the Model provider is ${sdkProviderId}, not opencoti`
					}`,
		)
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
		...(effectiveDelegatedConnection ? { delegatedAgentConnection: effectiveDelegatedConnection } : {}),
		// One node is the connection above; a list starts at two.
		...(agentNodes.length > 1 ? { agentNodes } : {}),
		...(polykvAgentsPriorityZero ? { polykvAgentsPriorityZero: true } : {}),
		// Only when there is somewhere to escalate to. An `escalation` block
		// holding no connection would be a feature that is on and cannot run,
		// which is the state this fork keeps finding and then has to explain.
		...(escalationConnection
			? {
					escalation: {
						connection: escalationConnection,
						...(escalationTemplate ? { promptTemplate: escalationTemplate } : {}),
						// The budgets and switches from the Escalation tab. Read
						// here rather than defaulted in core, so what the panel
						// shows is what the run uses.
						...(escalationSettings?.requireApproval !== undefined
							? { requireApproval: escalationSettings.requireApproval }
							: {}),
						...(escalationSettings?.closeAfterEscalation !== undefined
							? { closeAfterEscalation: escalationSettings.closeAfterEscalation }
							: {}),
						...(escalationSettings?.alternateWithBase !== undefined
							? { alternateWithBase: escalationSettings.alternateWithBase }
							: {}),
						...(escalationSettings?.relayNothing !== undefined
							? { relayNothing: escalationSettings.relayNothing }
							: {}),
						...(escalationSettings?.maxEscalations ? { maxEscalations: escalationSettings.maxEscalations } : {}),
						...(escalationSettings?.maxFollowUps ? { maxFollowUps: escalationSettings.maxFollowUps } : {}),
						...(struggleThresholds ? { struggleThresholds } : {}),
						// There is a user here to ask, so the approval setting has
						// somewhere to go. Without this it could only ever refuse.
						//
						// Modal here, because this builder has no chat to ask in.
						// `SdkSessionConfigBuilder` replaces it with the chat-backed
						// one, which is the path every real session takes; this is
						// what is left for the ones that do not.
						approve: createEscalationApprover(undefined),
						// Jev's complexity and "stuck" scores, into the assessment
						// the user approves from and the expert reads. A no-op
						// until Jev is ticked and keyed; read per escalation.
						appraise: appraiseEscalationWithJev,
					},
				}
			: {}),
		maxConcurrentAgents: agentSlots.limit,
		...(agentSlotLimits ? { agentSlotLimits } : {}),
		resolveProviderConnection: resolveAgentProviderConnection,
		// An agent file can name a saved profile instead of a provider and a
		// model. Built from the stored list at session start, which is when the
		// agent files are read too.
		resolveProfileConnection: createAgentProfileConnectionResolver({
			storedProfiles: stateManager.getGlobalSettingsKey("apiConfigurationProfiles"),
			primary: apiConfig,
		}),
		listProfileNames: createAgentProfileNameLister(stateManager.getGlobalSettingsKey("apiConfigurationProfiles")),
		cwd,
		workspaceRoot,
		systemPrompt,
		enableTools: true,
		checkpoint: {
			enabled: enableCheckpoints,
		},
		// The Subagents toggle, which until now stored a value nothing read. The
		// machinery was all here -- agent files in `.cline/agents`, a tool per
		// agent, a connection and a slot gate for them -- and the model was never
		// offered any of it, because these two were written as literals.
		//
		// Both from one setting rather than two: a user who turns subagents on
		// wants to delegate, and which mechanism carries the delegation is an
		// implementation detail they have no way to choose between.
		enableSpawnAgent: subagentsEnabled,
		// The team tools are a second mechanism with a price of their own (see
		// `teammatesEnabled`), so they take their own switch on top of this one.
		enableAgentTeams: subagentsEnabled && teammatesEnabled,
		// Whether those delegated agents are offered a (sandboxed) shell.
		subagentCommandsEnabled,
		// Where the shipped command-sandbox binaries live. The host resolves the
		// actual files under here per platform; absent binaries just mean no
		// delegated shell, so pointing at the folder is safe before it is filled.
		// Guarded on `isInitialized` because this field is optional and safe when
		// absent (`resolveSandboxBinaries(undefined)` → no shell): a session built
		// before the host is set up degrades to no delegated shell rather than
		// throwing an opaque "HostProvider not setup" from deep inside config.
		sandboxBinariesDir: HostProvider.isInitialized()
			? join(HostProvider.get().extensionFsPath, "assets", "sandbox")
			: undefined,
		strongNudges: strongNudgesEnabled,
		// Sent whether or not auto compaction is on. `enabled` is the only thing
		// that decides whether the transcript gets compacted — the runtime
		// returns no compaction pass without it — but this object is also where
		// the capped-thinking condenser reads its settings, and that condenser
		// has nothing to do with compaction: it rewrites one turn's abandoned
		// reasoning whatever the transcript is doing. Omitting the object when
		// auto-condense was off silently took the condenser with it.
		compaction: {
			enabled: useAutoCondense,
			// `enabled` above is the only field here that means "automatic". It
			// decides whether the transcript is compacted on its own; everything
			// below decides *how* a compaction is done once one is happening, and
			// a manual compaction is one. `sdk-compaction.ts` force-enables the
			// pass and spreads *this* object for the rest, so anything sent only
			// when auto-condense is on is a setting a manual compaction never
			// sees.
			//
			// These all used to sit inside that gate, and each failed in its own
			// way with Auto Compact off: the two switches read as ON, because the
			// strategy tests `councilEnabled === false` and
			// `thinkingSummaryEnabled !== false`, so a manual compaction paid for
			// a council and a thinking summary the user had turned off; and the
			// strategy, the retained-message count and all three custom prompts
			// fell back to defaults, so the prompts someone wrote were quietly
			// not the prompts that ran. Nothing surfaced any of it -- an extra
			// model call and a default prompt both look like the compaction
			// working.
			//
			// Same fault the comment above records for the capped-thinking
			// condenser, which is what it should have been read as the first
			// time: settings that travel in the compaction config but do not
			// belong to auto-compaction were being taken down with it.
			strategy: compactionStrategy,
			keepRecentMessages: keepRecentMessagesAtCompaction,
			councilEnabled: councilCompactionEnabled,
			thinkingSummaryEnabled: thinkingCompactionEnabled,
			...(typeof forceFullFromCompaction === "number" ? { forceFullFromCompaction } : {}),
			...optionalPrompt("summaryPrompt", compactionPromptFor("replay", compactionPrompt)),
			...optionalPrompt("fullSummaryPrompt", compactionPromptFor("full", fullCompactionPrompt)),
			...optionalPrompt("thinkingSummaryPrompt", compactionPromptFor("retrospective", thinkingCompactionPrompt)),
			...optionalPrompt("councilWriterPrompt", compactionPromptFor("council-writer", councilWriterPrompt)),
			...optionalPrompt("councilCriticPrompt", compactionPromptFor("council-critic", councilCriticPrompt)),
			...optionalPrompt("councilSynthesizerPrompt", compactionPromptFor("council-synthesizer", councilSynthesizerPrompt)),
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
 * IMPORTANT: We pass `interactive: true` but NO `prompt`. This allocates the
 * session in memory and returns immediately; no persisted session row or
 * artifacts are created yet. The caller then uses
 * `core.send({ sessionId, prompt })` for the first user turn, which persists
 * that same session ID before inference. This keeps initialization responsive
 * without leaving empty history entries when the user never sends a message.
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

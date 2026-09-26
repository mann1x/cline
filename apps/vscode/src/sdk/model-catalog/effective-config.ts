import type { ApiConfiguration } from "@shared/api"
import { StateManager } from "@/core/storage/StateManager"
import { getProviderSettingsManager } from "../provider-migration"
import type { AwsProviderConfig, EffectiveProviderConfig, GcpProviderConfig, ProviderId } from "./contracts"
import { toSdkProviderId } from "./sdk-provider-id"

type AuthConfig = NonNullable<EffectiveProviderConfig["auth"]>
type ExtrasConfig = NonNullable<EffectiveProviderConfig["extras"]>

type ConfigParts = Omit<EffectiveProviderConfig, "providerId">
type ConfigKey = keyof ConfigParts

type ProviderSettingsLike = {
	readonly apiKey?: string
	readonly baseUrl?: string
	readonly apiLine?: string
	readonly headers?: Readonly<Record<string, string>>
	readonly region?: string
	readonly aws?: AwsProviderConfig
	readonly gcp?: GcpProviderConfig
	readonly contextWindow?: number
	readonly parallelSessions?: number
	readonly maxToolResultChars?: number
	readonly reasoning?: ReasoningConfig
	readonly sampling?: SamplingConfig
	readonly polykv?: PolykvConfig
	readonly outputBudget?: OutputBudgetConfig
	readonly tools?: ToolSelectionConfig
	readonly auth?: AuthConfig
	readonly extras?: ExtrasConfig
}

type ReasoningConfig = NonNullable<EffectiveProviderConfig["reasoning"]>
type SamplingConfig = NonNullable<EffectiveProviderConfig["sampling"]>
type PolykvConfig = NonNullable<EffectiveProviderConfig["polykv"]>
type OutputBudgetConfig = NonNullable<EffectiveProviderConfig["outputBudget"]>
type ToolSelectionConfig = NonNullable<EffectiveProviderConfig["tools"]>

/** Sampling fields that are read as numbers, and the sign each one allows. */
const SAMPLING_NUMBER_FIELDS = {
	temperature: "non-negative",
	topK: "non-negative",
	topP: "non-negative",
	minP: "non-negative",
	typicalP: "non-negative",
	repeatLastN: "any",
	repeatPenalty: "non-negative",
	presencePenalty: "any",
	frequencyPenalty: "any",
	seed: "any",
	numPredict: "any",
	numKeep: "any",
	numGpu: "any",
} as const

/**
 * The range each sampling field can hold a meaning in.
 *
 * A sign check is not enough. `top_p: 9` is non-negative and still not a
 * probability, and it reached a live server that way: a settings field stored
 * `0.9` as `9`, `0.4` as `4` and `1.05` as `105`, and every request for the
 * next 73 minutes ran at temperature 4.0 with a repeat penalty of 105 — noise,
 * diagnosed at the time as the model misbehaving.
 *
 * The panel refuses these at the point of entry now, but a settings file
 * written before that fix still holds them, so the value is dropped here too.
 * Dropping rather than clamping is deliberate: an unsent parameter leaves the
 * model's own value in force, which is a defensible answer, where a clamped one
 * silently invents a sampler nobody chose.
 */
const SAMPLING_RANGES: Partial<Record<keyof typeof SAMPLING_NUMBER_FIELDS, { min?: number; max?: number }>> = {
	temperature: { min: 0, max: 2 },
	topK: { min: 0, max: 1000 },
	topP: { min: 0, max: 1 },
	minP: { min: 0, max: 1 },
	typicalP: { min: 0, max: 1 },
	repeatPenalty: { min: 0, max: 2 },
	presencePenalty: { min: -2, max: 2 },
	frequencyPenalty: { min: -2, max: 2 },
	// -1 is Ollama's "you decide"; 0 is a real answer (keep it all on the CPU).
	// Above that the number is a layer count, and layer counts are not bounded by
	// the 99 people habitually type -- large models run well past 100, and one
	// here needed more than 99 to get fully offloaded. The ceiling is set far
	// enough above any real model that "all of them" always fits, while a
	// mistyped 990000 still does not become a setting.
	numGpu: { min: -1, max: 9999 },
}

/**
 * Read the stored sampling settings.
 *
 * Absent stays absent, field by field: an unset parameter is one the request
 * will not mention, leaving the model's own value in force, and a zero is a
 * real value for several of these (`temperature: 0`, `seed: 0`). `repeatLastN`,
 * `numPredict` and `numKeep` accept negatives because Ollama gives -1 a meaning
 * (whole context / unlimited), and `numGpu` because -1 is its "decide for me".
 */
/**
 * Read the stored PolyKV section.
 *
 * Validated rather than copied: `mode` and `on_saturation` are free strings in
 * storage, and a value the engine would reject must not be handed on looking
 * configured -- the server answers 400 to `queue`, which never shipped. Zero is
 * a real value throughout (`prefillMaxSlots: 0` is "off"), so the numbers are
 * range-checked, never truthiness-checked.
 */
/**
 * The output budget, narrowed to what the schema accepts.
 *
 * A stored `mode` that is neither value is dropped rather than carried: the
 * resolver treats an unknown mode as `auto` anyway, and showing the panel a
 * value it cannot render is worse than showing it the default.
 */
function readOutputBudget(settings: Record<string, unknown>): OutputBudgetConfig | undefined {
	const budget = settings.outputBudget
	if (!isPlainRecord(budget)) {
		return undefined
	}
	const result: { mode?: "auto" | "manual"; maxTokens?: number } = {}
	if (budget.mode === "auto" || budget.mode === "manual") {
		result.mode = budget.mode
	}
	const maxTokens = readPositiveInteger(budget.maxTokens)
	if (maxTokens !== undefined) {
		result.maxTokens = maxTokens
	}
	return Object.keys(result).length > 0 ? (result as OutputBudgetConfig) : undefined
}

function readPolykv(settings: Record<string, unknown>): PolykvConfig | undefined {
	const polykv = settings.polykv
	if (!isPlainRecord(polykv)) {
		return undefined
	}
	const result: Record<string, unknown> = {}
	for (const field of [
		"enabled",
		"pinPrefix",
		"ephemeral",
		"overcommit",
		"swarm",
		"dynamicContextSize",
		"continuationCompaction",
	]) {
		if (typeof polykv[field] === "boolean") {
			result[field] = polykv[field]
		}
	}
	for (const field of [
		"targetTpsPerSession",
		"guaranteeMinSessions",
		"settleTokens",
		"settleMaxMs",
		"prefillMaxSlots",
		"maxRetryAfterMs",
	]) {
		const raw = polykv[field]
		const parsed = typeof raw === "string" ? Number(raw) : raw
		if (typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0) {
			result[field] = parsed
		}
	}
	// Its own read, because zero means something different here. For the fields
	// above, 0 is a value — `prefillMaxSlots: 0` is what turns that arm off. A
	// floor of 0 is not a floor: it says any window at all is acceptable, which
	// is what having no floor already means, so it is dropped rather than
	// stored as a deliberate-looking nothing.
	const floor = typeof polykv.contextFloor === "string" ? Number(polykv.contextFloor) : polykv.contextFloor
	if (typeof floor === "number" && Number.isFinite(floor) && floor > 0) {
		result.contextFloor = Math.floor(floor)
	}
	const threshold = polykv.compactionPressureThreshold
	const parsedThreshold = typeof threshold === "string" ? Number(threshold) : threshold
	if (typeof parsedThreshold === "number" && Number.isFinite(parsedThreshold) && parsedThreshold > 0 && parsedThreshold <= 1) {
		result.compactionPressureThreshold = parsedThreshold
	}
	if (polykv.mode === "advisory" || polykv.mode === "enforced") {
		result.mode = polykv.mode
	}
	if (polykv.onSaturation === "reject" || polykv.onSaturation === "warn") {
		result.onSaturation = polykv.onSaturation
	}
	return Object.keys(result).length > 0 ? (result as PolykvConfig) : undefined
}

/**
 * The tools this configuration withholds.
 *
 * Read back as well as written, for the reason `parallelSessions` and the caps
 * needed the same treatment: a section the store writes and nothing reads is a
 * section the panel renders blank after a reload, while the session quietly
 * runs on it. Empty reads as absent -- a selection that withholds nothing is
 * the same statement as no selection at all.
 */
function readToolSelection(settings: Record<string, unknown>): ToolSelectionConfig | undefined {
	const tools = settings.tools
	if (!isPlainRecord(tools)) {
		return undefined
	}
	// The list is no longer what makes the section worth having: a profile that
	// only turns the read limit off has an empty list and something to say, and
	// requiring `disabled` to be an array dropped it on the floor.
	const disabled = Array.isArray(tools.disabled)
		? tools.disabled.filter((name): name is string => typeof name === "string" && name.trim() !== "")
		: []
	const readLimitEnabled = tools.readLimitEnabled === false ? false : undefined
	const readLimitChars =
		typeof tools.readLimitChars === "number" && Number.isFinite(tools.readLimitChars) && tools.readLimitChars > 0
			? Math.floor(tools.readLimitChars)
			: undefined
	const section: ToolSelectionConfig = {
		...(disabled.length > 0 ? { disabled } : {}),
		...(readLimitEnabled === false ? { readLimitEnabled: false } : {}),
		...(readLimitChars !== undefined ? { readLimitChars } : {}),
	}
	return Object.keys(section).length > 0 ? section : undefined
}

function readSampling(settings: Record<string, unknown>): SamplingConfig | undefined {
	const sampling = settings.sampling
	if (!isPlainRecord(sampling)) {
		return undefined
	}
	const result: Record<string, unknown> = {}
	for (const [field, sign] of Object.entries(SAMPLING_NUMBER_FIELDS)) {
		const raw = sampling[field]
		const parsed = typeof raw === "string" ? Number(raw) : raw
		if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
			continue
		}
		if (sign === "non-negative" && parsed < 0) {
			continue
		}
		const range = SAMPLING_RANGES[field as keyof typeof SAMPLING_NUMBER_FIELDS]
		if (range && ((range.min !== undefined && parsed < range.min) || (range.max !== undefined && parsed > range.max))) {
			continue
		}
		result[field] = parsed
	}
	for (const field of ["thinkBudget", "thinkBudgetMessage"] as const) {
		const raw = sampling[field]
		if (typeof raw === "string" && raw !== "") {
			result[field] = raw
		}
	}
	if (Array.isArray(sampling.stop)) {
		const stop = sampling.stop.filter((entry): entry is string => typeof entry === "string" && entry !== "")
		if (stop.length > 0) {
			result.stop = stop
		}
	}
	return Object.keys(result).length > 0 ? (result as SamplingConfig) : undefined
}

/**
 * Read the stored reasoning settings. Absent stays absent: on providers whose
 * wire format has an on/off thinking flag, "never asked" and "asked for none"
 * are different requests, and collapsing them here would lose that.
 */
function readReasoning(settings: Record<string, unknown>): ReasoningConfig | undefined {
	const reasoning = settings.reasoning
	if (!isPlainRecord(reasoning)) {
		return undefined
	}
	const enabled = typeof reasoning.enabled === "boolean" ? reasoning.enabled : undefined
	const effort = typeof reasoning.effort === "string" ? reasoning.effort : undefined
	const budgetTokens = readPositiveInteger(reasoning.budgetTokens)
	// Only the four the resolver understands. Anything else stored by hand is
	// dropped rather than shown back as if it were in force.
	const history =
		typeof reasoning.reasoningHistory === "string" && ["auto", "all", "last", "none"].includes(reasoning.reasoningHistory)
			? reasoning.reasoningHistory
			: undefined
	const inline = typeof reasoning.reasoningInline === "boolean" ? reasoning.reasoningInline : undefined
	if (
		enabled === undefined &&
		effort === undefined &&
		budgetTokens === undefined &&
		history === undefined &&
		inline === undefined
	) {
		return undefined
	}
	return {
		...(enabled !== undefined ? { enabled } : {}),
		...(effort !== undefined ? { effort } : {}),
		...(budgetTokens !== undefined ? { budgetTokens } : {}),
		...(history !== undefined ? { reasoningHistory: history } : {}),
		...(inline !== undefined ? { reasoningInline: inline } : {}),
	}
}

const apiKeyFields: Partial<Record<string, keyof ApiConfiguration>> = {
	anthropic: "apiKey",
	openrouter: "openRouterApiKey",
	openai: "openAiApiKey",
	"openai-native": "openAiNativeApiKey",
	"openai-codex": "openAiNativeApiKey",
	bedrock: "awsBedrockApiKey",
	gemini: "geminiApiKey",
	deepseek: "deepSeekApiKey",
	ollama: "ollamaApiKey",
	requesty: "requestyApiKey",
	together: "togetherApiKey",
	fireworks: "fireworksApiKey",
	qwen: "qwenApiKey",
	"qwen-code": "qwenApiKey",
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
	nousresearch: "nousResearchApiKey",
	"vercel-ai-gateway": "vercelAiGatewayApiKey",
	wandb: "wandbApiKey",
	oca: "ocaApiKey",
	cline: "clineApiKey",
}

const baseUrlFields: Partial<Record<string, keyof ApiConfiguration>> = {
	anthropic: "anthropicBaseUrl",
	openai: "openAiBaseUrl",
	ollama: "ollamaBaseUrl",
	lmstudio: "lmStudioBaseUrl",
	gemini: "geminiBaseUrl",
	requesty: "requestyBaseUrl",
	asksage: "asksageApiUrl",
	litellm: "liteLlmBaseUrl",
	sapaicore: "sapAiCoreBaseUrl",
	dify: "difyBaseUrl",
	oca: "ocaBaseUrl",
	aihubmix: "aihubmixBaseUrl",
}

const apiLineFields: Partial<Record<string, keyof ApiConfiguration>> = {
	qwen: "qwenApiLine",
	moonshot: "moonshotApiLine",
	zai: "zaiApiLine",
	minimax: "minimaxApiLine",
}

const regionFields: Partial<Record<string, keyof ApiConfiguration>> = {
	bedrock: "awsRegion",
	vertex: "vertexRegion",
}

const gcpProjectFields: Partial<Record<string, keyof ApiConfiguration>> = {
	vertex: "vertexProjectId",
}

const gcpRegionFields: Partial<Record<string, keyof ApiConfiguration>> = {
	vertex: "vertexRegion",
}

const headerFields: Partial<Record<string, keyof ApiConfiguration>> = {
	openai: "openAiHeaders",
}

const extrasFields: Partial<Record<string, Partial<Record<string, keyof ApiConfiguration>>>> = {
	lmstudio: { lmStudioMaxTokens: "lmStudioMaxTokens" },
	litellm: { liteLlmUsePromptCache: "liteLlmUsePromptCache" },
	openrouter: { openRouterProviderSorting: "openRouterProviderSorting" },
	bedrock: {
		awsAuthentication: "awsAuthentication",
		awsBedrockEndpoint: "awsBedrockEndpoint",
		awsBedrockUsePromptCache: "awsBedrockUsePromptCache",
		awsProfile: "awsProfile",
		awsUseProfile: "awsUseProfile",
	},
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key]
	return typeof value === "string" && value.length > 0 ? value : undefined
}

function readHeaders(record: Record<string, unknown>, key: string): Readonly<Record<string, string>> | undefined {
	const value = record[key]
	if (!isPlainRecord(value)) {
		return undefined
	}

	const headers: Record<string, string> = {}
	for (const [headerName, headerValue] of Object.entries(value)) {
		if (typeof headerValue !== "string") {
			return undefined
		}
		headers[headerName] = headerValue
	}
	return Object.keys(headers).length > 0 ? headers : undefined
}

function readAuth(record: Record<string, unknown>): AuthConfig | undefined {
	const auth = record.auth
	if (!isPlainRecord(auth)) {
		return undefined
	}

	const accessToken = readString(auth, "accessToken")
	const refreshToken = readString(auth, "refreshToken")
	const accountId = readString(auth, "accountId")
	return accessToken || refreshToken || accountId ? { accessToken, refreshToken, accountId } : undefined
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
	const value = record[key]
	return typeof value === "boolean" ? value : undefined
}

function readPositiveInteger(value: unknown): number | undefined {
	const parsed = typeof value === "string" ? Number(value) : value
	if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) {
		return Math.floor(parsed)
	}
	return undefined
}

function readGcp(record: Record<string, unknown>): GcpProviderConfig | undefined {
	const gcp = record.gcp
	if (!isPlainRecord(gcp)) {
		return undefined
	}

	const result: GcpProviderConfig = {
		projectId: readString(gcp, "projectId"),
		region: readString(gcp, "region"),
	}
	return Object.values(result).some((value) => value !== undefined) ? result : undefined
}

function readAws(record: Record<string, unknown>): AwsProviderConfig | undefined {
	const aws = record.aws
	if (!isPlainRecord(aws)) {
		return undefined
	}

	const result: AwsProviderConfig = {
		accessKey: readString(aws, "accessKey"),
		secretKey: readString(aws, "secretKey"),
		sessionToken: readString(aws, "sessionToken"),
		authentication: readString(aws, "authentication"),
		profile: readString(aws, "profile"),
		usePromptCache: readBoolean(aws, "usePromptCache"),
		endpoint: readString(aws, "endpoint"),
		customModelBaseId: readString(aws, "customModelBaseId"),
		useCrossRegionInference: readBoolean(aws, "useCrossRegionInference") ?? readBoolean(record, "useCrossRegionInference"),
		useGlobalInference: readBoolean(aws, "useGlobalInference") ?? readBoolean(record, "useGlobalInference"),
	}
	return Object.values(result).some((value) => value !== undefined) ? result : undefined
}

function readProviderSettings(providerId: ProviderId): ConfigParts {
	try {
		const settings: unknown = getProviderSettingsManager().getProviderSettings(toSdkProviderId(providerId))
		if (!isPlainRecord(settings)) {
			return {}
		}

		return {
			apiKey: readString(settings, "apiKey"),
			baseUrl: readString(settings, "baseUrl"),
			apiLine: readString(settings, "apiLine"),
			headers: readHeaders(settings, "headers"),
			region: readString(settings, "region"),
			aws: readAws(settings),
			gcp: readGcp(settings),
			contextWindow: readPositiveInteger(settings.contextWindow),
			parallelSessions: readPositiveInteger(settings.parallelSessions),
			maxToolResultChars: readPositiveInteger(settings.maxToolResultChars),
			reasoning: readReasoning(settings),
			sampling: readSampling(settings),
			polykv: readPolykv(settings),
			outputBudget: readOutputBudget(settings),
			tools: readToolSelection(settings),
			auth: readAuth(settings),
			extras: isPlainRecord(settings.extras) ? settings.extras : undefined,
		} satisfies ProviderSettingsLike
	} catch {
		return {}
	}
}

function readStringFromConfig(config: ApiConfiguration, field: keyof ApiConfiguration | undefined): string | undefined {
	if (!field) {
		return undefined
	}
	const value = config[field]
	return typeof value === "string" && value.length > 0 ? value : undefined
}

function readHeadersFromConfig(
	config: ApiConfiguration,
	field: keyof ApiConfiguration | undefined,
): Readonly<Record<string, string>> | undefined {
	if (!field) {
		return undefined
	}
	const value = config[field]
	return isPlainRecord(value) ? readHeaders({ value }, "value") : undefined
}

function readStateExtras(provider: string, config: ApiConfiguration): ExtrasConfig | undefined {
	const fieldMap = extrasFields[provider]
	if (!fieldMap) {
		return undefined
	}

	const extras: Record<string, unknown> = {}
	for (const [extraName, configField] of Object.entries(fieldMap)) {
		if (configField === undefined) {
			continue
		}
		const value = config[configField]
		if (value !== undefined) {
			extras[extraName] = value
		}
	}
	return Object.keys(extras).length > 0 ? extras : undefined
}

function readStateAuth(provider: string, config: ApiConfiguration): AuthConfig | undefined {
	if (provider !== "cline") {
		return undefined
	}

	const accessToken = readStringFromConfig(config, "clineApiKey")
	const accountId = readStringFromConfig(config, "clineAccountId")
	return accessToken || accountId ? { accessToken, accountId } : undefined
}

function readStateBoolean(config: ApiConfiguration, field: keyof ApiConfiguration): boolean | undefined {
	const value = config[field]
	return typeof value === "boolean" ? value : undefined
}

function readStateGcp(provider: string, config: ApiConfiguration): GcpProviderConfig | undefined {
	if (provider !== "vertex") {
		return undefined
	}

	const gcp: GcpProviderConfig = {
		projectId: readStringFromConfig(config, gcpProjectFields[provider]),
		region: readStringFromConfig(config, gcpRegionFields[provider]),
	}
	return Object.values(gcp).some((value) => value !== undefined) ? gcp : undefined
}

function readStateAws(provider: string, config: ApiConfiguration): AwsProviderConfig | undefined {
	if (provider !== "bedrock") {
		return undefined
	}

	const aws: AwsProviderConfig = {
		accessKey: readStringFromConfig(config, "awsAccessKey"),
		secretKey: readStringFromConfig(config, "awsSecretKey"),
		sessionToken: readStringFromConfig(config, "awsSessionToken"),
		authentication: readStringFromConfig(config, "awsAuthentication"),
		profile: readStringFromConfig(config, "awsProfile"),
		usePromptCache: readStateBoolean(config, "awsBedrockUsePromptCache"),
		endpoint: readStringFromConfig(config, "awsBedrockEndpoint"),
		useCrossRegionInference: readStateBoolean(config, "awsUseCrossRegionInference"),
		useGlobalInference: readStateBoolean(config, "awsUseGlobalInference"),
	}
	return Object.values(aws).some((value) => value !== undefined) ? aws : undefined
}

function readStateContextWindow(provider: string, config: ApiConfiguration): number | undefined {
	// Only Ollama has a legacy context-window state key; other providers keep
	// theirs in providers.json exclusively.
	if (provider !== "ollama") {
		return undefined
	}

	return readPositiveInteger(config.ollamaApiOptionsCtxNum)
}

function readStateConfig(providerId: ProviderId, config: ApiConfiguration): ConfigParts {
	const provider = providerId.toString()
	return {
		apiKey: readStringFromConfig(config, apiKeyFields[provider]),
		baseUrl: readStringFromConfig(config, baseUrlFields[provider]),
		apiLine: readStringFromConfig(config, apiLineFields[provider]),
		headers: readHeadersFromConfig(config, headerFields[provider]),
		region: readStringFromConfig(config, regionFields[provider]),
		aws: readStateAws(provider, config),
		gcp: readStateGcp(provider, config),
		contextWindow: readStateContextWindow(provider, config),
		auth: readStateAuth(provider, config),
		extras: readStateExtras(provider, config),
	}
}

function mergeExtras(first: ExtrasConfig | undefined, second: ExtrasConfig | undefined): ExtrasConfig | undefined {
	if (!first) {
		return second
	}
	if (!second) {
		return first
	}
	return { ...first, ...second }
}

function mergeGcp(first: GcpProviderConfig | undefined, second: GcpProviderConfig | undefined): GcpProviderConfig | undefined {
	if (!first) {
		return second
	}
	if (!second) {
		return first
	}
	return { ...first, ...second }
}

function mergeAws(first: AwsProviderConfig | undefined, second: AwsProviderConfig | undefined): AwsProviderConfig | undefined {
	if (!first) {
		return second
	}
	if (!second) {
		return first
	}
	return { ...first, ...second }
}

function assignIfDefined<T extends ConfigKey>(target: Partial<ConfigParts>, key: T, value: ConfigParts[T] | undefined): void {
	if (value !== undefined) {
		target[key] = value
	}
}

/**
 * Build an {@link EffectiveProviderConfig} by merging provider-owned settings
 * from SDK `providers.json` with the current StateManager effective API
 * configuration. StateManager's `getApiConfiguration()` already applies
 * task/session/remote-config overlays for legacy fields, so those values win.
 *
 * Mode-dependent model selection is intentionally excluded; callers use
 * `ProviderConfigStore.readSelection(providerId, mode)` for that.
 */
export function buildEffectiveProviderConfig(providerId: ProviderId): EffectiveProviderConfig {
	const providerSettings = readProviderSettings(providerId)
	const stateConfig = readStateConfig(providerId, StateManager.get().getApiConfiguration())
	const merged: Partial<ConfigParts> = {}

	assignIfDefined(merged, "apiKey", stateConfig.apiKey ?? providerSettings.apiKey)
	assignIfDefined(merged, "baseUrl", stateConfig.baseUrl ?? providerSettings.baseUrl)
	assignIfDefined(merged, "apiLine", stateConfig.apiLine ?? providerSettings.apiLine)
	assignIfDefined(merged, "headers", stateConfig.headers ?? providerSettings.headers)
	assignIfDefined(merged, "region", stateConfig.region ?? providerSettings.region)
	// Bedrock/Vertex are migrated to providers.json. Keep legacy StateManager cloud
	// fields as a fallback for old installs, but let providers.json win when both exist.
	assignIfDefined(merged, "aws", mergeAws(stateConfig.aws, providerSettings.aws))
	assignIfDefined(merged, "gcp", mergeGcp(stateConfig.gcp, providerSettings.gcp))
	// providers.json is the source of truth for the context window; the legacy
	// Ollama StateManager key is a migration fallback (the store mirrors writes
	// to both).
	assignIfDefined(merged, "contextWindow", providerSettings.contextWindow ?? stateConfig.contextWindow)
	// Written by providers.json only, and read back here so the settings panel
	// shows what is stored. Both were write-only before: the store wrote them
	// and nothing put them back on the config, so the fields rendered blank
	// after a reload and looked as though the value had not been kept.
	assignIfDefined(merged, "parallelSessions", providerSettings.parallelSessions)
	assignIfDefined(merged, "maxToolResultChars", providerSettings.maxToolResultChars)
	// providers.json is the only writer of reasoning; there is no legacy key.
	assignIfDefined(merged, "reasoning", providerSettings.reasoning)
	// Same as reasoning: providers.json is the only writer.
	assignIfDefined(merged, "sampling", providerSettings.sampling)
	assignIfDefined(merged, "polykv", providerSettings.polykv)
	assignIfDefined(merged, "outputBudget", providerSettings.outputBudget)
	assignIfDefined(merged, "tools", providerSettings.tools)
	assignIfDefined(merged, "auth", stateConfig.auth ?? providerSettings.auth)
	assignIfDefined(merged, "extras", mergeExtras(providerSettings.extras, stateConfig.extras))

	return { providerId, ...merged }
}

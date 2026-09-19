import * as Llms from "@cline/llms";
import { ReasoningLevelSchema, resolveOutputBudgetTokens } from "@cline/shared";
import { z } from "zod";
import {
	DEFAULT_EXTERNAL_OCA_BASE_URL,
	DEFAULT_INTERNAL_OCA_BASE_URL,
} from "../../auth/oca";
import { getPersistedProviderApiKey } from "../../auth/provider-auth-registry";
import {
	OPENAI_COMPATIBLE_PROVIDERS,
	type ProviderDefaults,
} from "./provider-defaults";

export type ModelInfo = Llms.ModelInfo;
export type ProviderClient = Llms.ProviderClient;
export type ProviderProtocol = Llms.ProviderProtocol;
export type ProviderId = Llms.ProviderId;
export type ProviderCapability = Llms.ProviderCapability;
export type ProviderConfig = Llms.ProviderConfig;
export type BuiltInProviderId = Llms.BuiltInProviderId;

export const BUILT_IN_PROVIDER = Llms.BUILT_IN_PROVIDER;
export const BUILT_IN_PROVIDER_IDS = Llms.BUILT_IN_PROVIDER_IDS;
export const isBuiltInProviderId = Llms.isBuiltInProviderId;
export const normalizeProviderId = Llms.normalizeProviderId;

export type ProviderDefaultsConfig = ProviderDefaults;

export const ProviderIdSchema = z
	.string()
	.min(1)
	.regex(/^[a-z0-9][a-z0-9-]*$/i);

export const ProviderProtocolSchema = z.enum([
	"anthropic",
	"gemini",
	"openai-chat",
	"openai-responses",
	"openai-r1",
	"ai-sdk",
]);

export const ProviderClientSchema = z.enum([
	"anthropic",
	"ai-sdk",
	"ai-sdk-community",
	"openai",
	"openai-compatible",
	"openai-r1",
	"gemini",
	"bedrock",
	"custom",
	"fetch",
	"vertex",
]);

export const AuthSettingsSchema = z.object({
	apiKey: z.string().optional(),
	accessToken: z.string().optional(),
	refreshToken: z.string().optional(),
	expiresAt: z.number().int().positive().optional(),
	accountId: z.string().optional(),
	// Active organization at last account load, for telemetry attribution.
	organizationId: z.string().optional(),
	organizationName: z.string().optional(),
	memberId: z.string().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

export type AuthSettings = z.infer<typeof AuthSettingsSchema>;

export const ReasoningSettingsSchema = z.object({
	enabled: z.boolean().optional(),
	effort: ReasoningLevelSchema.optional(),
	budgetTokens: z.number().int().positive().optional(),
	/**
	 * How much of the model's own prior thinking goes back to it.
	 *
	 * Stored beside the other reasoning controls because it is one. `auto` --
	 * and an absent value, which means the same -- defers to a measurement of
	 * the endpoint: whether it accepts a reasoning channel at all, and whether
	 * it renders it back into the prompt. An explicit choice outranks that
	 * measurement, which is the only way to test a template that is about to
	 * change.
	 *
	 * `all` is deliberately offered and deliberately not what `auto` picks:
	 * ollama re-renders every assistant think block after the last user turn,
	 * and an agent run has one user message, so `all` puts the whole thinking
	 * history into every prompt.
	 */
	reasoningHistory: z.enum(["auto", "all", "last", "none"]).optional(),
	/**
	 * Whether `auto` may fall back to folding prior reasoning into the
	 * assistant's content when the endpoint's chat template renders none of the
	 * reasoning field. On unless this says otherwise, and consulted only under
	 * `auto` -- an explicit replay mode is already an answer.
	 */
	reasoningInline: z.boolean().optional(),
});

export type ReasoningSettings = z.infer<typeof ReasoningSettingsSchema>;

/**
 * Sampling parameters stored per provider.
 *
 * Every field is optional and an absent one is not a zero: it means the request
 * will not mention that parameter, leaving whatever the model was built with in
 * force. A local model carries a sampler in its Modelfile — often one measured
 * against that quant — and a client that sent a complete set on every request
 * would silently replace it.
 *
 * `repeatLastN`, `numPredict`, `numKeep` and `numGpu` accept negative values
 * because Ollama gives -1 a meaning there (whole context / unlimited / decide
 * for me), and
 * `temperature` and `seed` accept zero because zero is a real setting.
 */
export const SamplingSettingsSchema = z.object({
	temperature: z.number().nonnegative().optional(),
	topK: z.number().int().nonnegative().optional(),
	topP: z.number().nonnegative().optional(),
	minP: z.number().nonnegative().optional(),
	typicalP: z.number().nonnegative().optional(),
	repeatLastN: z.number().int().optional(),
	repeatPenalty: z.number().nonnegative().optional(),
	presencePenalty: z.number().optional(),
	frequencyPenalty: z.number().optional(),
	seed: z.number().int().optional(),
	numPredict: z.number().int().optional(),
	numKeep: z.number().int().optional(),
	numGpu: z.number().int().optional(),
	stop: z.array(z.string()).optional(),
	thinkBudget: z.string().optional(),
	thinkBudgetMessage: z.string().optional(),
});

export type SamplingSettings = z.infer<typeof SamplingSettingsSchema>;

/**
 * opencoti's PolyKV control plane, as a profile configures it.
 *
 * A section of its own rather than loose fields because it is one arrangement
 * with one engine: the pool tree, the admission policy the engine enforces on
 * this profile's behalf, and how this client behaves when the engine says no.
 * All of it is inert unless `enabled`, and inert anyway on a server launched
 * without `--polykv-max-pools`.
 */
/**
 * The tools a configuration withholds from its sessions.
 *
 * A deny list rather than an allow list: the tool set grows, and an allow list
 * stored today would withhold every tool added after it from every profile
 * that already exists. Naming what to drop means a new tool arrives switched
 * on, which someone can see in the panel and correct.
 *
 * Held per configuration because the reason to drop a tool is the window it
 * has to fit in: the schemas are paid before a single message exists -- 21,000
 * to 24,000 tokens of a 65,536-token window, measured -- so a profile on a
 * small local model and one on a 400k cloud model want opposite answers.
 */
export const ToolSelectionSchema = z.object({
	disabled: z.array(z.string().min(1)).optional(),
});

export type ToolSelection = z.infer<typeof ToolSelectionSchema>;

export const PolykvSettingsSchema = z.object({
	enabled: z.boolean().optional(),
	/**
	 * Keep the shared prefix resident between turns.
	 *
	 * On by default where it matters: an unpinned leaf that goes 60s without a
	 * processing attach is swept, and the next turn silently pays full prefill.
	 */
	pinPrefix: z.boolean().optional(),
	ephemeral: z.boolean().optional(),
	/**
	 * How full the engine must say the pool is before this compacts, 0 to 1.
	 *
	 * Measured by the thing holding the cells, where every other signal in the
	 * compaction path is an estimate.
	 */
	compactionPressureThreshold: z.number().min(0).max(1).optional(),

	// The policy the engine applies, posted to `/polykv/pools/{id}/admission`.
	// `on_saturation: "queue"` is deliberately absent: it never shipped, and the
	// server answers 400 to the value.
	targetTpsPerSession: z.number().nonnegative().optional(),
	mode: z.enum(["advisory", "enforced"]).optional(),
	onSaturation: z.enum(["reject", "warn"]).optional(),
	guaranteeMinSessions: z.number().int().nonnegative().optional(),
	settleTokens: z.number().int().nonnegative().optional(),
	settleMaxMs: z.number().int().nonnegative().optional(),
	prefillMaxSlots: z.number().int().nonnegative().optional(),

	// How this client behaves against that policy.
	/** Bypass admission for this profile's requests, explicitly and visibly. */
	overcommit: z.boolean().optional(),
	swarm: z.boolean().optional(),
	/**
	 * The longest `Retry-After` this client will honour before giving up.
	 *
	 * The engine says when to come back; this is the point past which waiting
	 * stops being better than failing.
	 */
	maxRetryAfterMs: z.number().int().nonnegative().optional(),
});

export type PolykvSettings = z.infer<typeof PolykvSettingsSchema>;

export const AwsSettingsSchema = z.object({
	accessKey: z.string().optional(),
	secretKey: z.string().optional(),
	sessionToken: z.string().optional(),
	region: z.string().optional(),
	profile: z.string().optional(),
	authentication: z.enum(["iam", "api-key", "apikey", "profile"]).optional(),
	usePromptCache: z.boolean().optional(),
	useCrossRegionInference: z.boolean().optional(),
	useGlobalInference: z.boolean().optional(),
	endpoint: z.string().url().optional(),
	customModelBaseId: z.string().optional(),
});

export type AwsSettings = z.infer<typeof AwsSettingsSchema>;

export const GcpSettingsSchema = z.object({
	projectId: z.string().optional(),
	region: z.string().optional(),
});

export type GcpSettings = z.infer<typeof GcpSettingsSchema>;

export const AzureSettingsSchema = z.object({
	apiVersion: z.string().optional(),
	useIdentity: z.boolean().optional(),
});

export type AzureSettings = z.infer<typeof AzureSettingsSchema>;

export const SapSettingsSchema = z.object({
	clientId: z.string().optional(),
	clientSecret: z.string().optional(),
	tokenUrl: z.string().url().optional(),
	resourceGroup: z.string().optional(),
	deploymentId: z.string().optional(),
	useOrchestrationMode: z.boolean().optional(),
	api: z.enum(["orchestration", "foundation-models"]).optional(),
	defaultSettings: z.record(z.string(), z.unknown()).optional(),
});

export type SapSettings = z.infer<typeof SapSettingsSchema>;

export const OcaSettingsSchema = z.object({
	mode: z.enum(["internal", "external"]).optional(),
	usePromptCache: z.boolean().optional(),
});

export type OcaSettings = z.infer<typeof OcaSettingsSchema>;

export const ModelCatalogSettingsSchema = z.object({
	loadLatestOnInit: z.boolean().optional(),
	loadPrivateOnAuth: z.boolean().optional(),
	url: z.string().url().optional(),
	cacheTtlMs: z.number().int().positive().optional(),
	failOnError: z.boolean().optional(),
});

export type ModelCatalogSettings = z.infer<typeof ModelCatalogSettingsSchema>;
export type ModelCatalogConfig = ModelCatalogSettings;

export const ProviderSettingsSchema = z.object({
	provider: ProviderIdSchema,
	apiKey: z.string().optional(),
	auth: AuthSettingsSchema.optional(),
	model: z.string().optional(),
	protocol: ProviderProtocolSchema.optional(),
	client: ProviderClientSchema.optional(),
	routingProviderId: ProviderIdSchema.optional(),
	maxTokens: z.number().int().positive().optional(),
	contextWindow: z.number().int().positive().optional(),
	/**
	 * How many requests this endpoint serves at once -- `OLLAMA_NUM_PARALLEL`,
	 * llama.cpp's and opencoti's `--parallel N`, or what a hosted plan allows.
	 *
	 * Stored rather than discovered because it is not on the wire, and it
	 * matters because a server with no free slot *queues* the request instead of
	 * refusing it: over-spawning agents against one endpoint reads as a slow run
	 * rather than a blocked one. Bounded at ten, past which the number stops
	 * describing a server.
	 */
	parallelSessions: z.number().int().min(1).max(10).optional(),
	/**
	 * The per-turn output budget -- Ollama's `num_predict`, llama.cpp's and
	 * opencoti's `n_predict`, and the catalog's `maxTokens`, which are the same
	 * quantity under three names.
	 *
	 * It had two homes and no owner: `sampling.numPredict` in the provider's
	 * advanced panel, and the session's own `maxTokensPerTurn`. The first was
	 * read for Ollama only, so an opencoti user's typed value reached the wire
	 * (through `buildLlamaCppSamplingOptions`) but not the system prompt and not
	 * compaction's budget -- the model was told one cap and held to another.
	 *
	 * `auto` sizes it from the window; `manual` sends what is typed. On `auto`
	 * `maxTokens` is the user's own ceiling and may only lower the absolute one.
	 * See `resolveOutputBudgetTokens`, which is where both cases are decided.
	 */
	outputBudget: z
		.object({
			mode: z.enum(["auto", "manual"]).optional(),
			maxTokens: z.number().int().positive().optional(),
		})
		.optional(),
	/**
	 * Largest tool result this configuration sends to its model, in characters.
	 *
	 * Per configuration rather than global because it is read against a context
	 * window: the same cap that keeps a result useful at 256k throws most of it
	 * away at 8k. Absent means the global setting still decides.
	 */
	maxToolResultChars: z.number().int().positive().optional(),
	baseUrl: z.string().url().optional(),
	headers: z.record(z.string(), z.string()).optional(),
	timeout: z.number().int().positive().optional(),
	reasoning: ReasoningSettingsSchema.optional(),
	sampling: SamplingSettingsSchema.optional(),
	polykv: PolykvSettingsSchema.optional(),
	tools: ToolSelectionSchema.optional(),
	aws: AwsSettingsSchema.optional(),
	gcp: GcpSettingsSchema.optional(),
	azure: AzureSettingsSchema.optional(),
	sap: SapSettingsSchema.optional(),
	oca: OcaSettingsSchema.optional(),
	region: z.string().optional(),
	apiLine: z.enum(["china", "international"]).optional(),
	capabilities: z
		.array(
			z.enum([
				"reasoning",
				"prompt-cache",
				"streaming",
				"tools",
				"vision",
				"computer-use",
				"oauth",
				"popular",
			]),
		)
		.optional(),
	modelCatalog: ModelCatalogSettingsSchema.optional(),
});

export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;

export interface ToProviderConfigOptions {
	includeKnownModels?: boolean;
}

export function parseSettings(input: unknown): ProviderSettings {
	return ProviderSettingsSchema.parse(input);
}

export function safeParseSettings(
	input: unknown,
): ReturnType<typeof ProviderSettingsSchema.safeParse> {
	return ProviderSettingsSchema.safeParse(input);
}

function shouldRouteThroughOpenAIResponses(
	settings: ProviderSettings,
): boolean {
	return (
		settings.protocol === "openai-responses" || settings.client === "openai"
	);
}

/**
 * The per-turn cap to hand the gateway as its default, from the settings alone.
 *
 * `outputBudget` has been a field of this schema for a while, but every reader
 * of it lived in the VS Code host, so a CLI or JetBrains profile that set it was
 * parsed, stored, and then dropped on the floor -- the gateway synthesised its
 * flat anchor instead, and the number the user typed reached neither the wire
 * nor the prompt. Resolving it here puts it on the one path every host shares.
 *
 * Precedence mirrors the VS Code factory deliberately, so the same profile means
 * the same thing in both: a configured `numPredict` first, because it is what
 * actually goes on the wire for a local engine and a profile written before this
 * setting existed carries its cap there and nowhere else; then the budget.
 *
 * It is a *default*, not a ceiling. The model's published cap and the room left
 * in the window still clamp it, and an explicitly requested cap still wins.
 * `undefined` stays a real answer: `auto` is a share of a window, and a profile
 * with no window has none to take a share of, so inventing a number there would
 * be the same defect pointed the other way.
 */
function resolveSettingsDefaultOutputCap(
	settings: ProviderSettings,
): number | undefined {
	const numPredict = settings.sampling?.numPredict;
	if (
		typeof numPredict === "number" &&
		Number.isFinite(numPredict) &&
		numPredict > 0
	) {
		return Math.floor(numPredict);
	}
	return resolveOutputBudgetTokens({
		mode: settings.outputBudget?.mode ?? "auto",
		maxTokens: settings.outputBudget?.maxTokens,
		contextWindow: settings.contextWindow,
		modelMaxOutputTokens: settings.maxTokens,
	});
}

/**
 * The thinking allowance this session actually runs under, as a token count.
 *
 * This is what arms the capped-thinking condenser: it compares a turn's
 * reasoning against the allowance to tell "ran out of budget mid-thought" from
 * "finished thinking", and with no allowance it stands down -- silently, which
 * is how it once sat out an entire run while the cap fired on 288 requests.
 *
 * `reasoning.budgetTokens` is a count the user typed and is returned untouched.
 * A *level* is not a count, and until now nothing outside the VS Code factory
 * turned one into a count, so every host that stores the level where the
 * settings panel writes it -- `sampling.thinkBudget` -- armed nothing.
 *
 * Resolved against the same window the request resolves it against, so the
 * number the detector holds the turn to is the number the server was given.
 */
function resolveSettingsThinkingBudget(
	settings: ProviderSettings,
	outputCap: number | undefined,
): number | undefined {
	const explicit = settings.reasoning?.budgetTokens;
	if (
		typeof explicit === "number" &&
		Number.isFinite(explicit) &&
		explicit > 0
	) {
		return Math.floor(explicit);
	}
	if (!outputCap || outputCap <= 0) {
		return undefined;
	}
	return Llms.resolveLlamaCppThinkBudgetTokens(
		settings.sampling?.thinkBudget,
		outputCap,
	);
}

export function toProviderConfig(
	settings: ProviderSettings,
	options: ToProviderConfigOptions = {},
): ProviderConfig {
	const providerId = settings.provider as ProviderId;
	const normalizedProviderId = normalizeProviderId(providerId);
	const includeKnownModels = options.includeKnownModels !== false;
	const unifiedReasoningLevel = settings.reasoning?.effort || "none";
	const reasoningEffort =
		unifiedReasoningLevel === "none" ? undefined : unifiedReasoningLevel;

	const providerDefaults = OPENAI_COMPATIBLE_PROVIDERS[normalizedProviderId];
	const generatedKnownModels = Object.assign(
		{},
		...Llms.resolveProviderModelCatalogKeys(normalizedProviderId).map(
			(catalogKey) => Llms.getGeneratedModelsForProvider(catalogKey),
		),
	);
	const generatedDefaultModelId = Object.keys(generatedKnownModels)[0];

	const apiKey = getPersistedProviderApiKey(normalizedProviderId, settings);
	// Precedence: explicit base URL > regional API line endpoint (e.g.
	// Qwen/Moonshot/Z.AI "china" vs "international") > provider default.
	const resolvedBaseUrl =
		settings.baseUrl ??
		Llms.resolveProviderApiLineBaseUrl(
			normalizedProviderId,
			settings.apiLine,
		) ??
		(normalizedProviderId === "oca"
			? settings.oca?.mode === "internal"
				? DEFAULT_INTERNAL_OCA_BASE_URL
				: DEFAULT_EXTERNAL_OCA_BASE_URL
			: providerDefaults?.baseUrl);
	const routingProviderId =
		settings.routingProviderId ??
		(shouldRouteThroughOpenAIResponses(settings) &&
		normalizedProviderId !== BUILT_IN_PROVIDER.OPENAI_NATIVE
			? BUILT_IN_PROVIDER.OPENAI_NATIVE
			: undefined);

	const knownModels = includeKnownModels
		? (providerDefaults?.knownModels ??
			(Object.keys(generatedKnownModels).length > 0
				? generatedKnownModels
				: undefined))
		: undefined;

	const settingsDefaultOutputCap = resolveSettingsDefaultOutputCap(settings);
	const config: ProviderConfig = {
		providerId,
		clientType: settings.client,
		routingProviderId,
		modelId:
			settings.model ??
			providerDefaults?.modelId ??
			generatedDefaultModelId ??
			"default",
		...(includeKnownModels ? { knownModels } : {}),
		apiKey,
		accessToken: settings.auth?.accessToken,
		refreshToken: settings.auth?.refreshToken,
		accountId: settings.auth?.accountId,
		baseUrl: resolvedBaseUrl,
		headers: settings.headers,
		timeoutMs: settings.timeout,
		maxOutputTokens: settings.maxTokens,
		maxInputTokens: settings.contextWindow,
		defaultMaxOutputTokens: settingsDefaultOutputCap,
		thinking: settings.reasoning?.enabled,
		reasoningEffort,
		thinkingBudgetTokens: resolveSettingsThinkingBudget(
			settings,
			settingsDefaultOutputCap,
		),
		reasoningHistory: settings.reasoning?.reasoningHistory,
		reasoningInline: settings.reasoning?.reasoningInline,
		sampling: settings.sampling,
		polykv: settings.polykv,
		tools: settings.tools,
		region: settings.region ?? settings.aws?.region ?? settings.gcp?.region,
		apiLine: settings.apiLine,
		useCrossRegionInference: settings.aws?.useCrossRegionInference,
		useGlobalInference: settings.aws?.useGlobalInference,
		aws: settings.aws
			? {
					accessKey: settings.aws.accessKey,
					secretKey: settings.aws.secretKey,
					sessionToken: settings.aws.sessionToken,
					authentication: settings.aws.authentication,
					profile: settings.aws.profile,
					usePromptCache: settings.aws.usePromptCache,
					endpoint: settings.aws.endpoint,
					customModelBaseId: settings.aws.customModelBaseId,
				}
			: undefined,
		gcp: settings.gcp
			? {
					projectId: settings.gcp.projectId,
					region: settings.gcp.region,
				}
			: undefined,
		azure: settings.azure,
		sap: settings.sap,
		oca: settings.oca,
		capabilities: (settings.capabilities ?? providerDefaults?.capabilities) as
			| ProviderCapability[]
			| undefined,
		modelCatalog: settings.modelCatalog
			? {
					loadLatestOnInit: settings.modelCatalog.loadLatestOnInit,
					loadPrivateOnAuth: settings.modelCatalog.loadPrivateOnAuth,
					url: settings.modelCatalog.url,
					cacheTtlMs: settings.modelCatalog.cacheTtlMs,
					failOnError: settings.modelCatalog.failOnError,
				}
			: undefined,
	};

	return Object.fromEntries(
		Object.entries(config).filter(([_, value]) => value !== undefined),
	) as ProviderConfig;
}

export function createProviderConfig(input: unknown): ProviderConfig {
	const settings = parseSettings(input);
	return toProviderConfig(settings);
}

export function safeCreateProviderConfig(
	input: unknown,
):
	| { success: true; config: ProviderConfig }
	| { success: false; error: z.ZodError } {
	const result = safeParseSettings(input);
	if (result.success) {
		return { success: true, config: toProviderConfig(result.data) };
	}
	return { success: false, error: result.error };
}

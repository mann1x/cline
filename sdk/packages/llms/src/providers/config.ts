/**
 * Provider Configuration Types
 *
 * Unified configuration interface for all providers.
 * This replaces the per-provider config chaos with a single structure.
 */

import type {
	BasicLogger,
	ExtensionContext,
	ReasoningEffort,
} from "@cline/shared";
import type { ModelInfo, ProviderClient } from "../catalog/types";
import {
	BUILT_IN_PROVIDER,
	BUILT_IN_PROVIDER_IDS,
	type BuiltInProviderId,
	isBuiltInProviderId,
	normalizeProviderId,
} from "./ids";

// Re-export for convenience
export {
	BUILT_IN_PROVIDER,
	BUILT_IN_PROVIDER_IDS,
	type BuiltInProviderId,
	isBuiltInProviderId,
	normalizeProviderId,
};

/**
 * All supported provider IDs (built-in + custom)
 *
 * Custom provider IDs can be registered via `registerHandler()` or `registerAsyncHandler()`.
 * Any string is accepted to allow for custom handlers that extend BaseHandler.
 */
export type ProviderId = BuiltInProviderId | (string & {});

/**
 * Provider categories based on underlying SDK/protocol
 */
export type ProviderCategory =
	| "anthropic" // Anthropic SDK
	| "openai" // OpenAI SDK (native features)
	| "openai-compat" // OpenAI-compatible APIs
	| "openai-responses" // OpenAI-Responses APIs
	| "gemini" // Google GenAI SDK
	| "bedrock" // AWS Bedrock SDK
	| "custom"; // Custom implementations

// =============================================================================
// Provider Capabilities
// =============================================================================

/**
 * Capabilities that a provider/model may support
 */
export type ProviderCapability =
	| "reasoning" // Extended thinking/reasoning
	| "prompt-cache" // Prompt caching
	| "streaming" // Streaming responses
	| "tools" // Tool/function calling
	| "vision" // Image inputs
	| "computer-use" // Computer use tools
	| "oauth"; // OAuth authentication flow

// =============================================================================
// Configuration Components
// =============================================================================

/**
 * Authentication configuration
 */
export interface AuthConfig {
	/** API key (most common) */
	apiKey?: string;
	/** OAuth access token */
	accessToken?: string;
	/** Refresh token for OAuth */
	refreshToken?: string;
	/** Account ID (for account-based auth) */
	accountId?: string;
	/** OAuth callback path (e.g., for Qwen Code) */
	oauthPath?: string;
}

/**
 * Endpoint configuration
 */
export interface EndpointConfig {
	/** Base URL for the API */
	baseUrl?: string;
	/** Custom headers to include */
	headers?: Record<string, string>;
	/** Request timeout in milliseconds */
	timeoutMs?: number;
	/**
	 * Custom `fetch` implementation used by the AI gateway providers when
	 * issuing requests. When supplied, it is forwarded to
	 * `GatewayProviderSettings.fetch` (and as a top-level fallback on
	 * `GatewayConfig.fetch`) so hosts can inject custom HTTP behavior such
	 * as proxies, retries, tracing, or test doubles.
	 */
	fetch?: typeof fetch;
}

/**
 * Model configuration
 */
export interface ModelConfig {
	/** Model identifier */
	modelId: string;
	/** Pre-fetched model info (optional - will use defaults if not provided) */
	modelInfo?: ModelInfo;
	/** Known models for this provider with their info */
	knownModels?: Record<string, ModelInfo>;
}

/**
 * Token limits configuration
 */
export interface TokenConfig {
	/** Maximum input tokens (overrides model default) */
	maxInputTokens?: number;
	/** Maximum output tokens (overrides model default) */
	maxOutputTokens?: number;
	/** Sampling temperature (overrides model default) */
	temperature?: number;
	/**
	 * Marks a config the machinery uses for its own calls -- summarising,
	 * condensing, titling -- rather than for the conversation.
	 *
	 * Carried through to `GatewayStreamRequest.auxiliary`, where it keeps the
	 * call from writing itself into the process-wide record of "the last
	 * request" that the next compaction pass reads.
	 */
	auxiliary?: boolean;
}

/**
 * Reasoning/thinking model configuration
 */
export interface ReasoningConfig {
	/** Reasoning effort level */
	reasoningEffort?: ReasoningEffort;
	/** Extended thinking budget in tokens */
	thinkingBudgetTokens?: number;
	/** Enable thinking with provider/model defaults when supported */
	thinking?: boolean;
}

/**
 * Region configuration (shared across cloud providers)
 */
export interface RegionConfig {
	/** Cloud region (AWS, GCP, Azure, or provider-specific like Qwen's china/international) */
	region?: string;
	/** API line for region-specific routing (e.g., "china" | "international" for Qwen) */
	apiLine?: "china" | "international";
	/** Use cross-region inference (Bedrock) */
	useCrossRegionInference?: boolean;
	/** Use global inference (Bedrock) */
	useGlobalInference?: boolean;
}

/**
 * AWS-specific configuration (for Bedrock)
 */
export interface AwsConfig {
	accessKey?: string;
	secretKey?: string;
	sessionToken?: string;
	authentication?: "iam" | "api-key" | "apikey" | "profile";
	profile?: string;
	usePromptCache?: boolean;
	endpoint?: string;
	customModelBaseId?: string;
}

/**
 * Google Cloud configuration (for Vertex AI)
 */
export interface GcpConfig {
	projectId?: string;
	region?: string;
}

/**
 * Azure configuration (for Azure OpenAI)
 */
export interface AzureConfig {
	apiVersion?: string;
	useIdentity?: boolean;
}

/**
 * SAP AI Core configuration
 */
export interface SapConfig {
	clientId?: string;
	clientSecret?: string;
	tokenUrl?: string;
	resourceGroup?: string;
	deploymentId?: string;
	useOrchestrationMode?: boolean;
	api?: "orchestration" | "foundation-models";
	defaultSettings?: Record<string, unknown>;
}

/**
 * OCA (Oracle Cloud AI) configuration
 */
export interface OcaConfig {
	mode?: "internal" | "external";
	usePromptCache?: boolean;
}

/**
 * Codex CLI provider options
 */
export interface CodexConfig {
	defaultSettings?: Record<string, unknown>;
	modelSettings?: Record<string, unknown>;
}

/**
 * Claude Code provider options
 */
export interface ClaudeCodeConfig {
	[key: string]: unknown;
}

/**
 * OpenCode provider options
 */
export interface OpenCodeConfig {
	hostname?: string;
	port?: number;
	autoStartServer?: boolean;
	serverTimeout?: number;
	defaultSettings?: Record<string, unknown>;
	modelSettings?: Record<string, unknown>;
}

/**
 * Cloud provider configurations (grouped)
 */
export interface CloudConfig {
	/** AWS/Bedrock options */
	aws?: AwsConfig;
	/** Google Cloud/Vertex options */
	gcp?: GcpConfig;
	/** Azure options */
	azure?: AzureConfig;
	/** SAP AI Core options */
	sap?: SapConfig;
	/** OCA options */
	oca?: OcaConfig;
}

/**
 * Sampling parameters passed through to a provider that exposes them.
 *
 * Every field is optional and nothing is defaulted: an unset field is one the
 * request does not mention, which leaves whatever the model was built with in
 * force. That matters for local models, where the Modelfile is where a
 * validated sampler lives and a client that always sends a full set would
 * silently overwrite it.
 *
 * The names are Ollama's own (`/api/chat` `options`), because this exists to
 * carry them and inventing neutral synonyms would only make the mapping
 * lossy. Providers that do not understand a field ignore the whole bag.
 */
export interface ProviderSamplingOptions {
	temperature?: number;
	topK?: number;
	topP?: number;
	minP?: number;
	typicalP?: number;
	repeatLastN?: number;
	repeatPenalty?: number;
	presencePenalty?: number;
	frequencyPenalty?: number;
	seed?: number;
	numPredict?: number;
	numKeep?: number;
	stop?: string[];
	/**
	 * Bound on how many tokens the model may spend inside a thinking block,
	 * as a token count or an effort level. Ollama's `think_budget`.
	 */
	thinkBudget?: string;
	/**
	 * Text written into the thinking block just before the closing tag is
	 * forced, so the model reads that it has to answer now. Ollama's
	 * `think_budget_message`.
	 */
	thinkBudgetMessage?: string;
}

/**
 * Provider-specific options that don't fit other categories
 */
export interface ProviderOptions {
	/** OpenRouter provider sorting preference */
	openRouterProviderSorting?: string;
	/** Runtime model catalog refresh configuration */
	modelCatalog?: ModelCatalogConfig;
	/** Sampling parameters for providers that accept them per request. */
	sampling?: ProviderSamplingOptions;
}

/**
 * Runtime model catalog refresh options
 */
export interface ModelCatalogConfig {
	/** Fetch latest catalog at handler initialization */
	loadLatestOnInit?: boolean;
	/** Fetch provider-private models when auth is available */
	loadPrivateOnAuth?: boolean;
	/** Catalog endpoint URL */
	url?: string;
	/** Cache TTL for live catalog in milliseconds */
	cacheTtlMs?: number;
	/** Throw when live catalog refresh fails */
	failOnError?: boolean;
}

// =============================================================================
// Main Configuration Interface
// =============================================================================

/**
 * Unified provider configuration interface
 *
 * This is the single configuration interface that clients provide.
 * All provider-specific options are grouped into logical sub-interfaces.
 */
export interface ProviderConfig
	extends AuthConfig,
		EndpointConfig,
		ModelConfig,
		TokenConfig,
		ReasoningConfig,
		RegionConfig,
		CloudConfig,
		ProviderOptions {
	/** Client type - determines which handler to use - OpenAI-Compatible deafult */
	clientType?: ProviderClient;

	/** Provider ID */
	providerId: ProviderId;

	/**
	 * Optional built-in provider family to use for handler routing.
	 *
	 * This lets clients expose a custom provider ID and model catalog while
	 * reusing the runtime behavior of a built-in provider implementation.
	 */
	routingProviderId?: ProviderId;

	/** Capabilities this provider/model supports */
	capabilities?: ProviderCapability[];

	/** Task/session ID for telemetry */
	taskId?: string;

	/** AbortSignal for cancelling requests */
	abortSignal?: AbortSignal;

	/** Optional runtime logger for provider-level diagnostics */
	logger?: BasicLogger;

	/**
	 * Ambient runtime context: user identity, client surface, workspace info,
	 * logger, and telemetry service. Prefer reading logger and telemetry from
	 * here when available; the top-level logger field is kept for compatibility.
	 */
	extensionContext?: ExtensionContext;

	/** Codex CLI-specific options */
	codex?: CodexConfig;

	/** Claude Code-specific options */
	claudeCode?: ClaudeCodeConfig;

	/** OpenCode-specific options */
	opencode?: OpenCodeConfig;
}

/**
 * Simplified configuration for common use cases
 */
export interface SimpleProviderConfig {
	providerId: ProviderId;
	clientType: ProviderClient;
	apiKey: string;
	modelId: string;
	baseUrl?: string;
}

/**
 * Create a full ProviderConfig from a simple config
 */
export function createConfig(simple: SimpleProviderConfig): ProviderConfig {
	return {
		providerId: simple.providerId,
		clientType: simple.clientType,
		apiKey: simple.apiKey,
		modelId: simple.modelId,
		baseUrl: simple.baseUrl,
	};
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if a provider config has a specific capability
 */
export function hasCapability(
	config: ProviderConfig,
	capability: ProviderCapability,
): boolean {
	return config.capabilities?.includes(capability) ?? false;
}

/**
 * Check if provider supports reasoning/thinking
 */
export function supportsReasoning(config: ProviderConfig): boolean {
	return hasCapability(config, "reasoning");
}

/**
 * Check if provider supports prompt caching
 */
export function supportsPromptCache(config: ProviderConfig): boolean {
	return hasCapability(config, "prompt-cache");
}

/**
 * Resolve the provider ID used for handler selection and built-in behavior.
 */
export function resolveRoutingProviderId(
	config: Pick<ProviderConfig, "providerId" | "routingProviderId">,
): string {
	return normalizeProviderId(config.routingProviderId ?? config.providerId);
}

// =============================================================================
// Deprecated Types (for backwards compatibility)
// =============================================================================

/**
 * @deprecated Use ProviderConfig directly - all fields are now unified
 */
export type ProviderSpecificConfig = Pick<
	ProviderConfig,
	| "aws"
	| "gcp"
	| "azure"
	| "sap"
	| "oca"
	| "maxInputTokens"
	| "apiLine"
	| "oauthPath"
	| "openRouterProviderSorting"
>;

/**
 * @deprecated Use ProviderConfig directly
 */
export type ProviderDefaultsConfig = Pick<
	ProviderConfig,
	"baseUrl" | "modelId" | "knownModels" | "headers" | "capabilities"
>;

import type {
	AgentMessage,
	AgentModelEvent,
	AgentToolDefinition,
} from "../agent";
import type { BasicLogger } from "../logging/logger";
import type { ProviderCapability, ProviderConfigField } from "../rpc/runtime";
import type { ITelemetryService } from "../services/telemetry";
import type {
	ModelModalities,
	ModelModality,
	ModelOperation,
	ModelOperationMode,
} from "./model-info";
import type { ModelTool, ModelToolName } from "./model-tools";
import type {
	ModelReasoningOption,
	ReasoningEffort,
} from "./reasoning-options";

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue | undefined };

// AgentToolDefinition, AgentMessagePart, AgentMessage, AgentModelRequest,
// AgentModelFinishReason, AgentModelEvent, AgentModel, and AgentModelUsage
// previously lived here with gateway-local shapes. They have been retired in
// favor of the canonical AgentRuntime types in `../agent` (PLAN.md §3.6 Step 3,
// expanded). `AgentModelUsage` is superseded by `AgentUsage` (`AgentTokenUsage`
// + optional `totalCost`); usage deltas on `AgentModelEvent` are now
// `Partial<AgentUsage>`.

export type GatewayModelCapability =
	| "text"
	| "tools"
	| "reasoning"
	| "prompt-cache"
	| "images"
	| "audio"
	| "structured-output";

export type GatewayPromptCacheStrategy = "anthropic-automatic";
export const USAGE_COST_DISPLAYS = ["show", "hide", "subscription"] as const;
export type GatewayUsageCostDisplay = (typeof USAGE_COST_DISPLAYS)[number];
export type GatewayPromptCacheFormat =
	| "anthropic-cache-control"
	| "bedrock-cache-point";
export type GatewayReasoningFormat =
	| "anthropic-thinking"
	| "glm-thinking"
	| "minimax-thinking";
export type GatewayModelRoute =
	| { matcher: "anthropic-compatible" }
	| {
			matcher: "model-operation";
			operation: ModelOperation;
	  }
	| {
			matcher: "model-output-modality";
			modality: ModelModality;
	  }
	| {
			matcher: "model-family";
			family: string;
			requiredCapability?: GatewayModelCapability;
	  }
	| {
			matcher: "model-id";
			modelId: string;
			requiredCapability?: GatewayModelCapability;
	  };

/**
 * A provider-executed model tool exposed for matching models.
 *
 * Omitted `routes` means the tool is supported by every model on the provider.
 * Exclusion routes take precedence so mixed transports such as Vertex can
 * disable a tool for one model family while retaining a provider-level default.
 */
export interface GatewayModelToolCapability {
	name: ModelToolName;
	routes?: readonly GatewayModelRoute[];
	excludeRoutes?: readonly GatewayModelRoute[];
}

/** A provider transport capable of executing a matching model operation. */
export interface GatewayModelOperationCapability {
	operation: ModelOperation;
	modes?: readonly ModelOperationMode[];
	inputModalities?: readonly ModelModality[];
	outputModalities?: readonly ModelModality[];
	routes?: readonly GatewayModelRoute[];
	excludeRoutes?: readonly GatewayModelRoute[];
}

export interface GatewayProviderRouting {
	promptCache?: {
		format: GatewayPromptCacheFormat;
		routes: GatewayModelRoute[];
	};
	reasoning?: {
		format: GatewayReasoningFormat;
		routes: GatewayModelRoute[];
	};
}

export type GatewayStickySessionTransport = "json-body" | "header";

export interface GatewayStickySessionMetadata {
	/**
	 * Where the provider expects the sticky-session identifier on the wire.
	 * `field` is a JSON body property for `json-body`, and an HTTP header name
	 * for `header`.
	 */
	transport: GatewayStickySessionTransport;
	field: string;
	metadataKey: string;
}

export interface GatewayProviderMetadata {
	promptCacheStrategy?: GatewayPromptCacheStrategy;
	usageCostDisplay?: GatewayUsageCostDisplay;
	routing?: GatewayProviderRouting;
	stickySession?: GatewayStickySessionMetadata;
	/**
	 * Provider-specific transport used for models whose output includes images.
	 * OpenRouter-compatible image responses require a richer schema than the
	 * generic OpenAI-compatible adapter exposes.
	 */
	imageTransport?: "openrouter";
	/** Provider-owned implementation used for the transcription operation. */
	transcriptionTransport?:
		| "openai-compatible"
		| "vercel-ai-gateway"
		| "elevenlabs";
	/**
	 * Successful JSON responses are wrapped by the provider before reaching
	 * the protocol adapter. `success-data` represents `{ success, data }`.
	 */
	responseEnvelope?: "success-data";
	configFields?: readonly ProviderConfigField[];
	[key: string]:
		| JsonValue
		| GatewayProviderRouting
		| GatewayStickySessionMetadata
		| readonly ProviderConfigField[]
		| undefined;
}

export interface GatewayModelDefinition {
	id: string;
	name: string;
	providerId: string;
	description?: string;
	contextWindow?: number;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	operation?: ModelOperation;
	operationModes?: readonly ModelOperationMode[];
	modalities?: ModelModalities;
	capabilities?: readonly GatewayModelCapability[];
	reasoningOptions?: readonly ModelReasoningOption[];
	metadata?: Record<string, JsonValue | undefined>;
}

export interface GatewayProviderManifest {
	id: string;
	name: string;
	description?: string;
	defaultModelId: string;
	models: readonly GatewayModelDefinition[];
	modelOperationCapabilities?: readonly GatewayModelOperationCapability[];
	modelToolCapabilities?: readonly GatewayModelToolCapability[];
	capabilities?: readonly ProviderCapability[];
	env?: readonly ("browser" | "node")[];
	api?: string;
	apiKeyEnv?: readonly string[];
	docsUrl?: string;
	metadata?: GatewayProviderMetadata;
}

export interface GatewayProviderSettings {
	apiKey?: string;
	apiKeyResolver?: () => string | undefined | Promise<string | undefined>;
	apiKeyEnv?: readonly string[];
	baseUrl?: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
	fetch?: typeof fetch;
	options?: Record<string, unknown>;
	metadata?: GatewayProviderMetadata;
}

export interface GatewayResolvedProviderConfig extends GatewayProviderSettings {
	providerId: string;
}

export interface GatewayProviderConfig extends GatewayProviderSettings {
	providerId: string;
	enabled?: boolean;
	defaultModelId?: string;
	models?: readonly Omit<GatewayModelDefinition, "providerId">[];
}

export interface GatewayModelSelection {
	providerId: string;
	modelId?: string;
}

export interface GatewayResolvedModel {
	provider: GatewayProviderManifest;
	model: GatewayModelDefinition;
}

export interface GatewayProviderContext {
	provider: GatewayProviderManifest;
	model: GatewayModelDefinition;
	config: GatewayResolvedProviderConfig;
	signal?: AbortSignal;
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
}

export interface GatewayStreamRequest {
	providerId: string;
	modelId: string;
	systemPrompt?: string;
	messages: readonly AgentMessage[];
	tools?: readonly AgentToolDefinition[];
	/** Provider-executed tools requested independently of runtime tools. */
	modelTools?: readonly ModelTool[];
	temperature?: number;
	maxTokens?: number;
	/**
	 * Set by the gateway when `maxTokens` was synthesized from gateway/model
	 * defaults rather than derived from an explicit caller cap. Providers can
	 * use this to avoid forwarding synthesized caps to backends that reject
	 * them, while still honoring explicit caps from any caller — including
	 * ones that reach the provider without going through the gateway.
	 */
	defaultedMaxTokens?: boolean;
	/**
	 * Set when this request is the machinery's own, not the conversation's.
	 *
	 * Summarisers, condensers and title writers go out through the same gateway
	 * as the turn they serve, and the request path keeps one process-wide record
	 * of "the last request" -- its token count, its measured chars-per-token,
	 * what capped it. An auxiliary request writing to those makes the next
	 * compaction pass reason about the wrong request entirely. Measured: a
	 * 25,969-token condenser prompt overwrote a 67,572-token conversation, and
	 * compaction stood down at `triggerInputTokens: 25969` on a transcript of
	 * 262,915 characters.
	 *
	 * The request is served identically. It just does not get to speak for the
	 * session.
	 *
	 * Note that this flag no longer decides who writes those records --
	 * `conversation` does, and it is the positive form of the same question.
	 * `auxiliary` still says how the request is scheduled: it queues behind the
	 * conversation instead of racing it for a local server's single slot.
	 */
	auxiliary?: boolean;
	/**
	 * Set when this request *is* the conversation, and so may speak for it.
	 *
	 * The request path keeps one process-wide record of "the last request" --
	 * its token count, what capped its reply, whether it found room at all --
	 * and the compaction pass reads all three back. Only the turn those records
	 * describe may write them.
	 *
	 * Stated positively on purpose. It was stated negatively (`auxiliary`), and
	 * the two things that had to remember to say "not me" were a whole host each:
	 * neither `apps/vscode` nor `apps/cli` set the flag anywhere, so a vision
	 * description or a commit message left its own small count standing as the
	 * session's, and auto-compaction stood down on a transcript that was full
	 * (mann1x/cline#68). Forgetting this one costs an estimate instead of a
	 * measurement, which is a bad turn rather than a dead run.
	 */
	conversation?: boolean;
	/**
	 * Which session this request belongs to, when the caller knows.
	 *
	 * Two conversations can share a process -- a delegated agent and the lead
	 * that spawned it, most of all -- and both are entitled to write the records
	 * above. The id is what keeps them from answering each other's questions.
	 * Unknown on either side reads as a match, so a caller that cannot name its
	 * session keeps the behaviour it had.
	 */
	sessionId?: string;
	metadata?: Record<string, unknown>;
	reasoning?: {
		enabled?: boolean;
		effort?: ReasoningEffort;
		budgetTokens?: number;
	};
	signal?: AbortSignal;
}

export interface GatewayProvider {
	stream(
		request: GatewayStreamRequest,
		context: GatewayProviderContext,
	): AsyncIterable<AgentModelEvent> | Promise<AsyncIterable<AgentModelEvent>>;
}

export type GatewayProviderFactory = (
	config: GatewayResolvedProviderConfig,
) => GatewayProvider | Promise<GatewayProvider>;

export interface GatewayProviderRegistration {
	manifest: GatewayProviderManifest;
	defaults?: GatewayProviderSettings;
	createProvider?: GatewayProviderFactory;
	loadProvider?: () => Promise<
		Pick<GatewayProviderRegistration, "createProvider">
	>;
}

export interface GatewayModelHandleOptions {
	tools?: readonly AgentToolDefinition[];
	modelTools?: readonly ModelTool[];
	temperature?: number;
	maxTokens?: number;
	/** See `GatewayStreamRequest.auxiliary`. */
	auxiliary?: boolean;
	/** See `GatewayStreamRequest.conversation`. */
	conversation?: boolean;
	/** See `GatewayStreamRequest.sessionId`. */
	sessionId?: string;
	metadata?: Record<string, unknown>;
	reasoning?: {
		enabled?: boolean;
		effort?: ReasoningEffort;
		budgetTokens?: number;
	};
	signal?: AbortSignal;
}

export interface GatewayConfig {
	builtins?: false | readonly string[];
	providers?: readonly GatewayProviderRegistration[];
	providerConfigs?: readonly GatewayProviderConfig[];
	fetch?: typeof fetch;
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
}

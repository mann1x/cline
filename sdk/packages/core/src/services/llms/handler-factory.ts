import {
	createGateway,
	createHandlerAsync,
	hasRegisteredHandler,
	MODEL_COLLECTIONS_BY_PROVIDER_ID,
	normalizeProviderId,
	toGatewayModelCapabilities,
} from "@cline/llms";
import type {
	AgentConfig,
	AgentModel,
	BasicLogger,
	GatewayModelDefinition,
	ITelemetryService,
	ModelInfo,
} from "@cline/shared";
import { createAgentModelFromApiHandler } from "./apihandler-agent-model-adapter";
import type { ProviderConfig } from "./provider-settings";

function compactOptions(
	options: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const compacted = Object.fromEntries(
		Object.entries(options).filter(([, value]) => value !== undefined),
	);
	return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function usesOpenAICompatibleClient(config: ProviderConfig): boolean {
	return (
		config.providerId === "openai-compatible" ||
		config.clientType === "openai-compatible"
	);
}

/**
 * One id for every request this process makes outside a conversation.
 *
 * Stable rather than per-request: these calls are ours, so letting them share
 * affinity with each other costs nothing, while a fresh id each time would put
 * a new session in the engine's ledger for every commit message. What matters
 * is only that it is never a real conversation's id and never absent.
 */
let AUX_SESSION_ID: string | undefined;

function auxiliarySessionId(): string {
	AUX_SESSION_ID ??= `cerebriline-aux-${Math.random().toString(36).slice(2, 10)}`;
	return AUX_SESSION_ID;
}

function buildGatewayProviderOptions(
	config: ProviderConfig,
	sessionId?: string,
): Record<string, unknown> | undefined {
	const options: Record<string, unknown> = {
		region: config.region,
		apiLine: config.apiLine,
		openRouterProviderSorting: config.openRouterProviderSorting,
		modelCatalog: config.modelCatalog,
		// The configured sampler. `ProviderConfig` carries it at the top level —
		// `toProviderConfig` reads it straight off providers.json — but vendors
		// read their settings out of this bag, so a field that is never lifted
		// into it reaches nothing.
		//
		// Measured on a live box: `temperature: 0.6` and `frequencyPenalty: 0.3`
		// sat in providers.json for days and never once appeared on the wire.
		// Every request carried exactly `num_ctx` and `num_predict`, which arrive
		// by other routes, so the payload looked well-formed while the model ran
		// on its Modelfile defaults. Both hosts were affected: this is the only
		// place the lift can happen for either.
		sampling: config.sampling,
		// The PolyKV section, lifted for exactly the reason above. It is read off
		// this bag by the opencoti vendor and by nothing else, so a section left
		// on the config configures nothing while reading as configured.
		polykv: config.polykv,
	};

	if (usesOpenAICompatibleClient(config)) {
		Object.assign(options, {
			apiVersion: config.azure?.apiVersion,
			useIdentity: config.azure?.useIdentity,
		});
	}

	// The pool a request attaches to is not in the config -- it changes every
	// time a compaction re-roots the conversation -- so what travels here is the
	// key the vendor looks the live pool up under. See `polykv-session.ts`.
	//
	// **An opencoti request always carries one, even with no conversation
	// behind it.** The engine binds a session to a slot and keeps that affinity
	// so a later `from_session` snapshot can be taken from the cache still
	// resident there; a request arriving with NO session id can reuse another
	// session's slot without clearing its affinity, and that session's next
	// snapshot is then built from our context. Title generation, commit
	// messages and the vision probe all build a handler with no conversation,
	// so this is reachable -- and on a shared server the session it corrupts
	// belongs to somebody else.
	if (normalizeProviderId(config.providerId) === "opencoti") {
		const engineSession =
			config.engineSessionId || sessionId || auxiliarySessionId();
		options.polykvSessionId = engineSession;
		if (config.polykvWorker) {
			options.polykvWorker = {
				...config.polykvWorker,
				sessionId: engineSession,
			};
		}
	}

	if (config.providerId === "bedrock") {
		Object.assign(options, {
			authentication: config.aws?.authentication,
			profile: config.aws?.profile,
			accessKeyId: config.aws?.accessKey,
			secretAccessKey: config.aws?.secretKey,
			sessionToken: config.aws?.sessionToken,
			usePromptCache: config.aws?.usePromptCache,
			useCrossRegionInference: config.useCrossRegionInference,
			useGlobalInference: config.useGlobalInference,
			endpoint: config.aws?.endpoint,
			customModelBaseId: config.aws?.customModelBaseId,
		});
	}

	if (config.providerId === "vertex") {
		const gcpRegion = config.gcp?.region ?? config.region;
		Object.assign(options, {
			project: config.gcp?.projectId,
			projectId: config.gcp?.projectId,
			location: gcpRegion,
			region: gcpRegion,
		});
	}

	if (config.providerId === "claude-code") {
		// The Claude Code CLI executes its own tools, so its session must be
		// anchored on the workspace. Without an explicit cwd the spawned CLI
		// inherits the host process cwd — `/` in GUI extension hosts — and
		// then refuses writes outside its allowed working directories.
		const workspace = config.extensionContext?.workspace;
		Object.assign(options, {
			cwd: workspace?.cwd ?? workspace?.rootPath,
		});
	}

	if (config.providerId === "sapaicore") {
		Object.assign(options, config.sap);
	}

	return compactOptions(options);
}

function readPositiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: undefined;
}

export function resolveKnownModelsFromConfig(
	config: AgentConfig,
): Record<string, ModelInfo> | undefined {
	const pc = config.providerConfig as ProviderConfig | undefined;
	const knownModels = pc?.knownModels
		? pc.knownModels
		: (config.knownModels ??
			MODEL_COLLECTIONS_BY_PROVIDER_ID[config.providerId]?.models ??
			undefined);
	// Caller-configured limits are authoritative for the selected model —
	// surface them to the gateway so the resolved model definition carries
	// the right limits (e.g. Ollama's num_ctx derives from the resolved
	// model's context window):
	//  - `maxInputTokens` is where `ProviderSettings.contextWindow` lands via
	//    `toProviderConfig` (the providers.json path used by CLI/Core hosts).
	//  - `modelInfo` is an explicit per-model override (the VS Code path);
	//    it wins over the generic limit.
	const configuredContextWindow = readPositiveInteger(pc?.maxInputTokens);
	const modelInfo =
		pc?.modelInfo && pc.modelInfo.id === config.modelId
			? pc.modelInfo
			: undefined;
	if (configuredContextWindow === undefined && !modelInfo) {
		return knownModels;
	}
	return {
		...(knownModels ?? {}),
		[config.modelId]: {
			...knownModels?.[config.modelId],
			...(configuredContextWindow !== undefined
				? {
						contextWindow: configuredContextWindow,
						maxInputTokens: configuredContextWindow,
					}
				: {}),
			...modelInfo,
			id: config.modelId,
		},
	};
}

function toGatewayConfiguredModel(
	id: string,
	model: ModelInfo,
): Omit<GatewayModelDefinition, "providerId"> {
	return {
		id,
		name: model.name ?? id,
		description: model.description,
		contextWindow: model.contextWindow,
		maxInputTokens: model.maxInputTokens,
		maxOutputTokens: model.maxTokens,
		operation: model.operation,
		operationModes: model.operationModes,
		modalities: model.modalities,
		capabilities: toGatewayModelCapabilities(model.capabilities),
		reasoningOptions: model.reasoningOptions,
		metadata: {
			family: model.family,
			pricing: model.pricing,
			status: model.status,
			releaseDate: model.releaseDate,
		},
	};
}

export interface CreateAgentModelOptions {
	/**
	 * Set by the caller that is running the conversation itself.
	 *
	 * The request path keeps process-wide records of what the last request cost
	 * and what capped it, and compaction reads them back; only the conversation
	 * may write them. This factory serves the agent loop *and* the machinery
	 * around it -- the CLI builds its image describer from the same call -- so
	 * the loop has to say so rather than the describer having to say it is not.
	 */
	conversation?: boolean;
	/**
	 * Force the auxiliary scheduling this config did not carry.
	 *
	 * A caller that builds its model from a session's config inherits that
	 * config's `providerConfig`, which is the conversation's; there is no place
	 * on it to say "but this call is not". This is that place.
	 */
	auxiliary?: boolean;
}

export function createAgentModelFromConfig(
	config: AgentConfig,
	logger: BasicLogger | undefined,
	telemetry?: ITelemetryService,
	options?: CreateAgentModelOptions,
): AgentModel {
	const pc = config.providerConfig as ProviderConfig | undefined;
	const baseProviderConfig =
		pc?.providerId === config.providerId ? pc : undefined;
	const normalizedProviderConfig: ProviderConfig = {
		...(baseProviderConfig ?? {}),
		providerId: config.providerId,
		modelId: config.modelId,
		apiKey: config.apiKey ?? baseProviderConfig?.apiKey,
		baseUrl: config.baseUrl ?? baseProviderConfig?.baseUrl,
		headers: config.headers ?? baseProviderConfig?.headers,
		knownModels: resolveKnownModelsFromConfig(config),
		maxOutputTokens: config.maxTokensPerTurn,
		temperature: config.temperature,
		reasoningEffort: config.reasoningEffort,
		thinkingBudgetTokens: config.thinkingBudgetTokens,
		thinking: config.thinking,
		logger,
		extensionContext: config.extensionContext,
		...(config.engineSessionId
			? { engineSessionId: config.engineSessionId }
			: {}),
		...(config.polykvWorker ? { polykvWorker: config.polykvWorker } : {}),
	};

	// Host-registered custom handlers (e.g. VS Code LM, which needs the host's
	// `vscode.lm` API) are not part of the gateway. When a handler is registered
	// for this provider, adapt its `ApiHandler` surface onto the `AgentModel`
	// contract the runtime expects. The handler is built lazily (via
	// `createHandlerAsync`) on the first stream so that providers registered
	// with `registerAsyncHandler` resolve correctly.
	if (
		hasRegisteredHandler(
			normalizeProviderId(normalizedProviderConfig.providerId),
		)
	) {
		return createAgentModelFromApiHandler(() =>
			createHandlerAsync(normalizedProviderConfig),
		);
	}

	return createGateway({
		// Forward the host-provided fetch so inference honors proxy/CA config on
		// JetBrains and CLI, where the global fetch is not proxy-aware. Without
		// this the agent loop falls back to bare global fetch and corporate
		// proxy/self-signed CA setups fail.
		fetch: normalizedProviderConfig.fetch,
		providerConfigs: [
			{
				providerId: normalizedProviderConfig.providerId,
				apiKey: normalizedProviderConfig.apiKey,
				baseUrl: normalizedProviderConfig.baseUrl,
				headers: normalizedProviderConfig.headers,
				timeoutMs: normalizedProviderConfig.timeoutMs,
				fetch: normalizedProviderConfig.fetch,
				// The session's resolved per-turn budget. Without it the gateway
				// synthesizes the flat anchor for any model that publishes a cap,
				// and the prompt's stated budget never reaches the wire.
				defaultMaxOutputTokens: normalizedProviderConfig.defaultMaxOutputTokens,
				// How much prior reasoning goes back to the model. Read at request
				// time off `context.config`, which is *this* object — so a setting
				// absent here is `undefined` at the only place that decides, and
				// the replay control does nothing on any of its four values.
				// Measured before this line existed: `reasoningHistory: "all"` held
				// correctly as far as `normalizedProviderConfig`, and the plan still
				// resolved `{"scope":"none"}` against messages carrying 2,297
				// characters of reasoning.
				reasoningHistory: normalizedProviderConfig.reasoningHistory,
				reasoningInline: normalizedProviderConfig.reasoningInline,
				options: buildGatewayProviderOptions(
					normalizedProviderConfig,
					config.sessionId,
				),
				models: normalizedProviderConfig.knownModels
					? Object.entries(normalizedProviderConfig.knownModels).map(
							([id, model]) => toGatewayConfiguredModel(id, model),
						)
					: undefined,
			},
		],
		logger,
		telemetry:
			telemetry ?? config.telemetry ?? config.extensionContext?.telemetry,
	}).createAgentModel(
		{
			providerId: normalizedProviderConfig.providerId,
			modelId: normalizedProviderConfig.modelId,
		},
		{
			maxTokens: normalizedProviderConfig.maxOutputTokens,
			temperature: normalizedProviderConfig.temperature,
			auxiliary: options?.auxiliary ?? normalizedProviderConfig.auxiliary,
			conversation: options?.conversation === true,
			sessionId: config.sessionId,
		},
	);
}

export {
	isProviderApiLine,
	OLLAMA_DEFAULT_CONTEXT_WINDOW,
	type ProviderApiLine,
	resolveProviderApiLineBaseUrl,
} from "./providers/builtins";
export {
	type ApiHandler,
	BUILT_IN_PROVIDER,
	BUILT_IN_PROVIDER_IDS,
	type BuiltInProviderId,
	type HandlerFactory,
	isBuiltInProviderId,
	type LazyHandlerFactory,
	normalizeProviderId,
	type ProviderCapability,
	type ProviderConfig,
	type ProviderId,
	type ProviderSamplingOptions,
} from "./providers/types";

import {
	createGatewayApiHandler,
	createGatewayApiHandlerAsync,
} from "./providers/compat";
import {
	getRegisteredHandler,
	getRegisteredHandlerAsync,
	hasRegisteredHandler,
	isRegisteredHandlerAsync,
} from "./providers/factory-registry";
import {
	type ApiHandler,
	normalizeProviderId,
	type ProviderConfig,
} from "./providers/types";

export { classifyProviderError } from "./providers/error-classification";
export {
	ClineFreeModelLimitError,
	ClineNotSubscribedError,
	ClineOrgIndividualInferenceSubscriptionError,
	ClinePassLimitError,
	extractClineFreeModelLimitResetTime,
	extractClinePassLimitMessage,
	getClineNotSubscribedMessage,
	getClineOrgIndividualInferenceSubscriptionMessage,
	getClinePassSubscriptionUrl,
	isClineFreeModelLimitError,
	isClineFreeModelLimitMessage,
	isClineModelNotFoundMessage,
	isClineNotSubscribedError,
	isClineNotSubscribedMessage,
	isClineOrgIndividualInferenceSubscriptionError,
	isClineOrgIndividualInferenceSubscriptionMessage,
	isClinePassLimitError,
	isClinePassLimitMessage,
} from "./providers/errors";
export {
	getRegisteredHandler,
	getRegisteredHandlerAsync,
	hasRegisteredHandler,
	isRegisteredHandlerAsync,
	registerAsyncHandler,
	registerHandler,
} from "./providers/factory-registry";
export type {
	ApiStreamChunk,
	ContentBlock,
	FileContent,
	HandlerModelInfo,
	ImageContent,
	Message,
	MessageRole,
	MessageWithMetadata,
	RedactedThinkingContent,
	TextContent,
	ThinkingContent,
	ToolDefinition,
	ToolResultContent,
	ToolUseContent,
} from "./providers/types";

function withNormalizedProviderId(config: ProviderConfig): ProviderConfig {
	const providerId = normalizeProviderId(config.providerId);
	const routingProviderId = config.routingProviderId
		? normalizeProviderId(config.routingProviderId)
		: undefined;
	if (
		providerId === config.providerId &&
		routingProviderId === config.routingProviderId
	) {
		return config;
	}
	return { ...config, providerId, routingProviderId };
}

export function createHandler(config: ProviderConfig): ApiHandler {
	const normalizedConfig = withNormalizedProviderId(config);
	const { providerId } = normalizedConfig;

	if (hasRegisteredHandler(providerId)) {
		if (isRegisteredHandlerAsync(providerId)) {
			throw new Error(
				`Handler for "${providerId}" is registered as async. Use createHandlerAsync() instead.`,
			);
		}
		const handler = getRegisteredHandler(providerId, normalizedConfig);
		if (handler) {
			return handler;
		}
	}

	return createGatewayApiHandler(normalizedConfig);
}

export async function createHandlerAsync(
	config: ProviderConfig,
): Promise<ApiHandler> {
	const normalizedConfig = withNormalizedProviderId(config);
	const { providerId } = normalizedConfig;

	if (hasRegisteredHandler(providerId)) {
		const handler = await getRegisteredHandlerAsync(
			providerId,
			normalizedConfig,
		);
		if (handler) {
			return handler;
		}
	}

	return createGatewayApiHandlerAsync(normalizedConfig);
}
// The level an Ollama request stands for when none is set. Exported because
// it decides the thinking budget the server enforces, so anything asking the
// server what that budget will be has to ask about this level.
export {
	hasOllamaFetch,
	hasOllamaNoStreamTimeoutDispatcher,
	OLLAMA_DEFAULT_REASONING_EFFORT,
	// The dispatcher is only honoured by a fetch that reads it, so the host
	// hands over both or neither.
	setOllamaFetch,
	// Takes an opaque `unknown` and touches no Node API, so the browser build
	// carries a setter nobody calls rather than needing a conditional export.
	setOllamaNoStreamTimeoutDispatcher,
} from "./providers/vendors/ollama";

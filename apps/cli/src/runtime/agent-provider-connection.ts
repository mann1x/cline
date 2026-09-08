import {
	type AgentProviderConnection,
	type ProviderSettingsManager,
	toProviderConfig,
} from "@cline/core";

/**
 * Resolves a provider other than the session's, for a configured subagent whose
 * frontmatter names one.
 *
 * Core cannot do this itself: only the host knows where its provider store
 * lives, and the CLI's follows `--config`. Without it a subagent on a second
 * provider inherited the session's base URL, key and context window along with
 * the new provider id — a request to the wrong server, which fails as an auth
 * error or, worse, succeeds against a model nobody chose.
 *
 * Returns `undefined` for a provider the store has never heard of, which core
 * turns into a refusal naming the agent rather than a silent fallback.
 */
export function createAgentProviderConnectionResolver(
	manager: ProviderSettingsManager,
): (providerId: string) => AgentProviderConnection | undefined {
	return (providerId) => {
		const stored = manager.getProviderSettings(providerId);
		if (!stored) {
			return undefined;
		}
		const providerConfig = toProviderConfig(stored);
		return {
			apiKey: providerConfig.apiKey,
			baseUrl: providerConfig.baseUrl,
			headers: providerConfig.headers,
			knownModels: providerConfig.knownModels,
			providerConfig,
		};
	};
}

import {
	primeOllamaAccountStatus,
	readOllamaCloudFlag,
	readOllamaCloudUsage as readUsage,
	resolveOllamaOrigin,
	withXollamaAuth,
} from "@cline/llms"
import { OllamaCloudUsageResponse, OllamaReachabilityRequest } from "@/shared/proto/cline/models"
import { type ProviderCatalogController, parseProviderIdRequest } from "./providerCatalogShared"

/**
 * The ollama.com account's balance and usage, through the configured Ollama or
 * xOllama server, for the settings panel and the task header.
 *
 * Both of those poll this. The read underneath is cached per server and asks
 * ollama.com at most once a minute, so the polling is free; the cadence is
 * the cache's to keep, not the callers'.
 *
 * The base URL comes from the stored provider config, as with every read
 * here, so the webview cannot point it at another server.
 */
export async function readOllamaCloudUsage(
	controller: ProviderCatalogController,
	request: OllamaReachabilityRequest,
): Promise<OllamaCloudUsageResponse> {
	const providerId = parseProviderIdRequest(request.providerId, "providerId")
	const config = controller.getProviderConfigStore().read(providerId)
	const origin = resolveOllamaOrigin(providerId, config.baseUrl)
	// A keyed xOllama answers every route 401 without its key, which would
	// read as "not signed in to ollama.com". Ollama's key is an ollama.com one
	// and the local server signs these itself, so it is not sent.
	const doFetch =
		providerId === "xollama" && config.apiKey
			? withXollamaAuth(fetch, origin, { Authorization: `Bearer ${config.apiKey}`, ...config.headers })
			: fetch

	let cloudModel: boolean | undefined
	if (request.modelId) {
		// Primed once per server; after that this is a lookup.
		await primeOllamaAccountStatus(origin, doFetch)
		cloudModel = readOllamaCloudFlag(origin, request.modelId)
	}

	const usage = await readUsage(origin, { fetchImpl: doFetch })
	const balance = usage.balance
	return OllamaCloudUsageResponse.create({
		state: usage.state,
		...(usage.signinUrl ? { signinUrl: usage.signinUrl } : {}),
		...(balance?.includedBalanceUsd !== undefined ? { includedBalanceUsd: balance.includedBalanceUsd } : {}),
		...(balance?.includedAllowanceUsd !== undefined ? { includedAllowanceUsd: balance.includedAllowanceUsd } : {}),
		...(balance?.periodUntil ? { periodUntil: balance.periodUntil } : {}),
		...(balance?.session ? { session: balance.session } : {}),
		...(balance?.weekly ? { weekly: balance.weekly } : {}),
		...(balance?.purchasedBalanceUsd !== undefined ? { purchasedBalanceUsd: balance.purchasedBalanceUsd } : {}),
		usage: usage.usage.map((totals) => ({ ...totals })),
		...(usage.readAt ? { readAt: usage.readAt } : {}),
		includedExhausted: usage.includedExhausted,
		...(cloudModel !== undefined ? { cloudModel } : {}),
	})
}

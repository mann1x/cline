import { MODEL_COLLECTIONS_BY_PROVIDER_ID, probeOllamaReachability, withXollamaAuth, XOLLAMA_DEFAULT_BASE_URL } from "@cline/llms"
import type { EffectiveProviderConfig } from "@/sdk/model-catalog/contracts"
import { toSdkProviderId } from "@/sdk/model-catalog/sdk-provider-id"
import { StringRequest } from "@/shared/proto/cline/common"
import { ProviderStatusResponse } from "@/shared/proto/cline/models"
import { type ProviderCatalogController, parseProviderIdRequest } from "./providerCatalogShared"

/**
 * Whether a provider's endpoint answers, for the status dot beside the API
 * Provider label.
 *
 * One read of the provider's model list with the stored URL and key -- a
 * route every API in the table below serves for free. A generation would
 * prove more (that the model serves), but it costs tokens on a cloud API and
 * loads the model on a local server, which on a press-to-check button is the
 * wrong trade. Providers with no such route answer "unknown" with the reason,
 * never a guess.
 *
 * Asked from the extension host, as readOllamaReachability is, because that
 * is where requests are sent from: "ready" means ready from there.
 */

export const PROVIDER_STATUS_TIMEOUT_MS = 8000

export type ProviderStatusState = "ready" | "fail" | "unknown"

export interface ProviderStatus {
	state: ProviderStatusState
	detail: string
	url?: string
}

/** How to ask one provider, or why it cannot be asked. */
type Route =
	| { kind: "ollama" }
	| { kind: "models"; url: string; headers: Record<string, string> }
	| { kind: "none"; reason: string }

/** OpenAI-shaped back ends whose `/models` is not the API's: never asked. */
const UNASKABLE: Readonly<Record<string, string>> = {
	cline: "The Cline account has no endpoint to ask without sending a request.",
	"cline-pass": "The Cline account has no endpoint to ask without sending a request.",
	"openai-codex": "The ChatGPT subscription endpoint lists no models to ask.",
	"openai-codex-cli": "The ChatGPT subscription endpoint lists no models to ask.",
}

function join(base: string, path: string): string {
	return `${base.replace(/\/+$/, "")}/${path}`
}

export function routeFor(providerId: string, config: EffectiveProviderConfig): Route {
	if (providerId === "ollama" || providerId === "xollama") {
		return { kind: "ollama" }
	}
	const sdkId = toSdkProviderId(providerId)
	if (UNASKABLE[sdkId]) {
		return { kind: "none", reason: UNASKABLE[sdkId] }
	}
	const provider = MODEL_COLLECTIONS_BY_PROVIDER_ID[sdkId]?.provider
	const client = provider?.client
	const base = config.baseUrl?.trim() || provider?.baseUrl
	const extra = { ...config.headers }
	const key = config.apiKey?.trim()
	switch (client) {
		case "openai":
		case "openai-compatible":
		case "openai-r1": {
			if (!base) {
				return { kind: "none", reason: "No base URL is set." }
			}
			return {
				kind: "models",
				url: join(base, "models"),
				headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extra },
			}
		}
		case "anthropic": {
			if (!key) {
				return { kind: "none", reason: "No API key is set." }
			}
			return {
				kind: "models",
				url: join(base || "https://api.anthropic.com/v1", "models"),
				headers: { "x-api-key": key, "anthropic-version": "2023-06-01", ...extra },
			}
		}
		case "gemini": {
			if (!key) {
				return { kind: "none", reason: "No API key is set." }
			}
			return {
				kind: "models",
				url: join(base || "https://generativelanguage.googleapis.com/v1beta", "models"),
				headers: { "x-goog-api-key": key, ...extra },
			}
		}
		default:
			return {
				kind: "none",
				reason: `${provider?.name ?? providerId} has no free route to ask; it is checked by the first request.`,
			}
	}
}

/** The network error's own words, without the "fetch failed" wrapper. */
function describeFailure(error: unknown): string {
	if (error instanceof Error) {
		if (error.name === "TimeoutError" || error.name === "AbortError") {
			return `no answer within ${PROVIDER_STATUS_TIMEOUT_MS / 1000}s`
		}
		const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause
		if (typeof cause?.code === "string") {
			return cause.code
		}
		if (typeof cause?.message === "string" && cause.message) {
			return cause.message
		}
		return error.message || error.name
	}
	return String(error)
}

export async function probeProviderStatus(
	providerId: string,
	config: EffectiveProviderConfig,
	fetchImpl: typeof fetch = fetch,
): Promise<ProviderStatus> {
	const route = routeFor(providerId, config)
	if (route.kind === "none") {
		return { state: "unknown", detail: route.reason }
	}
	if (route.kind === "ollama") {
		// A keyed xOllama answers every route 401 without its key. Ollama's key
		// is an ollama.com one and its /api/tags needs none, so it is not sent.
		const probeFetch =
			providerId === "xollama" && config.apiKey
				? withXollamaAuth(fetchImpl, config.baseUrl || XOLLAMA_DEFAULT_BASE_URL, {
						Authorization: `Bearer ${config.apiKey}`,
						...config.headers,
					})
				: fetchImpl
		const status = await probeOllamaReachability(providerId, config.baseUrl, undefined, probeFetch)
		const url = join(status.baseUrl, "api/tags")
		if (status.unauthorized) {
			return { state: "fail", detail: `${status.baseUrl} refused the API key (HTTP 401).`, url }
		}
		if (!status.reachable) {
			return { state: "fail", detail: `${status.baseUrl} is not reachable (${status.error ?? "no answer"}).`, url }
		}
		return { state: "ready", detail: `${status.baseUrl} answered.`, url }
	}
	// Never show a key that a provider takes in the query string.
	const shown = route.url.split("?")[0]
	try {
		const response = await fetchImpl(route.url, {
			method: "GET",
			headers: route.headers,
			signal: AbortSignal.timeout(PROVIDER_STATUS_TIMEOUT_MS),
		})
		// Only the status is read; release the body.
		void response.body?.cancel().catch(() => {})
		if (response.ok) {
			return { state: "ready", detail: `${shown} answered (HTTP ${response.status}).`, url: shown }
		}
		if (response.status === 401 || response.status === 403) {
			return { state: "fail", detail: `${shown} refused the API key (HTTP ${response.status}).`, url: shown }
		}
		return { state: "fail", detail: `${shown} answered HTTP ${response.status}.`, url: shown }
	} catch (error) {
		return { state: "fail", detail: `${shown} is not reachable (${describeFailure(error)}).`, url: shown }
	}
}

export async function readProviderStatus(
	controller: ProviderCatalogController,
	request: StringRequest,
): Promise<ProviderStatusResponse> {
	const providerId = parseProviderIdRequest(request.value, "value")
	const config = controller.getProviderConfigStore().read(providerId)
	const status = await probeProviderStatus(providerId, config)
	return ProviderStatusResponse.create({
		state: status.state,
		detail: status.detail,
		...(status.url !== undefined ? { url: status.url } : {}),
	})
}

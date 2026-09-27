import { probeOllamaReachability } from "@cline/llms"
import { OllamaReachabilityRequest, OllamaReachabilityResponse } from "@/shared/proto/cline/models"
import { type ProviderCatalogController, parseProviderIdRequest } from "./providerCatalogShared"

/**
 * Whether the chat input's Ollama or xOllama server answers.
 *
 * Asked from the extension host rather than the webview because the host is
 * where the chat request is sent from, so "reachable" means reachable from
 * there -- a server bound to another machine's loopback is not.
 *
 * The base URL comes from the stored provider config rather than the request,
 * as with every other read here, so the chat input shows the server it is
 * configured against and cannot be pointed somewhere else from the webview.
 */
export async function readOllamaReachability(
	controller: ProviderCatalogController,
	request: OllamaReachabilityRequest,
): Promise<OllamaReachabilityResponse> {
	const providerId = parseProviderIdRequest(request.providerId, "providerId")
	const config = controller.getProviderConfigStore().read(providerId)
	const status = await probeOllamaReachability(providerId, config.baseUrl, request.modelId)
	return OllamaReachabilityResponse.create({
		reachable: status.reachable,
		baseUrl: status.baseUrl,
		...(status.error !== undefined ? { error: status.error } : {}),
		...(status.modelFound !== undefined ? { modelFound: status.modelFound } : {}),
	})
}

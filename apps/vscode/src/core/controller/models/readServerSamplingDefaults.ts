import { readServerSamplingDefaults as readDefaults } from "@cline/llms"
import { ServerSamplingDefaults, ServerSamplingDefaultsRequest } from "@/shared/proto/cline/models"
import { type ProviderCatalogController, parseProviderIdRequest } from "./providerCatalogShared"

/**
 * The sampler values the configured llama.cpp or opencoti server applies when
 * a request leaves a field out, for the sampling placeholders.
 *
 * Ollama answers the same question from `/api/show`; this path used to answer
 * nothing, and every blank field read "model default" while the server was in
 * fact running temperature 0.8, top_k 64 and the rest. A server without
 * `/props` (vLLM, a hosted API) answers no parameters, and the fields keep
 * saying "model default".
 *
 * The base URL comes from the stored provider config, as with the other reads
 * here, so the webview cannot point it elsewhere.
 */
export async function readServerSamplingDefaults(
	controller: ProviderCatalogController,
	request: ServerSamplingDefaultsRequest,
): Promise<ServerSamplingDefaults> {
	const providerId = parseProviderIdRequest(request.providerId)
	const config = controller.getProviderConfigStore().read(providerId)
	const read = await readDefaults(config.baseUrl, request.modelId || undefined)
	return ServerSamplingDefaults.create({ reachable: read.reachable, parameters: read.parameters })
}

import { probeOpencotiProps } from "@cline/llms"
import { StringRequest } from "@/shared/proto/cline/common"
import { OpencotiEngineResponse } from "@/shared/proto/cline/models"
import { type ProviderCatalogController, parseProviderIdRequest } from "./providerCatalogShared"

/**
 * Which controller decides concurrency on the configured opencoti server.
 *
 * One `GET /props`, cached per server by the probe, and nothing else. That is
 * the whole reason this exists beside {@link readPolykvStatus} rather than
 * inside it: the status strip's reads include `/polykv/tps`, which on the
 * published engine answers its headers with a `200` and then never ends the
 * body, so anything sharing that call waits out the read's bound before it can
 * say anything. The Parallel Sessions field spent that bound showing "Default:
 * 1" on a server with PolyKV admission on -- the opposite of what it should
 * have said, for five seconds, every time the panel opened.
 *
 * The base URL comes from the stored provider config rather than the request,
 * as with every other read here, so the panel shows the server it is
 * configured against and cannot be pointed somewhere else from the webview.
 */
export async function readOpencotiEngine(
	controller: ProviderCatalogController,
	request: StringRequest,
): Promise<OpencotiEngineResponse> {
	const providerId = parseProviderIdRequest(request.value, "value")
	const config = controller.getProviderConfigStore().read(providerId)
	const props = await probeOpencotiProps(config.baseUrl)
	return OpencotiEngineResponse.create({
		reachable: props.reachable,
		release: props.release,
		poolsEnabled: props.poolsEnabled,
		elastic: props.elastic,
	})
}

import {
	forgetXollamaModel,
	readOpencotiStatus,
	readXollamaEngines,
	readXollamaModel,
	resolveOllamaOrigin,
	xollamaEngineFetch,
	xollamaEngineRoot,
} from "@cline/llms"
import { OllamaReachabilityRequest, XollamaModelStatusResponse } from "@/shared/proto/cline/models"
import { type ProviderCatalogController, parseProviderIdRequest } from "./providerCatalogShared"
import { toPolykvStatusProto } from "./readPolykvStatus"

/** `qwen3` and `qwen3:latest` are one model to the server. */
function sameTag(a: string, b: string): boolean {
	const full = (name: string) => (name.includes(":") ? name : `${name}:latest`)
	return full(a) === full(b)
}

/**
 * Which of the three cases an xOllama model is in, asked when the panel shows
 * it (xollama mail #414):
 *
 * - a **council**: xOllama runs the council on the engine and owns its pools;
 *   the lead's chat sends no pool controls;
 * - a **plain model with seats** (`session.client_pools` > 0): Cerebriline
 *   drives PolyKV as it does on opencoti, through `/api/engine`;
 * - a **plain model without seats**: the engine refuses every client create,
 *   so nothing is pooled and the panel says what to set.
 *
 * The model's cached answer is dropped first, so a model given seats since the
 * last read is pooled from the next turn, not after a reload. The engine's
 * status is read only in the second case, and only once the model is loaded:
 * `/api/engine` cannot load a model, and a model that is not running has no
 * engine to ask.
 */
export async function readXollamaModelStatus(
	controller: ProviderCatalogController,
	request: OllamaReachabilityRequest,
): Promise<XollamaModelStatusResponse> {
	const providerId = parseProviderIdRequest(request.providerId, "providerId")
	const model = request.modelId?.trim()
	if (!model) {
		return XollamaModelStatusResponse.create({ reachable: false })
	}
	const config = controller.getProviderConfigStore().read(providerId)
	const origin = resolveOllamaOrigin(providerId, config.baseUrl)
	forgetXollamaModel(origin, model)
	const info = await readXollamaModel(origin, model, fetch)
	if (!info) {
		return XollamaModelStatusResponse.create({ reachable: false })
	}
	const engines = await readXollamaEngines(origin, fetch)
	const engine = [...engines].find(([name]) => sameTag(name, model))?.[1]
	const drives = !info.council && info.clientPools > 0 && engine === "opencoti"
	const polykv = drives
		? toPolykvStatusProto(await readOpencotiStatus(xollamaEngineRoot(origin, model), xollamaEngineFetch(fetch)))
		: undefined
	return XollamaModelStatusResponse.create({
		reachable: true,
		council: info.council,
		clientPools: info.clientPools,
		...(engine !== undefined ? { engine } : {}),
		...(polykv ? { polykv } : {}),
	})
}

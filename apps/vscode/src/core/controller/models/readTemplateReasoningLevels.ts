import { readTemplateReasoningLevels as readLevels } from "@cline/llms"
import { StringRequest } from "@/shared/proto/cline/common"
import { TemplateReasoningLevels } from "@/shared/proto/cline/models"
import { type ProviderCatalogController, parseProviderIdRequest } from "./providerCatalogShared"

/**
 * The thinking levels the configured llama.cpp or opencoti server's chat
 * template states, for the Reasoning effort dropdown.
 *
 * The server hands a top-level `reasoning_effort` to the template, and a
 * template that checks it raises on any other value, failing the turn -- so
 * the dropdown offers only these. Read fresh on every ask: the template is the
 * loaded model's, and the server may have been restarted on another one.
 *
 * The base URL comes from the stored provider config, as with the other reads
 * here, so the webview cannot point it elsewhere.
 */
export async function readTemplateReasoningLevels(
	controller: ProviderCatalogController,
	request: StringRequest,
): Promise<TemplateReasoningLevels> {
	const providerId = parseProviderIdRequest(request.value, "value")
	const config = controller.getProviderConfigStore().read(providerId)
	const read = await readLevels(config.baseUrl)
	return TemplateReasoningLevels.create({
		reachable: read.reachable,
		hasTemplate: read.hasTemplate,
		levels: read.levels,
		defaultLevel: read.default,
	})
}

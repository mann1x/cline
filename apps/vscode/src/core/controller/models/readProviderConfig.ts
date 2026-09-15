import { StringRequest } from "@/shared/proto/cline/common"
import { ProviderConfigResponse } from "@/shared/proto/cline/models"
import { Logger } from "@/shared/services/Logger"
import { type ProviderCatalogController, parseProviderIdRequest, toRedactedProviderConfigResponse } from "./providerCatalogShared"

export async function readProviderConfig(
	controller: ProviderCatalogController,
	request: StringRequest,
): Promise<ProviderConfigResponse> {
	const providerId = parseProviderIdRequest(request.value, "value")
	const store = controller.getProviderConfigStore()
	const config = store.read(providerId)
	// The other half of the write line. Every write is logged with what it asked
	// for and what the store kept, and the store has kept every one of them --
	// so a cap that comes back changed is either being handed back differently
	// than it was stored, or the panel is reading a moment nobody recorded.
	// Reads are frequent, so this says the two numbers and nothing else.
	Logger.log(
		`[ProviderConfig] read provider=${providerId} contextWindow=${config.contextWindow ?? "none"} cap=${
			config.maxToolResultChars ?? "none"
		}`,
	)
	return toRedactedProviderConfigResponse(config, store)
}

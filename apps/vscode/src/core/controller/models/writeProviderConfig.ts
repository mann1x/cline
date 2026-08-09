import { ProviderConfigResponse, WriteProviderConfigRequest } from "@/shared/proto/cline/models"
import { Logger } from "@/shared/services/Logger"
import {
	type ProviderCatalogController,
	parseProviderIdRequest,
	toProviderConfigPatch,
	toRedactedProviderConfigResponse,
} from "./providerCatalogShared"

export async function writeProviderConfig(
	controller: ProviderCatalogController,
	request: WriteProviderConfigRequest,
): Promise<ProviderConfigResponse> {
	const providerId = parseProviderIdRequest(request.providerId)
	const store = controller.getProviderConfigStore()
	const updated = store.write(providerId, toProviderConfigPatch(request.patch))
	// Every round of the per-profile context window has come down to two facts
	// nobody was recording: which provider entry a write landed on, and what it
	// did to the window. Both, plus what the entry holds afterwards — and nothing
	// else. No key, no header, no transcript.
	const asked = request.patch?.contextWindow
	Logger.log(
		`[ProviderConfig] write provider=${providerId} contextWindow=${
			asked === undefined ? "unchanged" : asked > 0 ? String(asked) : "cleared"
		} stored=${updated.contextWindow ?? "none"}`,
	)
	return toRedactedProviderConfigResponse(updated, store)
}

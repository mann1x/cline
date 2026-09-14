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
	// Which fields the patch actually carried, by name only. "I change it and it
	// goes back" has two very different causes -- a patch that never carried the
	// field, and a store that dropped it -- and the old line, which named only
	// the context window, could not tell them apart: every cap edit logged
	// `contextWindow=unchanged` and looked identical to a no-op refresh.
	const patched = request.patch
		? Object.entries(request.patch)
				.filter(
					([, value]) =>
						value !== undefined && !(typeof value === "object" && value !== null && Object.keys(value).length === 0),
				)
				.map(([key]) => key)
				.join(",")
		: ""
	Logger.log(
		`[ProviderConfig] write provider=${providerId} contextWindow=${
			asked === undefined ? "unchanged" : asked > 0 ? String(asked) : "cleared"
		} stored=${updated.contextWindow ?? "none"} patched=[${patched}] capAsked=${
			request.patch?.maxToolResultChars ?? "unchanged"
		} capStored=${updated.maxToolResultChars ?? "none"}`,
	)
	return toRedactedProviderConfigResponse(updated, store)
}

import { listJevModels } from "@cline/core"
import { StringArray, StringRequest } from "@shared/proto/cline/common"
import { ensureBaseUrlScheme } from "@/sdk/cline-session-factory"
import { readJevApiKey, readJevCustomApiKey } from "@/sdk/jev-config"
import { Controller } from ".."

/**
 * The decision models a Jev endpoint serves, for the Jev tab's picker.
 *
 * The request carries the URL as typed, not as stored, so the list follows the
 * field while its save is still debouncing. Empty is TypeSafe with TypeSafe's
 * key; anything else is that server with the custom key, so the picker never
 * sends TypeSafe's key to a URL the user typed. Which server it is, and so how
 * its list reads, core finds out from the server.
 *
 * An empty list on failure, like every other picker here: the field still
 * takes a typed name.
 */
export async function getJevModels(_controller: Controller, request: StringRequest): Promise<StringArray> {
	try {
		const typed = request.value?.trim() ?? ""
		const baseUrl = typed ? ensureBaseUrlScheme(typed) : ""
		if (baseUrl && !URL.canParse(baseUrl)) {
			return StringArray.create({ values: [] })
		}
		const apiKey = baseUrl ? readJevCustomApiKey() : readJevApiKey()
		if (!baseUrl && !apiKey) {
			return StringArray.create({ values: [] })
		}
		const values = await listJevModels({ ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}) })
		return StringArray.create({ values })
	} catch (_error) {
		return StringArray.create({ values: [] })
	}
}

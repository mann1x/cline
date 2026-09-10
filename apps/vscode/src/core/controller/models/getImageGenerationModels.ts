import { normalizeBaseUrl, selectImageGenerationModels } from "@cline/core"
import { StringArray, StringRequest } from "@shared/proto/cline/common"
import axios from "axios"
import { ensureBaseUrlScheme } from "@/sdk/cline-session-factory"
import { readImageGenerationApiKey } from "@/sdk/image-generation-config"
import { getAxiosSettings } from "@/shared/net"
import { Controller } from ".."

/**
 * The image models an OpenAI-compatible endpoint serves.
 *
 * The key is read here rather than sent in the request, because the settings
 * view has never been told it: it lives in secret storage and the webview knows
 * only that one is set. So the picker can list a hosted endpoint's models
 * without the value ever making the round trip.
 *
 * An empty list on failure, like every other picker here: a dropdown that came
 * back empty is a prompt to type the model name, and the field accepts one.
 */
export async function getImageGenerationModels(_controller: Controller, request: StringRequest): Promise<StringArray> {
	try {
		const typed = request.value?.trim()
		if (!typed) {
			return StringArray.create({ values: [] })
		}
		// A base URL that lost its scheme still names one endpoint, and rejecting
		// it here leaves the picker empty with no explanation.
		// The same normalisation the tool applies, so the picker lists what the
		// tool will actually call: `/v1` appended when the user did not type it.
		const baseUrl = normalizeBaseUrl(ensureBaseUrlScheme(typed))
		if (!URL.canParse(baseUrl)) {
			return StringArray.create({ values: [] })
		}

		const apiKey = readImageGenerationApiKey()
		const response = await axios.get(`${baseUrl}/models`, {
			...getAxiosSettings(),
			...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
		})

		return StringArray.create({ values: selectImageGenerationModels(response.data) })
	} catch (_error) {
		return StringArray.create({ values: [] })
	}
}

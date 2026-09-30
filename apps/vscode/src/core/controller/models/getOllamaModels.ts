import { parseOllamaRecommendations, unpulledCloudModels } from "@cline/llms"
import { StringArray, StringRequest } from "@shared/proto/cline/common"
import axios from "axios"
import { ensureBaseUrlScheme } from "@/sdk/cline-session-factory"
import { getAxiosSettings } from "@/shared/net"
import { Controller } from ".."

/**
 * Fetches available models from Ollama
 * @param controller The controller instance
 * @param request The request containing the base URL (optional)
 * @returns Array of model names
 */
export async function getOllamaModels(_controller: Controller, request: StringRequest): Promise<StringArray> {
	try {
		// A base URL that lost its scheme still names one endpoint, and rejecting
		// it here left the model picker empty with no explanation while the same
		// value was busy failing every request with `Invalid URL`.
		const baseUrl = request.value ? ensureBaseUrlScheme(request.value.trim()) : "http://localhost:11434"

		if (!URL.canParse(baseUrl)) {
			return StringArray.create({ values: [] })
		}

		const response = await axios.get(`${baseUrl}/api/tags`, getAxiosSettings())
		const modelsArray = response.data?.models?.map((model: any) => model.name) || []
		const models = [...new Set<string>([...modelsArray, ...(await offeredCloudModels(baseUrl))])].sort()

		return StringArray.create({ values: models })
	} catch (_error) {
		return StringArray.create({ values: [] })
	}
}

/**
 * The cloud models the server offers without having pulled them, so the picker
 * can complete them: `glm-5.3-flash:cloud` runs on a signed-in server with no
 * pull, and was not in the list because `/api/tags` does not carry it
 * (`unpulledCloudModels`). Nothing when the server has no recommendations.
 */
async function offeredCloudModels(baseUrl: string): Promise<string[]> {
	try {
		const response = await axios.get(`${baseUrl}/api/experimental/model-recommendations`, getAxiosSettings())
		return unpulledCloudModels(parseOllamaRecommendations(response.data), []).map((entry) => entry.name)
	} catch {
		return []
	}
}

import { OllamaModelParameters, OllamaModelParametersRequest } from "@shared/proto/cline/models"
import { resolveOllamaModelParameters, resolveOllamaModelThinkingLevels } from "@/sdk/ollama-model-family"
import { Controller } from ".."

/**
 * Reads the parameters the selected model's Modelfile sets.
 *
 * The settings panel leaves sampling fields blank and sends nothing for them,
 * so the model's own values stand — which left the user with a field labelled
 * "model default" and no way to find out what that default was. This answers
 * that question for the model actually selected.
 *
 * It also carries the thinking levels the model states, for the Reasoning
 * Effort dropdown.
 *
 * Failure is reported as no parameters rather than as an error: this only feeds
 * placeholder text, and an Ollama that is not running should not put an error
 * in a settings panel the user may have opened for something else entirely.
 */
export async function getOllamaModelParameters(
	_controller: Controller,
	request: OllamaModelParametersRequest,
): Promise<OllamaModelParameters> {
	try {
		// One /api/show behind both: the resolvers share a per-model cache.
		const [parameters, thinking] = await Promise.all([
			resolveOllamaModelParameters(request.baseUrl, request.modelId ?? ""),
			resolveOllamaModelThinkingLevels(request.baseUrl, request.modelId ?? "").catch(() => ({ values: [] as string[] })),
		])
		return OllamaModelParameters.create({
			parameters,
			thinkingLevels: thinking.values,
			thinkingDefault: "default" in thinking ? thinking.default : undefined,
		})
	} catch {
		return OllamaModelParameters.create({ parameters: {} })
	}
}

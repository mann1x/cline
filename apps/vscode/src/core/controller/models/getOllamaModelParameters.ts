import { OllamaModelParameters, OllamaModelParametersRequest } from "@shared/proto/cline/models"
import { resolveOllamaModelParameters } from "@/sdk/ollama-model-family"
import { Controller } from ".."

/**
 * Reads the parameters the selected model's Modelfile sets.
 *
 * The settings panel leaves sampling fields blank and sends nothing for them,
 * so the model's own values stand — which left the user with a field labelled
 * "model default" and no way to find out what that default was. This answers
 * that question for the model actually selected.
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
		const parameters = await resolveOllamaModelParameters(request.baseUrl, request.modelId ?? "")
		return OllamaModelParameters.create({ parameters })
	} catch {
		return OllamaModelParameters.create({ parameters: {} })
	}
}

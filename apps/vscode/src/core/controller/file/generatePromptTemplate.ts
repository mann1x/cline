import { EmptyRequest } from "@shared/proto/cline/common"
import { GeneratedPromptTemplate } from "@shared/proto/cline/file"
import { resolveBaseUrl, resolveModelId } from "@/sdk/cline-session-factory"
import { resolveOllamaModelFamily } from "@/sdk/ollama-model-family"
import { generateTemplateForModel } from "@/sdk/prompt-template-generator"
import { Controller } from ".."

/**
 * Ask the selected model to write a prompt template for itself.
 *
 * Provider-agnostic: it goes through the configured API handler, so whichever
 * provider and model the user has selected is the one that answers. The family
 * lookup is the single Ollama-specific step and is skipped everywhere else — a
 * hosted model's id already says what it is.
 */
export async function generatePromptTemplate(controller: Controller, _request: EmptyRequest): Promise<GeneratedPromptTemplate> {
	const apiConfiguration = controller.stateManager.getApiConfiguration()
	if (!apiConfiguration) {
		throw new Error("No provider is configured.")
	}
	const mode = controller.stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"
	const providerId = (mode === "plan" ? apiConfiguration.planModeApiProvider : apiConfiguration.actModeApiProvider) ?? ""
	const modelId = resolveModelId(providerId, mode, apiConfiguration)
	if (!providerId || !modelId) {
		throw new Error("Select a provider and a model first.")
	}

	let family: string | undefined
	if (providerId === "ollama") {
		const baseUrl = resolveBaseUrl(providerId, apiConfiguration)
		family = baseUrl ? await resolveOllamaModelFamily(baseUrl, modelId).catch(() => undefined) : undefined
	}

	const generated = await generateTemplateForModel({
		providerId,
		modelId,
		mode,
		apiConfiguration,
		family,
	})

	return GeneratedPromptTemplate.create({
		filePath: generated.filePath,
		name: generated.name,
		attempts: generated.attempts,
		problems: generated.problems,
	})
}

import { resolveCompactionPromptSources } from "@cline/core"
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
		// An unset base URL is Ollama's default endpoint, which is where the
		// generated template's own session will be sent.
		const baseUrl = resolveBaseUrl(providerId, apiConfiguration)
		family = await resolveOllamaModelFamily(baseUrl, modelId).catch(() => undefined)
	}

	// Opt-in, off by default: a compaction prompt's answer replaces the
	// transcript, so a bad translation loses the session's history rather than
	// a turn. The sources are what this user's sessions send today -- their own
	// prompt where they wrote one, the built-in one otherwise.
	const settings = controller.stateManager
	const compactionPrompts = settings.getGlobalSettingsKey("translateCompactionPrompts")
		? resolveCompactionPromptSources({
				replay: settings.getGlobalSettingsKey("compactionPrompt"),
				full: settings.getGlobalSettingsKey("fullCompactionPrompt"),
				retrospective: settings.getGlobalSettingsKey("thinkingCompactionPrompt"),
				"council-writer": settings.getGlobalSettingsKey("councilWriterPrompt"),
				"council-critic": settings.getGlobalSettingsKey("councilCriticPrompt"),
				"council-synthesizer": settings.getGlobalSettingsKey("councilSynthesizerPrompt"),
			})
		: undefined

	const generated = await generateTemplateForModel({
		providerId,
		modelId,
		mode,
		apiConfiguration,
		family,
		...(compactionPrompts ? { compactionPrompts } : {}),
	})

	return GeneratedPromptTemplate.create({
		filePath: generated.filePath,
		name: generated.name,
		attempts: generated.attempts,
		problems: generated.problems,
		compactionKept: generated.compaction?.kept ?? [],
		compactionRemoved: generated.compaction?.removed ?? [],
		compactionUnchanged: generated.compaction?.unchanged ?? [],
	})
}

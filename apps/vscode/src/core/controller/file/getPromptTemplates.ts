import { EmptyRequest } from "@shared/proto/cline/common"
import { PromptTemplates } from "@shared/proto/cline/file"
import { resolveBaseUrl, resolveModelId } from "@/sdk/cline-session-factory"
import { readPromptTemplateSettings } from "@/sdk/prompt-template-settings"
import { getCwd, getDesktopDir } from "@/utils/path"
import { Controller } from ".."

/**
 * Lists the prompt templates the current provider and model can resolve to.
 *
 * Deliberately reads the same directories a session does rather than a cached
 * copy: a user who has just written a template expects to see it, and the
 * whole point of the panel is to answer "did that file take effect".
 */
export async function getPromptTemplates(controller: Controller, _request: EmptyRequest): Promise<PromptTemplates> {
	const apiConfiguration = controller.stateManager.getApiConfiguration()
	const mode = controller.stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"
	const providerId = (mode === "plan" ? apiConfiguration?.planModeApiProvider : apiConfiguration?.actModeApiProvider) ?? ""
	const modelId = apiConfiguration ? (resolveModelId(providerId, mode, apiConfiguration) ?? "") : ""

	const settings = await readPromptTemplateSettings({
		providerId,
		modelId,
		workspaceRoot: await getCwd(getDesktopDir()),
		baseUrl: apiConfiguration ? resolveBaseUrl(providerId, apiConfiguration) : undefined,
	})

	return PromptTemplates.create({
		providerId: settings.providerId,
		modelId: settings.modelId,
		family: settings.family,
		activeName: settings.activeName,
		overlaid: settings.overlaid,
		globalDirectory: settings.globalDirectory,
		workspaceDirectory: settings.workspaceDirectory,
		templates: settings.templates.map((template) => ({
			name: template.name,
			fileName: template.fileName,
			source: template.source,
			filePath: template.filePath,
			active: template.active,
			shadowed: template.shadowed,
			match: template.match,
			tools: template.tools,
			hasSystem: template.hasSystem,
			warnings: template.warnings,
			error: template.error,
		})),
	})
}

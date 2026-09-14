import { snapshotModelId, snapshotProviderId, snapshotProviderSettings } from "@shared/model-scope-config"
import { EmptyRequest } from "@shared/proto/cline/common"
import { PromptTemplates } from "@shared/proto/cline/file"
import { resolveBaseUrl, resolveModelId } from "@/sdk/cline-session-factory"
import { type PromptTemplateScopeRequest, readPromptTemplateSettings } from "@/sdk/prompt-template-settings"
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

	// The other models this task can run. Each is a tab with its own provider
	// and model, and each resolves its own template -- an expert of a different
	// family reading the chat model's template would be the same defect as
	// reading none, and neither is visible from here without this.
	//
	// Vision is deliberately absent: it answers questions about images and
	// never runs the agent loop, so no coding template applies to it.
	const otherMode = mode === "plan" ? "act" : "plan"
	const otherProviderId =
		(otherMode === "plan" ? apiConfiguration?.planModeApiProvider : apiConfiguration?.actModeApiProvider) ?? ""
	const otherModelId = apiConfiguration ? (resolveModelId(otherProviderId, otherMode, apiConfiguration) ?? "") : ""
	const scopes: PromptTemplateScopeRequest[] = [
		{
			scope: mode === "plan" ? "Plan" : "Act",
			providerId,
			modelId,
			baseUrl: apiConfiguration ? resolveBaseUrl(providerId, apiConfiguration) : undefined,
		},
	]
	// Only when the other mode is a different model. Two rows saying the same
	// thing is noise, and Plan and Act share a model far more often than not.
	if (otherProviderId && otherModelId && (otherProviderId !== providerId || otherModelId !== modelId)) {
		scopes.push({
			scope: otherMode === "plan" ? "Plan" : "Act",
			providerId: otherProviderId,
			modelId: otherModelId,
			baseUrl: apiConfiguration ? resolveBaseUrl(otherProviderId, apiConfiguration) : undefined,
		})
	}
	for (const [scope, key] of [
		["Agents & subagents", "agentsModeApiConfiguration"],
		["Escalation", "escalationModeApiConfiguration"],
	] as const) {
		const snapshot = controller.stateManager.getGlobalSettingsKey(key)
		const scopeProviderId = snapshotProviderId(snapshot)
		const scopeModelId = snapshotModelId(snapshot)
		if (!scopeProviderId || !scopeModelId) {
			continue
		}
		scopes.push({
			scope,
			providerId: scopeProviderId,
			modelId: scopeModelId,
			baseUrl: snapshotProviderSettings(snapshot)?.baseUrl as string | undefined,
		})
	}

	const settings = await readPromptTemplateSettings({
		providerId,
		modelId,
		workspaceRoot: await getCwd(getDesktopDir()),
		baseUrl: apiConfiguration ? resolveBaseUrl(providerId, apiConfiguration) : undefined,
		scopes,
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
		scopes: settings.scopes.map((scope) => ({
			scope: scope.scope,
			providerId: scope.providerId,
			modelId: scope.modelId,
			family: scope.family,
			templateName: scope.templateName,
			overlaid: scope.overlaid,
			fallback: scope.fallback,
		})),
	})
}

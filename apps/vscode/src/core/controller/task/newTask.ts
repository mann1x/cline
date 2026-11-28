import { String } from "@shared/proto/cline/common"
import { PlanActMode } from "@shared/proto/cline/state"
import { NewTaskRequest } from "@shared/proto/cline/task"
import { Settings } from "@shared/storage/state-keys"
import { convertProtoToApiProvider } from "@/shared/proto-conversions/models/api-configuration-conversion"
import { parseStartSkills, withStartSkills } from "@/shared/start-skills"
import { DEFAULT_BROWSER_SETTINGS } from "../../../shared/BrowserSettings"
import { Controller } from ".."
import { normalizeOpenaiReasoningEffort } from "../state/reasoningEffort"

/**
 * Creates a new task with the given text and optional images
 * @param controller The controller instance
 * @param request The new task request containing text and optional images, and optional task settings
 * @returns Empty response
 */
export async function newTask(controller: Controller, request: NewTaskRequest): Promise<String> {
	const convertPlanActMode = (mode: PlanActMode): string => {
		return mode === PlanActMode.PLAN ? "plan" : "act"
	}

	const filteredTaskSettings: Partial<Settings> = Object.fromEntries(
		Object.entries({
			...request.taskSettings,
			...(request.taskSettings?.autoApprovalSettings && {
				autoApprovalSettings: (() => {
					// Merge with global settings to ensure complete settings for new task
					const globalSettings = controller.stateManager.getGlobalSettingsKey("autoApprovalSettings")
					const incomingSettings = request.taskSettings.autoApprovalSettings
					return {
						...globalSettings,
						...(incomingSettings.version !== undefined && { version: incomingSettings.version }),
						...(incomingSettings.enableNotifications !== undefined && {
							enableNotifications: incomingSettings.enableNotifications,
						}),
						actions: {
							...globalSettings.actions,
							...(incomingSettings.actions
								? Object.fromEntries(Object.entries(incomingSettings.actions).filter(([_, v]) => v !== undefined))
								: {}),
						},
					}
				})(),
			}),
			...(request.taskSettings?.browserSettings && {
				browserSettings: {
					viewport: request.taskSettings.browserSettings.viewport || DEFAULT_BROWSER_SETTINGS.viewport,
					remoteBrowserHost: request.taskSettings.browserSettings.remoteBrowserHost,
					remoteBrowserEnabled: request.taskSettings.browserSettings.remoteBrowserEnabled,
					chromeExecutablePath: request.taskSettings.browserSettings.chromeExecutablePath,
					disableToolUse: request.taskSettings.browserSettings.disableToolUse,
					customArgs: request.taskSettings.browserSettings.customArgs,
				},
			}),
			...(request.taskSettings?.planModeReasoningEffort !== undefined && {
				planModeReasoningEffort: normalizeOpenaiReasoningEffort(request.taskSettings.planModeReasoningEffort),
			}),
			...(request.taskSettings?.actModeReasoningEffort !== undefined && {
				actModeReasoningEffort: normalizeOpenaiReasoningEffort(request.taskSettings.actModeReasoningEffort),
			}),
			...(request.taskSettings?.mode !== undefined && {
				mode: convertPlanActMode(request.taskSettings.mode),
			}),
			...(request.taskSettings?.planModeApiProvider !== undefined && {
				planModeApiProvider: convertProtoToApiProvider(request.taskSettings.planModeApiProvider),
			}),
			...(request.taskSettings?.actModeApiProvider !== undefined && {
				actModeApiProvider: convertProtoToApiProvider(request.taskSettings.actModeApiProvider),
			}),
		}).filter(([_, value]) => value !== undefined),
	)

	// Skills switched on to start every new conversation go in front of the
	// first message, as if typed (Skills tab, the play button on a skill).
	const startSkills = parseStartSkills(controller.stateManager.getGlobalSettingsKey("startSkills"))
	const text = startSkills.length > 0 ? withStartSkills(request.text ?? "", startSkills) : request.text
	const taskId = await controller.initTask(text, request.images, request.files, undefined, filteredTaskSettings)
	return String.create({ value: taskId || "" })
}

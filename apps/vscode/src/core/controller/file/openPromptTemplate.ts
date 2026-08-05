import { Empty } from "@shared/proto/cline/common"
import { PromptTemplateEditRequest } from "@shared/proto/cline/file"
import { resolvePromptTemplateEditPath } from "@/sdk/prompt-template-settings"
import { Controller } from ".."
import { openFile } from "./openFile"

/**
 * Opens a prompt template for editing.
 *
 * A builtin has no file, so "edit" means copying it into the global template
 * directory first — which is also how a user overrides one, since the copy
 * shadows the builtin by name.
 */
export async function openPromptTemplate(controller: Controller, request: PromptTemplateEditRequest): Promise<Empty> {
	if (!request.fileName) {
		throw new Error("Missing file name")
	}
	const filePath = await resolvePromptTemplateEditPath(request.fileName, request.filePath)
	return await openFile(controller, { value: filePath })
}

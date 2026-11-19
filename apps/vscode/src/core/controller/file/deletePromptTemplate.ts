import { Empty } from "@shared/proto/cline/common"
import { PromptTemplateEditRequest } from "@shared/proto/cline/file"
import { deletePromptTemplateFile } from "@/sdk/prompt-template-settings"
import { getCwd, getDesktopDir } from "@/utils/path"
import { Controller } from ".."

/**
 * Deletes one of the user's prompt templates.
 *
 * The panel asks for a yes before it calls this. The path is checked again
 * here against the global and workspace template directories, since it comes
 * from the webview; a builtin has no path and is refused.
 */
export async function deletePromptTemplate(_controller: Controller, request: PromptTemplateEditRequest): Promise<Empty> {
	await deletePromptTemplateFile(request.filePath, await getCwd(getDesktopDir()))
	return Empty.create({})
}

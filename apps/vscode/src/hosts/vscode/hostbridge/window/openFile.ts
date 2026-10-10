import * as vscode from "vscode"
import { editorColumnOutsideUndockedChat } from "@/hosts/vscode/undocked-chat"
import { OpenFileRequest, OpenFileResponse } from "@/shared/proto/host/window"

export async function openFile(request: OpenFileRequest): Promise<OpenFileResponse> {
	const viewColumn = editorColumnOutsideUndockedChat()
	await vscode.commands.executeCommand(
		"vscode.open",
		vscode.Uri.file(request.filePath),
		...(viewColumn !== undefined ? [{ viewColumn }] : []),
	)
	return OpenFileResponse.create({})
}

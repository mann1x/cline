import { approvePipeline, listPipelines, PIPELINES_DIR, type PipelineFile } from "@cline/core"
import * as vscode from "vscode"

/**
 * The person's half of a pipeline's life: the model writes a file under
 * `.cerebriline/pipelines/` and may not run it until the version on disk is
 * approved here. Approval is never a tool — a model that could approve its
 * own pipeline would make the step meaningless — so it lives in the command
 * palette (and `/pipelines approve` in the CLI).
 */
export function describePipeline(file: PipelineFile): string {
	if (!file.valid) {
		return `does not validate: ${file.errors[0] ?? "unknown problem"}`
	}
	if (file.isApproved) {
		return `approved (version ${file.hash})`
	}
	return file.approved ? `changed since approval: version ${file.hash}` : `not approved: version ${file.hash}`
}

export async function approvePipelineCommand(): Promise<void> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	if (!root) {
		void vscode.window.showWarningMessage("Open a folder first: pipelines live in the workspace.")
		return
	}
	const files = listPipelines(root)
	if (files.length === 0) {
		void vscode.window.showInformationMessage(`No pipelines in ${PIPELINES_DIR} yet.`)
		return
	}
	const picked = await vscode.window.showQuickPick(
		files.map((file) => ({
			label: file.name,
			description: describePipeline(file),
			detail: file.definition?.description,
			file,
		})),
		{ placeHolder: "Approve which pipeline's current version?", matchOnDescription: true },
	)
	if (!picked) {
		return
	}
	const { file } = picked
	if (!file.valid) {
		void vscode.window.showErrorMessage(`${file.name} does not validate: ${file.errors.join("; ")}`)
		return
	}
	if (file.isApproved) {
		void vscode.window.showInformationMessage(`${file.name} is already approved at version ${file.hash}.`)
		return
	}
	// Show what is being approved: the version is a hash, and the file is what
	// it stands for.
	await vscode.window.showTextDocument(vscode.Uri.file(file.path), { preview: true })
	const answer = await vscode.window.showWarningMessage(
		`Approve ${file.name} (version ${file.hash})? It can then run its commands and tools in the background.`,
		{ modal: true },
		"Approve",
	)
	if (answer !== "Approve") {
		return
	}
	try {
		const approved = approvePipeline(root, file.slug)
		void vscode.window.showInformationMessage(`Approved ${approved.name} at version ${approved.hash}.`)
	} catch (error) {
		void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
	}
}

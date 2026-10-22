import * as vscode from "vscode"
import { SelectedResources, ShowOpenDialogueRequest } from "@/shared/proto/host/window"

export async function showOpenDialogue(request: ShowOpenDialogueRequest): Promise<SelectedResources> {
	const options: vscode.OpenDialogOptions = {}

	if (request.canSelectMany !== undefined) {
		options.canSelectMany = request.canSelectMany
	}

	if (request.openLabel !== undefined) {
		options.openLabel = request.openLabel
	}

	const named = Object.entries(request.namedFilters ?? {}).filter(([, list]) => list.extensions.length > 0)
	if (named.length > 0) {
		options.filters = Object.fromEntries(named.map(([name, list]) => [name, list.extensions]))
	} else if (request.filters?.files) {
		options.filters = {
			Files: request.filters.files,
		}
	}

	const selectedResources = await vscode.window.showOpenDialog(options)

	// Convert back to path format
	return SelectedResources.create({
		paths: selectedResources ? selectedResources.map((uri) => uri.fsPath) : [],
	})
}

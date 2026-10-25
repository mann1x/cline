import * as vscode from "vscode"
import { GetWorkspacePathsRequest, GetWorkspacePathsResponse } from "@/shared/proto/index.host"
export async function getWorkspacePaths(_: GetWorkspacePathsRequest): Promise<GetWorkspacePathsResponse> {
	// Only folders on this machine's disk. An SSH FS folder (ssh://cfg/home/u/p)
	// has an fsPath too -- /home/u/p, C:\home\u\p on Windows -- naming a local
	// directory that is not the folder: the tools would act on it, or on
	// whatever happens to be there.
	const paths = vscode.workspace.workspaceFolders?.filter(isLocalFolder).map((folder) => folder.uri.fsPath) ?? []
	return GetWorkspacePathsResponse.create({ paths: paths })
}

/** A workspace folder Node's `fs` can reach: one on the `file` scheme. */
export function isLocalFolder(folder: vscode.WorkspaceFolder): boolean {
	return folder.uri.scheme === "file"
}

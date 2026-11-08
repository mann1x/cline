import { type DirectoryEntry, namedExcludedDirectories, normalizeGlob, type WorkspaceLister } from "@cline/core"
import * as vscode from "vscode"
import { isLocalFolder } from "./hostbridge/workspace/getWorkspacePaths"

/**
 * The VS Code half of `list_files`.
 *
 * Every call goes through an API that is already workspace-scoped, which is
 * the point of routing this through the editor rather than a shell.
 * `findFiles` searches the opened folders and nothing else, and passing
 * `undefined` as its exclude argument makes it apply the user's own
 * `files.exclude` and `search.exclude` — so `node_modules`, `.git` and build
 * output are filtered by the same settings that filter the editor's own
 * quick-open, without this file having to guess at a list.
 */

export function createVscodeWorkspaceLister(): WorkspaceLister {
	return {
		roots(): string[] {
			return (vscode.workspace.workspaceFolders ?? []).filter(isLocalFolder).map((folder) => folder.uri.fsPath)
		},

		async readDirectory(absolutePath: string): Promise<DirectoryEntry[]> {
			const uri = vscode.Uri.file(absolutePath)
			const entries = await vscode.workspace.fs.readDirectory(uri)

			return Promise.all(
				entries.map(async ([name, type]): Promise<DirectoryEntry> => {
					// A bitmask: a link to a directory is Directory | SymbolicLink,
					// which an equality test listed as a file (automaticum audit
					// 2026-11-08, readers 28).
					const kind = type & vscode.FileType.Directory ? "directory" : "file"
					const link = type & vscode.FileType.SymbolicLink ? { link: "(symbolic link)" } : {}
					if (kind === "directory") {
						return { name, kind, ...link }
					}
					// A size the model can use to decide whether reading the file
					// whole is reasonable. Cheap, but not worth failing the whole
					// listing over if one entry cannot be stat'd.
					try {
						const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(uri, name))
						return { name, kind, size: stat.size, ...link }
					} catch {
						return { name, kind, ...link }
					}
				}),
			)
		},

		async findFiles(pattern: string, maxResults: number): Promise<string[]> {
			// A pattern that names node_modules or .git asks for it: the user's
			// excludes would answer "no match" for files that exist (readers 11).
			const exclude = namedExcludedDirectories(pattern).size > 0 ? null : undefined
			const matches = await vscode.workspace.findFiles(normalizeGlob(pattern), exclude, maxResults)
			return matches.map((uri) => uri.fsPath)
		},
	}
}

import { execa } from "@packages/execa"
import { existsSync } from "fs"
import os from "os"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"

export async function getDocumentsPath(): Promise<string> {
	if (process.platform === "win32") {
		try {
			const { stdout: docsPath } = await execa("powershell", [
				"-NoProfile", // Ignore user's PowerShell profile(s)
				"-Command",
				"[System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::MyDocuments)",
			])
			const trimmedPath = docsPath.trim()
			if (trimmedPath) {
				return trimmedPath
			}
		} catch (_err) {
			Logger.error("Failed to retrieve Windows Documents path. Falling back to homedir/Documents.")
		}
	} else if (process.platform === "linux") {
		try {
			// First check if xdg-user-dir exists
			await execa("which", ["xdg-user-dir"])

			// If it exists, try to get XDG documents path
			const { stdout } = await execa("xdg-user-dir", ["DOCUMENTS"])
			const trimmedPath = stdout.trim()
			if (trimmedPath) {
				return trimmedPath
			}
		} catch {
			// Log error but continue to fallback
			Logger.error("Failed to retrieve XDG Documents path. Falling back to homedir/Documents.")
		}
	}

	// Default fallback for all platforms
	return path.join(os.homedir(), "Documents")
}

/** The folder this extension keeps user-authored material in, under Documents. */
const DOCUMENTS_DIR_NAME = "Cerebriline"
/** What it was called before the rename. */
const LEGACY_DOCUMENTS_DIR_NAME = "Cline"

/**
 * The extension's folder inside a Documents directory.
 *
 * Every caller must go through this. There is no error when two of them
 * disagree -- the rules a user wrote are simply not found, and the agent runs
 * without them -- so the folder name is named once and read from here.
 *
 * An install that predates the rename keeps its old folder: the user's own
 * rules, workflows and hooks are in it, and `tools/Migrate-ToCerebriline.ps1`
 * moves them across when they are ready. Mirrors the same fallback in
 * `resolveDocumentsClineDirectoryPath` in @cline/shared, which resolves
 * Documents differently (it does not consult XDG or the Windows shell) and so
 * cannot simply be called here.
 */
export function documentsExtensionDir(documentsRoot: string): string {
	const current = path.join(documentsRoot, DOCUMENTS_DIR_NAME)
	if (existsSync(current)) {
		return current
	}
	const legacy = path.join(documentsRoot, LEGACY_DOCUMENTS_DIR_NAME)
	return existsSync(legacy) ? legacy : current
}

/** The extension's Documents folder, resolving Documents properly. */
export async function getDocumentsExtensionPath(...segments: string[]): Promise<string> {
	return path.join(documentsExtensionDir(await getDocumentsPath()), ...segments)
}

/** The same, from the home directory alone -- for fallbacks where the proper lookup failed. */
export function getHomeDocumentsExtensionPath(...segments: string[]): string {
	return path.join(documentsExtensionDir(path.join(os.homedir(), "Documents")), ...segments)
}

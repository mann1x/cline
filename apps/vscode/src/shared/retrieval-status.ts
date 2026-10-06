/**
 * What the Library and Memory panels are told about the engine under them,
 * and what they can ask of it. Types only, shared by the host that answers
 * and the panels that ask, so the two cannot disagree about a field.
 */

export interface RetrievalLanceDbStatus {
	/** The version this build installs. */
	version: string
	platform: string
	installed: boolean
	/** Installed, and the native library loaded in the extension host. */
	working: boolean
	error?: string
	/** Why it cannot run on this machine at all. */
	unsupported?: string
	installBytes?: number
	root: string
	installing: boolean
	progress?: { packageIndex: number; packageCount: number }
	lastInstallError?: string
}

export interface RetrievalMemoryInfo {
	name: string
	main: boolean
	notes: number
	/** The key of the workspace it was made for (see `memoryWorkspaceKey`). */
	workspace?: string
	createdAt: string
}

export interface RetrievalStatus {
	lancedb: RetrievalLanceDbStatus
	/** The embedding model in use, when one is configured. */
	embeddingModel?: string
	library: { enabled: boolean; collections: number; documents: number; passages: number; embeddedDocuments: number }
	memory: { enabled: boolean; memories: RetrievalMemoryInfo[]; notes: number; embeddedNotes: number }
	/** The workspace the panel is open in. */
	workspace: { path: string; key: string; name: string }
}

export interface RetrievalActionResult {
	ok: boolean
	/** What happened, for the panel to show. */
	message?: string
	error?: string
	status: RetrievalStatus
}

export type RetrievalAction =
	| { action: "status" }
	| { action: "installVectors" }
	| { action: "createMemory"; name: string; forWorkspace?: boolean }
	| { action: "deleteMemory"; name: string }
	| { action: "exportMemory"; name: string }
	| { action: "importMemory"; into?: string }

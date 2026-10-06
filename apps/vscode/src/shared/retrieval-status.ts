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

/** The embedding endpoint as the Embedding tab has it, and what stops it when something does. */
export interface RetrievalEmbeddingState {
	/** “Use an embedding model” is ticked. */
	enabled: boolean
	useProvider: boolean
	model: string
	/** The address requests go to, once one can be worked out. */
	baseUrl?: string
	/** Where that address is from. */
	source?: "provider" | "typed"
	providerId?: string
	/** The one thing that stops embedding, in words. Absent when nothing does. */
	problem?: string
}

/** The models a server has that can embed, or all of its models when it cannot say. */
export interface RetrievalEmbeddingModels {
	kind: "ollama" | "openai" | "unknown"
	/** True when the list holds embedding models only. */
	filtered: boolean
	models: string[]
	baseUrl?: string
	error?: string
}

/** One real request to an endpoint, and what came of it. */
export interface RetrievalEndpointCheck {
	ok: boolean
	detail: string
}

export interface RetrievalStatus {
	lancedb: RetrievalLanceDbStatus
	/** The embedding model in use, when one is configured. */
	embeddingModel?: string
	embedding: RetrievalEmbeddingState
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
	/** What an asking action answered with: a model list, or a check's result. */
	models?: RetrievalEmbeddingModels
	check?: RetrievalEndpointCheck
	status: RetrievalStatus
}

export type RetrievalAction =
	| { action: "status" }
	| { action: "installVectors" }
	| { action: "embeddingModels" }
	| { action: "checkEmbedding" }
	| { action: "checkReranking" }
	| { action: "createMemory"; name: string; forWorkspace?: boolean }
	| { action: "renameMemory"; name: string; to: string }
	| { action: "deleteMemory"; name: string }
	| { action: "exportMemory"; name: string }
	| { action: "importMemory"; into?: string }

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

/** One set of vectors on disk: an embedding model at one vector size. */
export interface RetrievalVectorSet {
	table: string
	model: string
	dimension: number
	vectors: number
	documents: number
	bytes: number
	/** The set the embedding model now set writes to and searches. */
	current: boolean
}

/** A run that gives vectors to what has none, started from a panel. */
export interface RetrievalEmbedJob {
	target: "library" | "memory"
	running: boolean
	done: number
	total: number
	/** How the last run ended, when it has. */
	result?: string
	error?: string
}

export interface RetrievalStatus {
	lancedb: RetrievalLanceDbStatus
	/** The embedding model in use, when one is configured. */
	embeddingModel?: string
	embedding: RetrievalEmbeddingState
	library: {
		enabled: boolean
		collections: number
		documents: number
		passages: number
		embeddedDocuments: number
		vectorSets: RetrievalVectorSet[]
	}
	memory: {
		enabled: boolean
		memories: RetrievalMemoryInfo[]
		notes: number
		embeddedNotes: number
		vectorSets: RetrievalVectorSet[]
	}
	/** The embedding runs started from the panels, one per store. */
	embedJobs: { library?: RetrievalEmbedJob; memory?: RetrievalEmbedJob }
	/** The workspace the panel is open in. */
	workspace: { path: string; key: string; name: string }
	/** The Library's sections and shelves. */
	catalogue: LibraryCatalogueView
	scrape: ScrapeState
}

/** Whether a model reads images: what its server says, or that it does not say. */
export type ImageSupport = "yes" | "no" | "unknown"

export interface ImageModelChoice {
	provider: string
	model: string
	images: ImageSupport
}

/** What each place a picture-describing model can be named would run. */
export interface RetrievalImageSupport {
	/** The Vision tab's model, when the tab names one. */
	visionTab?: ImageModelChoice
	/** Every saved profile, in the order they are stored. */
	profiles: Array<ImageModelChoice & { name: string }>
}

/** One server's models, split by what it reports about each. */
export interface RetrievalImageModels {
	/** False when the server does not say; nothing may be hidden then. */
	reported: boolean
	vision: string[]
	notVision: string[]
}

export interface RetrievalActionResult {
	ok: boolean
	/** What happened, for the panel to show. */
	message?: string
	error?: string
	/** What an asking action answered with: a model list, or a check's result. */
	models?: RetrievalEmbeddingModels
	check?: RetrievalEndpointCheck
	imageSupport?: RetrievalImageSupport
	imageModels?: RetrievalImageModels
	/** What a listing action answered with. */
	books?: LibraryBookView[]
	book?: LibraryBookDetails
	status: RetrievalStatus
}

export type RetrievalAction =
	| { action: "status" }
	| { action: "installVectors" }
	| { action: "embeddingModels" }
	| { action: "checkEmbedding" }
	| { action: "checkReranking" }
	| { action: "imageSupport" }
	| { action: "imageModels"; providerId: string; baseUrl?: string }
	| { action: "embedNow"; target: "library" | "memory" }
	| { action: "deleteVectors"; target: "library" | "memory"; table: string }
	| { action: "createMemory"; name: string; forWorkspace?: boolean }
	| { action: "renameMemory"; name: string; to: string }
	| { action: "deleteMemory"; name: string }
	| { action: "exportMemory"; name: string }
	| { action: "importMemory"; into?: string }
	| LibraryAction

// ---- the Library's shelves, for the panel that browses them ----

export interface LibraryShelfView {
	id: number
	sectionId: number
	name: string
	description: string
	books: number
	passages: number
}

export interface LibrarySectionView {
	id: number
	name: string
	description: string
	shelves: LibraryShelfView[]
}

export interface LibraryBookView {
	id: number
	title: string
	description: string
	shelfId?: number
	authors?: string[]
	edition?: string
	year?: number
	sources: number
	passages: number
	/** Made from web pages. */
	web: boolean
	updatedAt: string
	trashedAt?: string
	/** Where a trashed book stood, as "Section / Shelf". */
	trashedFrom?: string
	/** The day the trash lets go of it. */
	purgedOn?: string
}

export interface LibrarySourceView {
	id: number
	kind: "file" | "web" | "text"
	name: string
	url?: string
	bytes: number
	addedAt: string
	removedAt?: string
}

export interface LibraryBookDetails extends LibraryBookView {
	/** The book's folder on disk. */
	directory: string
	metadata: Record<string, unknown>
	sourceList: LibrarySourceView[]
	pictures: number
	describedPictures: number
}

export interface LibraryCatalogueView {
	sections: LibrarySectionView[]
	books: number
	trash: number
	problems: string[]
	/** The librarian skill is on, so the model can add to and reorganise the Library. */
	librarian: boolean
	trashDays: number
}

/** The scraping endpoint as it is set up, and what stops it when something does. */
export interface ScrapeState {
	enabled: boolean
	/** The tick in the API configuration. */
	allowed: boolean
	baseUrl: string
	maxPages: number
	maxDepth: number
	keySet: boolean
	problem?: string
}

export type LibraryAction =
	| { action: "libraryBooks"; shelfId: number }
	| { action: "libraryTrash" }
	| { action: "libraryBook"; bookId: number }
	| { action: "librarySection"; op: "create" | "update" | "delete"; id?: number; name?: string; description?: string }
	| {
			action: "libraryShelf"
			op: "create" | "update" | "delete"
			id?: number
			sectionId?: number
			name?: string
			description?: string
	  }
	| { action: "libraryBookEdit"; bookId: number; title?: string; description?: string; shelfId?: number }
	| { action: "libraryBookDelete"; bookId: number }
	| { action: "libraryBookRestore"; bookId: number }
	| { action: "libraryBookPurge"; bookId: number }
	| { action: "libraryEmptyTrash" }
	/** Cancels the librarian calls that are reading files; each fails with its report. */
	| { action: "libraryCancelImport" }
	| { action: "librarySource"; op: "remove" | "restore"; sourceId: number }
	| { action: "libraryExport"; sectionId?: number; shelfId?: number; bookId?: number }
	| { action: "libraryImport"; existing?: "skip" | "replace" | "copy" }
	| { action: "setLibrarian"; enabled: boolean }
	| {
			action: "setScrape"
			enabled?: boolean
			allowed?: boolean
			baseUrl?: string
			maxPages?: number
			maxDepth?: number
			apiKey?: string
	  }
	| { action: "checkScrape" }

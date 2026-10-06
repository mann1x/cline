import { readFile, writeFile } from "node:fs/promises"
import { basename } from "node:path"
import { lanceDbStatus, memoryWorkspaceKey, resolveLanceDbRuntimeDirectory, sharedLibrary, sharedMemory } from "@cline/core"
import type { RetrievalAction, RetrievalActionResult, RetrievalEmbedJob, RetrievalStatus } from "@shared/retrieval-status"
import { Logger } from "@shared/services/Logger"
import { getCwd } from "@utils/path"
import { HostProvider } from "@/hosts/host-provider"
import {
	checkEmbeddingEndpoint,
	checkRerankingEndpoint,
	describeEmbeddingEndpoint,
	listConfiguredEmbeddingModels,
} from "./embedding-endpoint"
import { listImageModels, readImageSupport } from "./image-support"
import { readLibraryCatalogue, readScrapeState, runLibraryAction } from "./library-catalogue"
import {
	installLibraryVectors,
	libraryVectorsInstallState,
	readEmbeddingEndpoint,
	readLibrarySettings,
	readMemorySettings,
} from "./library-config"

/**
 * What the Library and Memory panels show about the engine under them, and
 * the things they do that a setting cannot: download LanceDB, make and
 * delete a memory, write one to a file and read one back.
 *
 * One call with an `action`, answered with the status after it, so a panel
 * never shows a state older than the thing it just did.
 */

const embedJobs: { library?: RetrievalEmbedJob; memory?: RetrievalEmbedJob } = {}

/**
 * Give vectors to everything in a store that has none for the embedding
 * model now set. Started from a panel and followed through the status: for
 * a library of books it runs for a long while, and it is the user who
 * decides when, not a task that happens to add a document.
 */
function startEmbedding(target: "library" | "memory"): string | undefined {
	if (embedJobs[target]?.running) {
		return undefined
	}
	const embedding = readEmbeddingEndpoint()
	if (!embedding) {
		throw new Error(describeEmbeddingEndpoint().problem ?? "No embedding model is set.")
	}
	const job: RetrievalEmbedJob = { target, running: true, done: 0, total: 0 }
	embedJobs[target] = job
	const run =
		target === "library"
			? sharedLibrary().embedPending({
					embedding,
					settings: readLibrarySettings(),
					probe: true,
					onProgress: (progress) => {
						job.done = progress.documentIndex + 1
						job.total = progress.documentCount
					},
				})
			: sharedMemory().embedPending({
					embedding,
					probe: true,
					onProgress: (progress) => {
						job.done = progress.done
						job.total = progress.total
					},
				})
	const what = target === "library" ? "document" : "note"
	void run
		.then((result) => {
			job.result = result.skipped
				? `Nothing was embedded: ${result.skipped}`
				: result.documents === 0
					? `Every ${what} already has vectors for ${embedding.model}.`
					: `Embedded ${result.documents} ${what}${result.documents === 1 ? "" : "s"} with ${embedding.model}.`
		})
		.catch((error) => {
			job.error = `Embedding stopped after ${job.done} ${what}${job.done === 1 ? "" : "s"}: ${error instanceof Error ? error.message : String(error)}. What was done is kept; run it again to carry on.`
			Logger.warn(`[Library] ${job.error}`)
		})
		.finally(() => {
			job.running = false
		})
	return undefined
}

export async function readRetrievalStatus(): Promise<RetrievalStatus> {
	const path = await getCwd()
	const embedding = readEmbeddingEndpoint()
	const install = libraryVectorsInstallState()
	const libraryCounts = sharedLibrary().store.counts(embedding?.model)
	const memory = sharedMemory()
	const memoryCounts = memory.counts(embedding?.model)
	// Opening LanceDB is what listing its sets takes; where it does not load,
	// there are none to list and the box above says why.
	const [libraryVectorSets, memoryVectorSets] = await Promise.all([
		sharedLibrary()
			.vectorSets(embedding?.model)
			.catch(() => []),
		memory.vectorSets(embedding?.model).catch(() => []),
	])
	return {
		lancedb: {
			...lanceDbStatus({ directory: resolveLanceDbRuntimeDirectory() }),
			installing: install.installing,
			...(install.progress ? { progress: install.progress } : {}),
			...(install.lastError ? { lastInstallError: install.lastError } : {}),
		},
		...(embedding ? { embeddingModel: embedding.model } : {}),
		embedding: describeEmbeddingEndpoint(),
		library: {
			enabled: readLibrarySettings().enabled,
			collections: libraryCounts.collections,
			documents: libraryCounts.documents,
			passages: libraryCounts.chunks,
			embeddedDocuments: libraryCounts.embeddedDocuments,
			vectorSets: libraryVectorSets,
		},
		memory: {
			enabled: readMemorySettings().enabled,
			memories: memory.listMemories(),
			notes: memoryCounts.notes,
			embeddedNotes: memoryCounts.embeddedNotes,
			vectorSets: memoryVectorSets,
		},
		embedJobs: { ...embedJobs },
		catalogue: await readLibraryCatalogue(),
		scrape: readScrapeState(),
		// The folder's name from either kind of separator: the host's own basename knows only its own.
		workspace: {
			path,
			key: memoryWorkspaceKey(path),
			name:
				path
					.replace(/[\\/]+$/, "")
					.split(/[\\/]/)
					.pop() ?? "",
		},
	}
}

const fileName = (name: string) => `${name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "memory"}.memory.json`

type Outcome = Pick<RetrievalActionResult, "models" | "check" | "books" | "book" | "imageSupport" | "imageModels">

async function act(request: RetrievalAction, outcome: Outcome): Promise<string | undefined> {
	const memory = sharedMemory()
	switch (request.action) {
		case "status":
			return undefined
		case "embeddingModels":
			outcome.models = await listConfiguredEmbeddingModels()
			return undefined
		case "imageSupport":
			outcome.imageSupport = await readImageSupport()
			return undefined
		case "imageModels":
			outcome.imageModels = await listImageModels(request.providerId, request.baseUrl)
			return undefined
		case "checkEmbedding":
			outcome.check = await checkEmbeddingEndpoint()
			return undefined
		case "embedNow":
			return startEmbedding(request.target)
		case "deleteVectors": {
			const store = request.target === "library" ? sharedLibrary() : memory
			if (!(await store.deleteVectorSet(request.table))) {
				throw new Error("There is no such set of vectors.")
			}
			return "Deleted that set of vectors. Its documents are embedded again if its model is set again."
		}
		case "checkReranking":
			outcome.check = await checkRerankingEndpoint()
			return undefined
		case "installVectors":
			// Not awaited: it is a download of hundreds of megabytes, and the
			// panel follows it through the status.
			void installLibraryVectors()
			return undefined
		case "createMemory": {
			const workspace = request.forWorkspace ? await getCwd() : undefined
			const made = memory.createMemory({ name: request.name, ...(workspace ? { workspace } : {}) })
			return `Made the memory "${made.name}".`
		}
		case "renameMemory": {
			const renamed = memory.renameMemory(request.name, request.to)
			return renamed.name === request.name ? undefined : `Renamed "${request.name}" to "${renamed.name}".`
		}
		case "deleteMemory": {
			const notes = await memory.deleteMemory(request.name)
			return `Deleted the memory "${request.name}" and its ${notes} note${notes === 1 ? "" : "s"}.`
		}
		case "exportMemory": {
			const data = memory.exportMemory(request.name)
			const chosen = await HostProvider.window.showSaveDialog({
				options: { defaultPath: fileName(request.name), filters: { "Cerebriline memory": { extensions: ["json"] } } },
			})
			if (!chosen.selectedPath) {
				return undefined
			}
			await writeFile(chosen.selectedPath, `${JSON.stringify(data, null, 2)}\n`, "utf8")
			return `Wrote ${data.notes.length} note${data.notes.length === 1 ? "" : "s"} of "${request.name}" to ${chosen.selectedPath}.`
		}
		case "importMemory": {
			const chosen = await HostProvider.window.showOpenDialogue({
				canSelectMany: false,
				openLabel: "Import memory",
				filters: { files: ["json"] },
			})
			const path = chosen.paths[0]
			if (!path) {
				return undefined
			}
			let data: unknown
			try {
				data = JSON.parse(await readFile(path, "utf8"))
			} catch {
				throw new Error(`${basename(path)} is not a JSON file.`)
			}
			const embedding = readEmbeddingEndpoint()
			const result = await memory.importMemory(data, {
				...(request.into ? { into: request.into } : {}),
				...(embedding ? { endpoints: { embedding } } : {}),
			})
			return `Read ${basename(path)} into "${result.memory}"${result.created ? ", a new memory" : ""}: ${result.added} added, ${result.unchanged} already there${result.skipped ? `, ${result.skipped} skipped (empty or too long)` : ""}.`
		}
		default:
			return runLibraryAction(request, outcome)
	}
}

/** Do one thing and say where everything stands afterwards. A failure is an answer, not a throw. */
export async function runRetrievalAction(raw: string): Promise<RetrievalActionResult> {
	let message: string | undefined
	let error: string | undefined
	const outcome: Outcome = {}
	try {
		const request = JSON.parse(raw || "{}") as RetrievalAction
		message = await act(request, outcome)
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause)
	}
	return {
		ok: error === undefined,
		...(message ? { message } : {}),
		...(error ? { error } : {}),
		...outcome,
		status: await readRetrievalStatus(),
	}
}

import { readFile, writeFile } from "node:fs/promises"
import { basename } from "node:path"
import { lanceDbStatus, memoryWorkspaceKey, resolveLanceDbRuntimeDirectory, sharedLibrary, sharedMemory } from "@cline/core"
import type { RetrievalAction, RetrievalActionResult, RetrievalStatus } from "@shared/retrieval-status"
import { getCwd } from "@utils/path"
import { HostProvider } from "@/hosts/host-provider"
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

export async function readRetrievalStatus(): Promise<RetrievalStatus> {
	const path = await getCwd()
	const embedding = readEmbeddingEndpoint()
	const install = libraryVectorsInstallState()
	const libraryCounts = sharedLibrary().store.counts(embedding?.model)
	const memory = sharedMemory()
	const memoryCounts = memory.counts(embedding?.model)
	return {
		lancedb: {
			...lanceDbStatus({ directory: resolveLanceDbRuntimeDirectory() }),
			installing: install.installing,
			...(install.progress ? { progress: install.progress } : {}),
			...(install.lastError ? { lastInstallError: install.lastError } : {}),
		},
		...(embedding ? { embeddingModel: embedding.model } : {}),
		library: {
			enabled: readLibrarySettings().enabled,
			collections: libraryCounts.collections,
			documents: libraryCounts.documents,
			passages: libraryCounts.chunks,
			embeddedDocuments: libraryCounts.embeddedDocuments,
		},
		memory: {
			enabled: readMemorySettings().enabled,
			memories: memory.listMemories(),
			notes: memoryCounts.notes,
			embeddedNotes: memoryCounts.embeddedNotes,
		},
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

async function act(request: RetrievalAction): Promise<string | undefined> {
	const memory = sharedMemory()
	switch (request.action) {
		case "status":
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
			throw new Error("Unknown action.")
	}
}

/** Do one thing and say where everything stands afterwards. A failure is an answer, not a throw. */
export async function runRetrievalAction(raw: string): Promise<RetrievalActionResult> {
	let message: string | undefined
	let error: string | undefined
	try {
		const request = JSON.parse(raw || "{}") as RetrievalAction
		message = await act(request)
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause)
	}
	return {
		ok: error === undefined,
		...(message ? { message } : {}),
		...(error ? { error } : {}),
		status: await readRetrievalStatus(),
	}
}

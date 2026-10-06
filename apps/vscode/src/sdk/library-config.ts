import {
	installLanceDb,
	isLanceDbInstalled,
	type LibrarySettings,
	type LibraryToolsConfig,
	lanceDbInstallBytes,
	lanceDbUnsupportedReason,
	type MemorySettings,
	type MemoryToolsConfig,
	parseOcrLanguages,
	type RetrievalEndpoint,
	resolveLanceDbRuntimeDirectory,
	resolveLibrarySettings,
	resolveMemorySettings,
} from "@cline/core"
import { StateManager } from "@/core/storage/StateManager"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { embeddingEndpointConfigured, parseRetrievalEndpoints, rerankingEndpointConfigured } from "@/shared/retrieval-endpoints"
import { Logger } from "@/shared/services/Logger"
import { ensureBaseUrlScheme } from "./cline-session-factory"
import { readLeadMediaProvider } from "./media-endpoint-config"

/**
 * The Library panel and the Embedding tab as the one configuration core
 * builds the Library's tools from.
 *
 * Two places because they are two questions: the panel says how documents
 * are split and searched, and the tab, which sits with the other models in
 * the API configuration, says which model embeds and which reranks.
 */

/** The Library's settings in use: what is stored, over the defaults. */
export function readLibrarySettings(): LibrarySettings {
	const state = StateManager.get()
	let stored: Record<string, unknown> = {}
	try {
		const parsed = JSON.parse(state.getGlobalSettingsKey("librarySettings") || "{}")
		if (typeof parsed === "object" && parsed !== null) {
			stored = parsed as Record<string, unknown>
		}
	} catch {
		// Unreadable storage is the defaults, not a reason to throw.
	}
	// The switch is a setting of its own, and the one that counts.
	return { ...resolveLibrarySettings(stored), enabled: state.getGlobalSettingsKey("libraryEnabled") === true }
}

/**
 * Where texts are embedded, when "Use an embedding model" is ticked and the
 * tab names a model: on the session's provider when the tab says so and it
 * has an address, at the typed endpoint otherwise.
 */
export function readEmbeddingEndpoint(): RetrievalEndpoint | undefined {
	const state = StateManager.get()
	if (state.getGlobalSettingsKey("embeddingEnabled") !== true) {
		return undefined
	}
	const stored = parseRetrievalEndpoints(state.getGlobalSettingsKey("retrievalEndpoints"))
	if (!embeddingEndpointConfigured(stored)) {
		return undefined
	}
	const typedKey = state.getSecretKey("embeddingApiKey")?.trim() || undefined
	const provider = stored.useProvider ? readLeadMediaProvider() : undefined
	if (provider?.baseUrl) {
		const apiKey = typedKey ?? provider.apiKey
		return { baseUrl: ensureBaseUrlScheme(provider.baseUrl), model: stored.embedding.model, ...(apiKey ? { apiKey } : {}) }
	}
	if (!stored.embedding.baseUrl) {
		return undefined
	}
	return {
		baseUrl: ensureBaseUrlScheme(stored.embedding.baseUrl),
		model: stored.embedding.model,
		...(typedKey ? { apiKey: typedKey } : {}),
	}
}

/** Where passages are reranked. Always a typed endpoint: few servers that chat also rerank. */
export function readRerankingEndpoint(): RetrievalEndpoint | undefined {
	const state = StateManager.get()
	if (state.getGlobalSettingsKey("embeddingEnabled") !== true) {
		return undefined
	}
	const stored = parseRetrievalEndpoints(state.getGlobalSettingsKey("retrievalEndpoints"))
	if (!rerankingEndpointConfigured(stored)) {
		return undefined
	}
	const apiKey = state.getSecretKey("rerankingApiKey")?.trim() || undefined
	return {
		baseUrl: ensureBaseUrlScheme(stored.reranking.baseUrl),
		model: stored.reranking.model,
		...(apiKey ? { apiKey } : {}),
	}
}

function readOcrEngine(value: string | undefined): "tesseract" | "vision" | "off" {
	return value === "vision" || value === "off" ? value : "tesseract"
}

/** Undefined while the Library is off. Read again on every tool call. */
export function readLibraryToolsConfig(): LibraryToolsConfig | undefined {
	const settings = readLibrarySettings()
	if (!settings.enabled) {
		return undefined
	}
	const state = StateManager.get()
	const embedding = readEmbeddingEndpoint()
	const reranker = readRerankingEndpoint()
	// A book is read the way the Document Reader is set to read. The vision
	// engine needs a model in the conversation, which indexing has not got.
	const ocr = readOcrEngine(state.getGlobalSettingsKey("extractDocumentOcr"))
	return {
		settings,
		...(embedding ? { embedding } : {}),
		...(reranker ? { reranker } : {}),
		documentReader: {
			ocr: ocr === "vision" ? "tesseract" : ocr,
			ocrLanguages: parseOcrLanguages(state.getGlobalSettingsKey("extractDocumentOcrLanguages") ?? "eng"),
		},
	}
}

/** Memory's settings in use: what is stored, over the defaults. */
export function readMemorySettings(): MemorySettings {
	const state = StateManager.get()
	let stored: Record<string, unknown> = {}
	try {
		const parsed = JSON.parse(state.getGlobalSettingsKey("memorySettings") || "{}")
		if (typeof parsed === "object" && parsed !== null) {
			stored = parsed as Record<string, unknown>
		}
	} catch {
		// Unreadable storage is the defaults.
	}
	return { ...resolveMemorySettings(stored), enabled: state.getGlobalSettingsKey("memoryEnabled") === true }
}

/**
 * Undefined while Memory is off. It uses the Embedding tab's models, the
 * same ones the Library does: one embedding model, one set of vectors each.
 */
export function readMemoryToolsConfig(): MemoryToolsConfig | undefined {
	const settings = readMemorySettings()
	if (!settings.enabled) {
		return undefined
	}
	const embedding = readEmbeddingEndpoint()
	const reranker = readRerankingEndpoint()
	return { settings, ...(embedding ? { embedding } : {}), ...(reranker ? { reranker } : {}) }
}

let installing: Promise<void> | undefined

/**
 * Download LanceDB, which holds the Library's vectors, when "Use an embedding
 * model" is ticked.
 *
 * Run when the setting changes rather than at the first search, for the
 * reason OCR languages are: the user is looking at the setting and can see a
 * failure, and a session should never fetch anything mid-task. It is 200 to
 * 390 MB depending on the platform, so it says so before and after.
 */
export function installLibraryVectors(): Promise<void> {
	installing ??= (async () => {
		const directory = resolveLanceDbRuntimeDirectory()
		try {
			if (isLanceDbInstalled({ directory })) {
				return
			}
			const unsupported = lanceDbUnsupportedReason()
			if (unsupported) {
				Logger.warn(`[Library] ${unsupported}`)
				HostProvider.window.showMessage({ type: ShowMessageType.WARNING, message: `Library: ${unsupported}` })
				return
			}
			const bytes = lanceDbInstallBytes()
			const size = bytes ? ` (about ${Math.round(bytes / 1024 / 1024)} MB)` : ""
			Logger.log(`[Library] Downloading LanceDB${size} into ${directory}`)
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: `Library: downloading LanceDB${size} for search by meaning. Keyword search works meanwhile.`,
			})
			await installLanceDb({ directory })
			Logger.log("[Library] LanceDB installed")
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "Library: LanceDB is installed. Documents are embedded the next time something is added.",
			})
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			Logger.warn(`[Library] LanceDB was not installed: ${reason}`)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Library: LanceDB could not be installed (${reason}). Search stays on keywords; untick and tick "Use an embedding model" to try again.`,
			})
		} finally {
			installing = undefined
		}
	})()
	return installing
}

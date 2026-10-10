import {
	installLanceDb,
	isLanceDbInstalled,
	type LibraryScrapeConfig,
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
	resolveScrapeSettings,
	type ScrapeSettings,
} from "@cline/core"
import { type AgentImageToDescribe, isOllamaNativeProvider } from "@cline/shared"
import { findApiConfigurationProfile, parseApiConfigurationProfiles } from "@shared/api-config-profiles"
import { resolveVisionModelStatus } from "@shared/vision-config"
import { StateManager } from "@/core/storage/StateManager"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { embeddingEndpointConfigured, parseRetrievalEndpoints, rerankingEndpointConfigured } from "@/shared/retrieval-endpoints"
import { Logger } from "@/shared/services/Logger"
import { ensureBaseUrlScheme, ollamaNativeBaseUrl, resolveBaseUrl, resolveModelId } from "./cline-session-factory"
import { resolveImageSupport } from "./image-support"
import { readLeadMediaProvider } from "./media-endpoint-config"
import { buildScopedApiConfiguration, buildVisionApiConfiguration, createVisionImageDescriber } from "./vision-model"

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

/** The scraper's settings in use: what is stored, over the defaults. */
export function readScrapeSettings(): ScrapeSettings {
	let stored: Record<string, unknown> = {}
	try {
		const parsed = JSON.parse(StateManager.get().getGlobalSettingsKey("scrapeSettings") || "{}")
		if (typeof parsed === "object" && parsed !== null) {
			stored = parsed as Record<string, unknown>
		}
	} catch {
		// Unreadable storage is the defaults.
	}
	return resolveScrapeSettings(stored)
}

/**
 * The scraping endpoint, when it may be used: turned on with an address
 * under Features, and allowed in the API configuration. Either one missing
 * and nobody has web tools. `librarianOnly` says who gets them.
 */
export function readScrapeConfig(): LibraryScrapeConfig | undefined {
	const state = StateManager.get()
	const settings = readScrapeSettings()
	if (!settings.enabled || !settings.baseUrl || state.getGlobalSettingsKey("scrapeAllowed") !== true) {
		return undefined
	}
	const apiKey = state.getSecretKey("scrapeApiKey")?.trim() || undefined
	return {
		baseUrl: ensureBaseUrlScheme(settings.baseUrl),
		maxPages: settings.maxPages,
		maxDepth: settings.maxDepth,
		librarianOnly: settings.librarianOnly,
		...(apiKey ? { apiKey } : {}),
	}
}

type ImageDescriber = (images: readonly AgentImageToDescribe[]) => Promise<readonly (string | undefined)[]>

/**
 * The model that describes a book's pictures: the saved profile the Library
 * panel names, without one the Vision tab's model, and without that the
 * session's own model when its server says it reads images. `undefined` when
 * none of the three is there, and the pictures are then kept without
 * descriptions. Read when a book is added, so a profile picked mid-session is
 * the one used.
 *
 * The third was missing. A session on `deepseek-v4.1-flash:cloud`, which
 * Ollama reports as `vision`, was told no vision model was set: a second model
 * was demanded of someone whose first could already do the job.
 */
export async function readLibraryImageDescriber(): Promise<ImageDescriber | undefined> {
	return readNamedImageDescriber() ?? (await readSessionImageDescriber())
}

/**
 * The session's own model as the describer, when it is known to read images.
 *
 * Known, not assumed: the catalog's default for a model it has never heard of
 * is optimistic, and a describer that cannot see returns nothing for every
 * picture of a book. So only a server's own "yes" counts here.
 */
async function readSessionImageDescriber(): Promise<ImageDescriber | undefined> {
	const state = StateManager.get()
	const configuration = state.getApiConfiguration()
	const mode = state.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"
	const provider = mode === "plan" ? configuration.planModeApiProvider : configuration.actModeApiProvider
	if (!provider) {
		return undefined
	}
	const model = resolveModelId(provider, mode, configuration)
	const baseUrl = isOllamaNativeProvider(provider)
		? ollamaNativeBaseUrl(provider, configuration)
		: resolveBaseUrl(provider, configuration)
	if ((await resolveImageSupport(provider, baseUrl, model)) !== "yes") {
		return undefined
	}
	Logger.log(`[Library] Pictures are described by the session's own model: provider=${provider} model=${model}`)
	return createVisionImageDescriber(configuration, undefined, mode)
}

function readNamedImageDescriber(): ImageDescriber | undefined {
	const state = StateManager.get()
	const primary = state.getApiConfiguration()
	const named = readLibrarySettings().imageProfile
	if (named) {
		const profile = findApiConfigurationProfile(
			parseApiConfigurationProfiles(state.getGlobalSettingsKey("apiConfigurationProfiles")),
			named,
		)
		const configuration = profile ? buildScopedApiConfiguration(primary, JSON.stringify(profile.snapshot)) : undefined
		if (profile && configuration) {
			return createVisionImageDescriber(
				configuration,
				profile.snapshot.providerConfig as Record<string, unknown> | undefined,
			)
		}
		Logger.warn(`[Library] The profile "${named}" named for describing pictures is gone or names no provider`)
	}
	const snapshot = state.getGlobalSettingsKey("visionModeApiConfiguration")
	if (resolveVisionModelStatus(state.getGlobalSettingsKey("visionModelEnabled"), snapshot) !== "ready") {
		return undefined
	}
	const configuration = buildVisionApiConfiguration(primary, snapshot)
	if (!configuration) {
		return undefined
	}
	let providerSettings: Record<string, unknown> | undefined
	try {
		const held = typeof snapshot === "string" && snapshot ? JSON.parse(snapshot)?.providerConfig : undefined
		providerSettings = held && typeof held === "object" ? (held as Record<string, unknown>) : undefined
	} catch {
		providerSettings = undefined
	}
	return createVisionImageDescriber(configuration, providerSettings)
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
	const scrape = readScrapeConfig()
	// A book is read the way the Document Reader is set to read. The vision
	// engine needs a model in the conversation, which indexing has not got.
	const ocr = readOcrEngine(state.getGlobalSettingsKey("extractDocumentOcr"))
	return {
		settings,
		...(embedding ? { embedding } : {}),
		...(reranker ? { reranker } : {}),
		...(scrape ? { scrape } : {}),
		documentReader: {
			ocr: ocr === "vision" ? "tesseract" : ocr,
			ocrLanguages: parseOcrLanguages(state.getGlobalSettingsKey("extractDocumentOcrLanguages") ?? "eng"),
			maxFileMb: state.getGlobalSettingsKey("extractDocumentMaxFileMb"),
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
let installProgress: { packageIndex: number; packageCount: number } | undefined
let lastInstallError: string | undefined

/** For the panels: whether a download is running, how far it is, and why the last one failed. */
export function libraryVectorsInstallState(): {
	installing: boolean
	progress?: { packageIndex: number; packageCount: number }
	lastError?: string
} {
	return {
		installing: installing !== undefined,
		...(installProgress ? { progress: installProgress } : {}),
		...(lastInstallError ? { lastError: lastInstallError } : {}),
	}
}

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
			lastInstallError = undefined
			await installLanceDb({
				directory,
				onProgress: (progress) => {
					installProgress = { packageIndex: progress.packageIndex, packageCount: progress.packageCount }
				},
			})
			Logger.log("[Library] LanceDB installed")
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "Library: LanceDB is installed. Documents are embedded the next time something is added.",
			})
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			lastInstallError = reason
			Logger.warn(`[Library] LanceDB was not installed: ${reason}`)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Library: LanceDB could not be installed (${reason}). Search stays on keywords; the Download button in Settings > Library tries again.`,
			})
		} finally {
			installing = undefined
			installProgress = undefined
		}
	})()
	return installing
}

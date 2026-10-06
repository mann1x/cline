import { isOllamaNativeProvider } from "@cline/shared"
import { parseApiConfigurationProfiles } from "@shared/api-config-profiles"
import type { ImageModelChoice, ImageSupport, RetrievalImageModels, RetrievalImageSupport } from "@shared/retrieval-status"
import { StateManager } from "@/core/storage/StateManager"
import { fetch } from "@/shared/net"
import { ensureBaseUrlScheme, ollamaNativeBaseUrl, resolveBaseUrl, resolveModelId } from "./cline-session-factory"
import { DEFAULT_OLLAMA_BASE_URL, peekOllamaImageSupport } from "./ollama-model-family"
import { withOllamaNativeDefault } from "./ollama-native"
import { buildScopedApiConfiguration } from "./vision-model"

/**
 * Whether a model reads images, asked of the server that runs it.
 *
 * A picture-describing model is named in two places — the Vision tab and the
 * Library's profile — and both let any model be named. A model with no vision
 * head accepts the request and answers about a picture it never saw, or
 * refuses it, and either way the import carries on with nothing described.
 * Measured: `omnimerge-v6-mtp_tb:27b-q4km-128k` picked for the job, with
 * capabilities `completion, tools, thinking`.
 *
 * The servers say. Ollama and xOllama list `capabilities` per model in
 * `/api/tags`, so one request answers for every model they hold; llama.cpp and
 * opencoti serve one model and answer `modalities.vision` on `/props`.
 * Everything else is left `unknown`, and nothing unknown is ever hidden.
 */

const ASK_TIMEOUT_MS = 4_000
/** Long enough to cover one settings panel opening; short enough to see a pull. */
const ANSWER_TTL_MS = 30_000

interface Held<T> {
	at: number
	answer: Promise<T>
}

const tags = new Map<string, Held<Map<string, boolean> | undefined>>()
const props = new Map<string, Held<boolean | undefined>>()

/** Test seam. */
export function clearImageSupportCache(): void {
	tags.clear()
	props.clear()
}

function held<T>(cache: Map<string, Held<T>>, key: string, ask: () => Promise<T>): Promise<T> {
	const found = cache.get(key)
	if (found && Date.now() - found.at < ANSWER_TTL_MS) {
		return found.answer
	}
	const answer = ask()
	cache.set(key, { at: Date.now(), answer })
	return answer
}

async function getJson(url: string): Promise<unknown> {
	const response = await fetch(url, { signal: AbortSignal.timeout(ASK_TIMEOUT_MS) })
	if (!response.ok) {
		throw new Error(`${url} returned ${response.status}`)
	}
	return await response.json()
}

const trimmedRoot = (baseUrl: string) => ensureBaseUrlScheme(baseUrl.trim()).replace(/\/+$/, "")

/** Every model the server holds, and whether it reads images. `undefined` when the server does not say. */
function ollamaTags(baseUrl: string): Promise<Map<string, boolean> | undefined> {
	const root = trimmedRoot(baseUrl)
	return held(tags, root, async () => {
		try {
			const body = (await getJson(`${root}/api/tags`)) as { models?: unknown }
			const answers = new Map<string, boolean>()
			for (const entry of Array.isArray(body?.models) ? body.models : []) {
				const model = entry as { name?: unknown; capabilities?: unknown }
				// A server too old to list capabilities says nothing about any model.
				if (typeof model?.name !== "string" || !Array.isArray(model.capabilities)) {
					continue
				}
				answers.set(
					model.name,
					model.capabilities.some((capability) => capability === "vision" || capability === "image"),
				)
			}
			return answers.size > 0 ? answers : undefined
		} catch {
			return undefined
		}
	})
}

/** llama.cpp's and opencoti's own answer for the one model they serve. */
function propsVision(baseUrl: string): Promise<boolean | undefined> {
	// `/props` is served at the root; an OpenAI-compatible base URL ends in `/v1`.
	const root = trimmedRoot(baseUrl).replace(/\/v1$/, "")
	return held(props, root, async () => {
		try {
			const body = (await getJson(`${root}/props`)) as { modalities?: { vision?: unknown } }
			const vision = body?.modalities?.vision
			return typeof vision === "boolean" ? vision : undefined
		} catch {
			return undefined
		}
	})
}

/** Providers whose server may be a llama.cpp one. Anything else is not asked. */
const PROPS_PROVIDERS = new Set(["opencoti", "openai", "openai-compatible", "llamacpp", "llama.cpp"])

const supportOf = (answer: boolean | undefined): ImageSupport => (answer === undefined ? "unknown" : answer ? "yes" : "no")

export async function resolveImageSupport(
	providerId: string,
	baseUrl: string | undefined,
	modelId: string | undefined,
): Promise<ImageSupport> {
	if (!modelId) {
		return "unknown"
	}
	if (isOllamaNativeProvider(providerId)) {
		const endpoint = withOllamaNativeDefault(providerId, baseUrl)?.trim() || DEFAULT_OLLAMA_BASE_URL
		if (!URL.canParse(trimmedRoot(endpoint))) {
			return "unknown"
		}
		const listed = (await ollamaTags(endpoint))?.get(modelId)
		// Not in the list: a cloud model the server runs without a pull.
		return supportOf(listed ?? (await peekOllamaImageSupport(trimmedRoot(endpoint), modelId).catch(() => undefined)))
	}
	if (PROPS_PROVIDERS.has(providerId) && baseUrl && URL.canParse(trimmedRoot(baseUrl))) {
		return supportOf(await propsVision(baseUrl))
	}
	return "unknown"
}

/** One Ollama or xOllama server's models, split by what it reports. */
export async function listImageModels(providerId: string, baseUrl: string | undefined): Promise<RetrievalImageModels> {
	const nothing: RetrievalImageModels = { reported: false, vision: [], notVision: [] }
	if (!isOllamaNativeProvider(providerId)) {
		return nothing
	}
	const endpoint = withOllamaNativeDefault(providerId, baseUrl)?.trim() || DEFAULT_OLLAMA_BASE_URL
	if (!URL.canParse(trimmedRoot(endpoint))) {
		return nothing
	}
	const answers = await ollamaTags(endpoint)
	if (!answers) {
		return nothing
	}
	const vision: string[] = []
	const notVision: string[] = []
	for (const [name, reads] of answers) {
		;(reads ? vision : notVision).push(name)
	}
	return { reported: true, vision: vision.sort(), notVision: notVision.sort() }
}

/** What a stored snapshot would run, and whether that model reads images. */
async function choiceOf(
	storedSnapshot: string | undefined,
	providerSettings: Record<string, unknown> | undefined,
): Promise<ImageModelChoice | undefined> {
	const configuration = buildScopedApiConfiguration(StateManager.get().getApiConfiguration(), storedSnapshot)
	const provider = configuration?.actModeApiProvider
	if (!configuration || !provider) {
		return undefined
	}
	const model = resolveModelId(provider, "act", configuration) ?? ""
	const baseUrl = isOllamaNativeProvider(provider)
		? ollamaNativeBaseUrl(provider, configuration, providerSettings)
		: resolveBaseUrl(provider, configuration, providerSettings)
	return { provider, model, images: await resolveImageSupport(provider, baseUrl, model) }
}

const providerSettingsOf = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : undefined

/** The Vision tab's model and every saved profile's, each with its server's answer. */
export async function readImageSupport(): Promise<RetrievalImageSupport> {
	const state = StateManager.get()
	const profiles = parseApiConfigurationProfiles(state.getGlobalSettingsKey("apiConfigurationProfiles"))
	const visionSnapshot = state.getGlobalSettingsKey("visionModeApiConfiguration")
	let visionSettings: Record<string, unknown> | undefined
	try {
		visionSettings =
			typeof visionSnapshot === "string" && visionSnapshot
				? providerSettingsOf(JSON.parse(visionSnapshot)?.providerConfig)
				: undefined
	} catch {
		visionSettings = undefined
	}
	const [visionTab, ...answers] = await Promise.all([
		choiceOf(visionSnapshot, visionSettings),
		...profiles.map(async (profile) => {
			const choice = await choiceOf(JSON.stringify(profile.snapshot), providerSettingsOf(profile.snapshot.providerConfig))
			return { name: profile.name, ...(choice ?? { provider: "", model: "", images: "unknown" as const }) }
		}),
	])
	return { ...(visionTab ? { visionTab } : {}), profiles: answers }
}

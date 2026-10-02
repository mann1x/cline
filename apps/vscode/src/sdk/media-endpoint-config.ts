import {
	type MediaEndpointProbe,
	type MediaKind,
	type MediaSessionProvider,
	probeMediaEndpoint,
	type ResolvedMediaEndpoint,
	resolveMediaEndpoint,
} from "@cline/core"
import { toLegacyApiProvider } from "@shared/model-catalog/provider-helpers"
import { StateManager } from "@/core/storage/StateManager"
import { ensureBaseUrlScheme, resolveApiKey, resolveBaseUrl, resolveModelId } from "./cline-session-factory"

/**
 * What every media tab shares: the session's own provider, and a probe that is
 * not repeated for each tool that asks the same server the same question.
 *
 * A tab's rule is the owner's (2026-10-02): with its "use the configured
 * provider" box ticked, the session's opencoti or xOllama when it serves that
 * kind; otherwise the typed URL; and no tool when the typed URL is empty or
 * the endpoint does not answer.
 */

/** The provider the current mode runs on, as a media tool needs it. */
export function readLeadMediaProvider(): MediaSessionProvider | undefined {
	try {
		const state = StateManager.get()
		const config = state.getApiConfiguration()
		const mode = state.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"
		const named = mode === "plan" ? config.planModeApiProvider : config.actModeApiProvider
		const providerId = named ? (toLegacyApiProvider(named) ?? named) : undefined
		if (!providerId) {
			return undefined
		}
		const baseUrl = resolveBaseUrl(providerId, config)
		const apiKey = resolveApiKey(providerId, config)
		const modelId = resolveModelId(providerId, mode, config)
		return {
			providerId,
			...(baseUrl ? { baseUrl } : {}),
			...(apiKey ? { apiKey } : {}),
			...(modelId ? { modelId } : {}),
		}
	} catch {
		return undefined
	}
}

const PROBE_TTL_MS = 30_000
/** A server that did not answer is asked again sooner: it may be starting. */
const DEAD_PROBE_TTL_MS = 5_000

const probes = new Map<string, { at: number; probe: Promise<MediaEndpointProbe | undefined> }>()

/**
 * One probe per server for half a minute. Five tools resolve at session start,
 * and on an opencoti serving everything they all ask the same three routes.
 */
export function probeMediaServer(baseUrl: string, apiKey: string | undefined): Promise<MediaEndpointProbe | undefined> {
	const url = ensureBaseUrlScheme(baseUrl.trim())
	const key = `${url}\u0000${apiKey ?? ""}`
	const cached = probes.get(key)
	if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
		return cached.probe
	}
	const entry = { at: Date.now(), probe: probeMediaEndpoint(url, { apiKey }) }
	probes.set(key, entry)
	void entry.probe.then((probe) => {
		if (probe === undefined && probes.get(key) === entry) {
			entry.at = Date.now() - PROBE_TTL_MS + DEAD_PROBE_TTL_MS
		}
	})
	return entry.probe
}

/** For tests, and for a settings change that should be seen at once. */
export function resetMediaProbes(): void {
	probes.clear()
}

export interface MediaTabSettings {
	useProvider?: boolean
	baseUrl?: string
	model?: string
	apiKey?: string
}

/** One tab's endpoint for one kind, by the rule above. */
export function resolveMediaTab(
	kind: MediaKind,
	tab: MediaTabSettings,
	provider: MediaSessionProvider | undefined = readLeadMediaProvider(),
): Promise<ResolvedMediaEndpoint> {
	return resolveMediaEndpoint({
		kind,
		useProvider: tab.useProvider === true,
		provider,
		typed: { baseUrl: tab.baseUrl, model: tab.model, apiKey: tab.apiKey },
		probe: probeMediaServer,
	})
}

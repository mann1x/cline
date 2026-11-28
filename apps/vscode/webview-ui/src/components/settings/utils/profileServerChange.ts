import type { ApiConfiguration } from "@shared/api"
import { type ApiConfigurationSnapshot, applyApiConfigurationSnapshot } from "@shared/api-config-snapshot"
import { toLegacyApiProvider } from "@shared/model-catalog/provider-helpers"
import { getActiveProviderAndModelId } from "@/hooks/useNormalizedApiConfiguration"

export interface ProfileServerSide {
	provider: string
	baseUrl: string
	model: string
}

/** What an Update would change about where the profile points: provider, server and model. */
export interface ProfileServerChange {
	from: ProfileServerSide
	to: ProfileServerSide
}

function serverOf(snapshot: ApiConfigurationSnapshot): ProfileServerSide {
	const configuration = applyApiConfigurationSnapshot(snapshot, ["act"]) as ApiConfiguration
	const { provider, modelId } = getActiveProviderAndModelId(configuration, "act")
	const providerId = String(provider ?? snapshot.mode.apiProvider ?? "")
	const fromEntry = snapshot.providerConfig?.baseUrl
	const legacy = providerId ? toLegacyApiProvider(providerId as never) : undefined
	const fromSettings = legacy ? snapshot.global[`${legacy}BaseUrl`] : undefined
	const baseUrl = typeof fromEntry === "string" && fromEntry ? fromEntry : typeof fromSettings === "string" ? fromSettings : ""
	return { provider: providerId, baseUrl: baseUrl.trim(), model: (modelId ?? "").trim() }
}

/**
 * The change an Update would make to the server a profile points at, when it
 * comes with a provider switch.
 *
 * Changing the model, or the URL, and pressing Update is ordinary editing and
 * asks nothing. A provider switch is where a profile's server got silently
 * replaced: the panel showed the new provider's stored entry, which belonged to
 * whatever profile was last loaded on it, and Update saved that under this
 * profile's name (pandorum, 2026-11-28). So when the provider differs and the
 * server or model differs with it, the Update says what it is about to store.
 */
export function profileServerChange(
	stored: ApiConfigurationSnapshot,
	current: ApiConfigurationSnapshot,
): ProfileServerChange | undefined {
	const from = serverOf(stored)
	const to = serverOf(current)
	if (!from.provider || from.provider === to.provider) {
		return undefined
	}
	if (from.baseUrl === to.baseUrl && from.model === to.model) {
		return undefined
	}
	return { from, to }
}

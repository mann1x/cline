import type { AgentProfileConnection } from "@cline/core"
import type { ApiConfiguration } from "@shared/api"
import {
	type ApiConfigurationProfile,
	findApiConfigurationProfile,
	parseApiConfigurationProfiles,
} from "@shared/api-config-profiles"
import { applyApiConfigurationSnapshot } from "@shared/api-config-snapshot"
import { getProviderModelIdKey } from "@shared/storage/provider-keys"
import { SecretKeys } from "@shared/storage/state-keys"

/**
 * Resolves a saved API configuration profile for a subagent whose frontmatter
 * names one.
 *
 * A profile is the unit the user already works in: they picked a provider, a
 * model, a context window, a sampler and a thinking budget, and gave the
 * combination a name. An agent file has keys for the first two and nowhere at
 * all to put the rest, so `profile: fast-reviewer` says more in one word than
 * `providerId` and `modelId` say in two lines.
 *
 * A profile carries no API key — see `captureApiConfigurationSnapshot` for why
 * — so the key comes from the session's configuration, where keys are stored
 * per provider and shared across the app.
 *
 * Returns `undefined` for a name the store has never heard of, which core turns
 * into a refusal naming the agent and the profile rather than a silent fallback
 * to the session's model.
 */
/**
 * The names of the saved profiles, for the message an agent gets when the one
 * it names is gone. Read from the same stored list the resolver uses, so the
 * two can never disagree about what exists.
 */
export function createAgentProfileNameLister(storedProfiles: string | undefined): () => string[] {
	const names = parseApiConfigurationProfiles(storedProfiles).map((profile) => profile.name)
	return () => names
}

export function createAgentProfileConnectionResolver(input: {
	storedProfiles: string | undefined
	primary: ApiConfiguration | undefined
}): (name: string) => AgentProfileConnection | undefined {
	const profiles = parseApiConfigurationProfiles(input.storedProfiles)

	return (name) => {
		const profile = findApiConfigurationProfile(profiles, name)
		return profile ? buildProfileConnection(profile, input.primary) : undefined
	}
}

/**
 * The endpoint each saved profile points at, and the parallel-session count
 * stored beside it.
 *
 * For the slot bounds: an agent naming a profile runs on that profile's server,
 * and how many requests *that* server serves at once is not the lead's number.
 * Built from {@link buildProfileConnection}, the same function the resolver
 * hands core, so the endpoint the bound is filed under is by construction the
 * endpoint the agent will call. Deriving it separately is how the two would
 * come to disagree about a trailing slash and the bound would sit on a key
 * nothing ever looks up.
 *
 * A profile carries its own count when the user set one on it; otherwise the
 * shared provider entry answers, which is the precedence the session itself
 * uses.
 */
export function listAgentProfileEndpoints(input: {
	storedProfiles: string | undefined
	primary: ApiConfiguration | undefined
	storedParallelSessions?: (providerId: string) => unknown
}): Array<{ providerId: string; baseUrl?: string; parallelSessions: unknown }> {
	const endpoints: Array<{ providerId: string; baseUrl?: string; parallelSessions: unknown }> = []
	for (const profile of parseApiConfigurationProfiles(input.storedProfiles)) {
		const connection = buildProfileConnection(profile, input.primary)
		if (!connection) {
			continue
		}
		const held = profile.snapshot.providerConfig as Record<string, unknown> | undefined
		endpoints.push({
			providerId: connection.providerId,
			...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
			parallelSessions: held?.parallelSessions ?? input.storedParallelSessions?.(connection.providerId),
		})
	}
	return endpoints
}

function buildProfileConnection(
	profile: ApiConfigurationProfile,
	primary: ApiConfiguration | undefined,
): AgentProfileConnection | undefined {
	const settings = applyApiConfigurationSnapshot(profile.snapshot, ["plan", "act"]) as Record<string, unknown>
	const providerId = settings.actModeApiProvider
	if (typeof providerId !== "string" || !providerId) {
		return undefined
	}

	// The picker's copy first, for the same reason the Vision tab reads it
	// first: it is what the user last chose, and the mode keys can be left
	// holding another model entirely (#43).
	const held = profile.snapshot.providerConfig as Record<string, unknown> | undefined
	const selected = held?.selectedModelId
	const modelId =
		typeof selected === "string" && selected
			? selected
			: (settings[getProviderModelIdKey(providerId, "act")] as string | undefined)

	return {
		providerId,
		...(modelId ? { modelId } : {}),
		...(resolveApiKeyForProvider(providerId, primary) ?? {}),
		...(typeof settings.ollamaBaseUrl === "string" && settings.ollamaBaseUrl ? { baseUrl: settings.ollamaBaseUrl } : {}),
		// The settings the profile exists to carry: the context window above
		// all, which is the field with no home in an agent file.
		...(held && Object.keys(held).length > 0 ? { providerConfig: held } : {}),
	}
}

/**
 * The key for a provider, off the session's configuration.
 *
 * Profiles hold no secrets, so this is the only place a key can come from. The
 * per-provider key name is not worth a second mapping table here: every stored
 * key ends in `ApiKey`, and the session configuration is the same object the
 * rest of the host reads them from.
 */
function resolveApiKeyForProvider(providerId: string, primary: ApiConfiguration | undefined): { apiKey: string } | undefined {
	if (!primary) {
		return undefined
	}
	const candidate = `${providerId}ApiKey`
	for (const key of SecretKeys as readonly string[]) {
		if (key.toLowerCase() !== candidate.toLowerCase()) {
			continue
		}
		const value = (primary as Record<string, unknown>)[key]
		return typeof value === "string" && value ? { apiKey: value } : undefined
	}
	const fallback = (primary as Record<string, unknown>).apiKey
	return typeof fallback === "string" && fallback ? { apiKey: fallback } : undefined
}

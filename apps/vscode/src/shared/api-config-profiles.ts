import type { ApiProvider } from "./api"
import type { ApiConfigurationSnapshot } from "./api-config-snapshot"

/**
 * Named API-configuration profiles.
 *
 * Stock Cline needs none of this: a provider and a model fit on one screen and
 * are quick to retype. This fork's panel is not that — context size, sampling,
 * thinking budget and a base URL all vary per model, and several of them vary
 * per quantisation of the *same* model. Rebuilding that combination by hand
 * every time is the thing profiles exist to stop.
 *
 * A profile deliberately does not include API keys; see
 * `captureApiConfigurationSnapshot` for why.
 */
export interface ApiConfigurationProfile {
	/** Unique, and what the user sees. Trimmed, never empty. */
	name: string
	/** Epoch millis of the last save, for ordering the list. */
	updatedAt: number
	snapshot: ApiConfigurationSnapshot
}

/** Longest accepted profile name. Long enough for `provider / long-model-id`. */
export const MAX_PROFILE_NAME_LENGTH = 120

/**
 * Reads the stored profile list.
 *
 * Storage holds JSON in a plain settings string, so anything at all can be in
 * there — a half-written value, or state from a build that spelled a profile
 * differently. Unreadable entries are dropped rather than thrown, because the
 * alternative is a settings panel that will not open.
 */
export function parseApiConfigurationProfiles(raw: string | undefined): ApiConfigurationProfile[] {
	if (!raw) {
		return []
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return []
	}
	if (!Array.isArray(parsed)) {
		return []
	}
	const seen = new Set<string>()
	const profiles: ApiConfigurationProfile[] = []
	for (const entry of parsed) {
		const profile = toProfile(entry)
		if (!profile || seen.has(profile.name)) {
			continue
		}
		seen.add(profile.name)
		profiles.push(profile)
	}
	return profiles
}

function toProfile(entry: unknown): ApiConfigurationProfile | null {
	if (!entry || typeof entry !== "object") {
		return null
	}
	const candidate = entry as Partial<ApiConfigurationProfile>
	const name = typeof candidate.name === "string" ? candidate.name.trim() : ""
	if (!name) {
		return null
	}
	const snapshot = candidate.snapshot
	if (!snapshot || typeof snapshot !== "object") {
		return null
	}
	return {
		name: name.slice(0, MAX_PROFILE_NAME_LENGTH),
		updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : 0,
		snapshot: {
			global: isRecord(snapshot.global) ? snapshot.global : {},
			mode: isRecord(snapshot.mode) ? snapshot.mode : {},
			// Same drop as in `parseApiConfigurationSnapshot`: a saved profile
			// stored its provider settings and got a profile back without them,
			// so loading one restored the provider and model but not the context
			// size, sampling or thinking budget saved alongside them.
			...(isRecord(snapshot.providerConfig) ? { providerConfig: snapshot.providerConfig } : {}),
		},
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value)
}

export function serializeApiConfigurationProfiles(profiles: readonly ApiConfigurationProfile[]): string {
	return JSON.stringify(profiles)
}

/** Reads a stored snapshot, e.g. the vision model's own configuration. */
export function parseApiConfigurationSnapshot(raw: string | undefined): ApiConfigurationSnapshot | undefined {
	if (!raw) {
		return undefined
	}
	try {
		const parsed = JSON.parse(raw)
		if (!isRecord(parsed)) {
			return undefined
		}
		return {
			global: isRecord(parsed.global) ? parsed.global : {},
			mode: isRecord(parsed.mode) ? parsed.mode : {},
			// Rebuilding only the two known sections silently dropped this one.
			// The write landed and the read threw it away, so the Vision tab kept
			// showing the first model in the list however many times a model was
			// chosen, and a profile never restored the provider settings it had
			// stored.
			...(isRecord(parsed.providerConfig) ? { providerConfig: parsed.providerConfig } : {}),
		}
	} catch {
		return undefined
	}
}

/**
 * Suggests a name for the combination now in the panel.
 *
 * `provider / model`, because that is what the user is actually choosing
 * between and what they will scan the list for later. When the same pairing is
 * already saved a counter is appended, so proposing a name never silently
 * targets an existing profile.
 */
export function proposeProfileName(
	provider: ApiProvider | string | undefined,
	modelId: string | undefined,
	existing: readonly ApiConfigurationProfile[],
): string {
	const parts = [provider, modelId].map((part) => (part ?? "").trim()).filter((part) => part.length > 0)
	const base = (parts.length > 0 ? parts.join(" / ") : "New profile").slice(0, MAX_PROFILE_NAME_LENGTH)
	const taken = new Set(existing.map((profile) => profile.name.toLowerCase()))
	if (!taken.has(base.toLowerCase())) {
		return base
	}
	for (let suffix = 2; suffix < 1000; suffix += 1) {
		const candidate = `${base} (${suffix})`
		if (!taken.has(candidate.toLowerCase())) {
			return candidate
		}
	}
	return base
}

/** Inserts or replaces a profile by name, keeping the list ordered by name. */
export function upsertApiConfigurationProfile(
	profiles: readonly ApiConfigurationProfile[],
	profile: ApiConfigurationProfile,
): ApiConfigurationProfile[] {
	const others = profiles.filter((entry) => entry.name.toLowerCase() !== profile.name.toLowerCase())
	return [...others, profile].sort((a, b) => a.name.localeCompare(b.name))
}

export function removeApiConfigurationProfile(
	profiles: readonly ApiConfigurationProfile[],
	name: string,
): ApiConfigurationProfile[] {
	return profiles.filter((entry) => entry.name.toLowerCase() !== name.toLowerCase())
}

export function findApiConfigurationProfile(
	profiles: readonly ApiConfigurationProfile[],
	name: string,
): ApiConfigurationProfile | undefined {
	return profiles.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
}

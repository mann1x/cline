import { ApiHandlerSettingsKeys } from "@shared/storage/state-keys"
import type { Mode } from "@shared/storage/types"
import type { ApiConfiguration } from "./api"

/**
 * Capturing and restoring "everything in the API configuration panel".
 *
 * Two features need the same thing: named profiles the user can switch between,
 * and a separate model used only for vision. Both come down to taking the panel
 * as it stands, storing it, and putting it back later.
 *
 * The key list is not written out here. `ApiHandlerSettingsKeys` is the single
 * source of truth for what the panel holds, and it grows every time a provider
 * is added — a list copied to this file would be silently incomplete within a
 * release, and the symptom would be a profile that quietly drops a field. So
 * the split between global and mode-scoped fields is derived from the naming
 * convention instead: mode-scoped keys are spelled `planModeX` / `actModeX`.
 *
 * API keys are deliberately not included; see {@link captureApiConfigurationSnapshot}.
 */

/** The one mode-scoped pair that does not follow the `<mode>Mode` prefix. */
const IRREGULAR_MODE_KEYS: ReadonlyArray<{
	plan: string
	act: string
	unprefixed: string
}> = [
	{
		plan: "geminiPlanModeThinkingLevel",
		act: "geminiActModeThinkingLevel",
		unprefixed: "geminiThinkingLevel",
	},
]

export interface ApiConfigurationSnapshot {
	/** Fields shared by both modes: base URLs, context size, timeouts, sampling. */
	global: Record<string, unknown>
	/** Mode-scoped fields, held without their `planMode` / `actMode` prefix. */
	mode: Record<string, unknown>
	/**
	 * The provider's own entry in providers.json.
	 *
	 * `ApiHandlerSettingsKeys` is not the whole panel, and for some providers it
	 * is barely any of it. Ollama keeps exactly two keys there — the base URL and
	 * a legacy context string — while the reasoning level, the context window and
	 * every sampling parameter live in providers.json, written through
	 * `useProviderConfig`. A profile built from the settings keys alone stored
	 * none of that, and, because nothing it tracked had changed, also reported no
	 * unsaved changes after the user had just retuned the whole sampler.
	 *
	 * Absent for providers with no such entry, and for profiles saved before this
	 * existed — those load exactly as they did, leaving providers.json alone.
	 */
	providerConfig?: Record<string, unknown>
}

/**
 * The providers.json fields a profile carries.
 *
 * Everything here is writable through `WriteProviderConfigPatch`, so a load can
 * put back what a save took. Credentials are excluded for the same reason API
 * keys are excluded from the settings snapshot: a profile is a named set of
 * preferences, and it gets shared, exported and pasted into issues.
 */
export const PROVIDER_CONFIG_PROFILE_KEYS = [
	"baseUrl",
	"apiLine",
	"contextWindow",
	"maxToolResultChars",
	// Edited in the same panel and writable through the same patch. Left out of
	// this list it was invisible to a profile in both directions: changing it
	// marked nothing unsaved, and saving a profile did not carry it.
	"parallelSessions",
	"reasoning",
	"sampling",
	// Both are in PROVIDER_CONFIG_CLEARS below, and were missing here: every
	// profile load cleared them and no profile save ever carried them back, so
	// a PolyKV switch turned off came back on at the next profile load and the
	// panel could not say why. A key the load clears must be a key the save
	// captures -- the two lists are one contract read from both ends.
	"polykv",
	"outputBudget",
	// Which tools the profile brings in. In both lists for the same reason the
	// two above are: a key the load clears must be a key the save captures, or
	// a profile with no selection comes back carrying the last one's.
	"tools",
	"headers",
	"region",
	"aws",
	"gcp",
] as const

/**
 * Where {@link captureProviderConfigSnapshot} files the committed model's
 * overrides. Not one of the keys above: those are provider fields written
 * through `WriteProviderConfigPatch`, and this one is restored by committing
 * the selection instead, so a load has to pull it back out before writing.
 */
export const PROVIDER_CONFIG_MODEL_OVERRIDES_KEY = "modelOverrides"

/**
 * How each profile-carried provider field is spelled when a profile does not
 * carry it.
 *
 * A providers.json write is a patch: it changes what it names and leaves
 * everything else alone. So loading a profile has to name the fields the
 * profile is silent about as well, or the previous profile's values survive
 * under the new profile's name — reported as "when I load a profile with a
 * different value the tool results character cap doesn't update, and it asks me
 * to update the new profile". It asked because the panel really did differ from
 * the profile that had just been loaded. This is the rule
 * {@link applyApiConfigurationSnapshot} already follows for the settings half.
 *
 * Listed here are the fields the store documents an unset spelling for: zero
 * for the three numbers, an empty message for the sampler. Base URL, API line,
 * headers, region, aws and gcp have no such sentinel and are how the provider
 * is reached at all, so a profile that says nothing about them leaves them
 * alone rather than guessing at a value that would take the endpoint down.
 *
 * The sampler needed no migration to join them: it has been captured for
 * exactly as long as profiles have carried a provider config — both arrived in
 * the same commit — so no profile holds one without the other. A profile with
 * no sampler either predates provider configs altogether, and is already
 * cleared wholesale, or genuinely had none when it was saved. Inheriting the
 * last profile's temperature under this profile's name is the fault being
 * fixed, and it is the one that actually changes what the model does.
 */
export const PROVIDER_CONFIG_CLEARS: Readonly<Record<string, unknown>> = {
	contextWindow: 0,
	maxToolResultChars: 0,
	parallelSessions: 0,
	sampling: {},
	// Same reason as sampling: a profile that does not mention the section must
	// clear it on load, or it inherits the previous profile's PolyKV policy and
	// then reports itself dirty against a value it never carried.
	polykv: {},
	// Same reason again: a profile that does not name an output budget must fall
	// back to `auto` rather than inherit the previous profile's manual cap.
	outputBudget: {},
	// A profile that names no tools brings all of them in, which is the state
	// this restores. Without it a profile saved before the section existed --
	// every profile, right now -- would inherit whatever selection the previous
	// profile made, and a model would silently lose tools under a profile that
	// never mentioned them.
	tools: {},
	// And the reasoning section, so a profile that carries none stops inheriting
	// the previous profile's effort, budget and replay mode. `{}` rather than
	// `null` because the patch crosses a proto boundary: `reasoning` is an
	// optional message, and a `null` on the way in is serialized as absent,
	// which reads as "leave it alone". Present and empty survives, and the store
	// reads it as the clear.
	reasoning: {},
}

/**
 * Fields inside a carried section that a profile can be silent about.
 *
 * The clears above answer "the profile has no section at all". This answers the
 * other half: the profile has the section, and one field inside it is absent
 * because absent is what that field's default is spelled as. Merging such a
 * section leaves the previous profile's value for exactly that field, which is
 * the top-level fault one level down.
 *
 * `reasoningHistory` is the case that needs it. Automatic is stored as absent —
 * deliberately, so the resolver falls through to the probe rather than pinning
 * a mode that was only ever a default — so a profile saved on Automatic carries
 * `reasoning` without it, and loading that profile would keep the last
 * profile's `last` or `none`. `""` is the panel's own clear-to-Automatic, so
 * the load says the same thing the dropdown says.
 *
 * `enabled`, `effort` and `budgetTokens` are not listed: absent means unset for
 * all three, and the store has no sentinel that restores unset without also
 * meaning something else (`effort: "none"` additionally forces `enabled:false`).
 * A profile that carries the section but not those keeps whatever the section
 * being cleared-then-written already settled.
 */
const PROVIDER_CONFIG_SECTION_CLEARS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
	reasoning: { reasoningHistory: "" },
}

/**
 * The providers.json patch that loads a profile's provider config.
 *
 * The model overrides are dropped on the way out: they are restored by
 * committing the model selection, not by writing a provider field.
 */
export function providerConfigPatchForProfile(providerConfig: Record<string, unknown> | undefined): Record<string, unknown> {
	const patch: Record<string, unknown> = { ...(providerConfig ?? {}) }
	delete patch[PROVIDER_CONFIG_MODEL_OVERRIDES_KEY]
	// Which sections the profile actually carries, read before the clears below
	// fill the rest in — a section the profile does not have is cleared whole,
	// and must not then be handed a field-level clear that makes it non-empty
	// again.
	const carriedSections = new Set(Object.keys(patch))
	for (const [key, cleared] of Object.entries(PROVIDER_CONFIG_CLEARS)) {
		if (patch[key] === undefined || patch[key] === null) {
			patch[key] = cleared
		}
	}
	for (const [key, fields] of Object.entries(PROVIDER_CONFIG_SECTION_CLEARS)) {
		const section = patch[key]
		if (!carriedSections.has(key) || !section || typeof section !== "object" || Array.isArray(section)) {
			continue
		}
		// Copied, not filled in place: the section object here belongs to the
		// stored profile, and adding a clear to it would rewrite the profile to
		// say `""` where it deliberately says nothing.
		const carried = { ...(section as Record<string, unknown>) }
		for (const [field, cleared] of Object.entries(fields)) {
			if (carried[field] === undefined || carried[field] === null) {
				carried[field] = cleared
			}
		}
		patch[key] = carried
	}
	return patch
}

/**
 * The committed model's overrides for one mode, if it has any.
 *
 * Per-Turn Max Output Tokens is written here and nowhere else: it travels with
 * the model selection (`commitModelSelection`), not among the provider's own
 * fields, so no entry in {@link PROVIDER_CONFIG_PROFILE_KEYS} could ever reach
 * it. Left out, it was invisible to a profile in both directions — changing it
 * marked nothing unsaved, and saving a profile did not carry it — which is the
 * same fault `parallelSessions` had, one level further down.
 */
function committedModelOverrides(source: Record<string, unknown>, mode: Mode): Record<string, unknown> | undefined {
	const selection = source[mode === "plan" ? "planSelection" : "actSelection"] as
		| { overrides?: Record<string, unknown> }
		| undefined
	const overrides = selection?.overrides
	if (!overrides || Object.keys(overrides).length === 0) {
		return undefined
	}
	return overrides
}

/**
 * Reads the profile-carried fields out of a provider config response.
 *
 * Returns `undefined` only when there is no response to read — the RPC behind
 * it has not resolved yet. An entry that has been read and holds none of these
 * fields captures an empty object, which is a different thing and has to stay
 * different: the caps are blank far more often than not, and collapsing "read,
 * and empty" into "not read yet" made {@link apiConfigurationSnapshotsEqual}
 * treat the panel as still loading. Clearing the last value an entry held then
 * marked nothing unsaved, so it could not be saved — reported as the two caps
 * not raising the Update button "when they are empty".
 */
export function captureProviderConfigSnapshot(config: unknown, mode: Mode = "act"): Record<string, unknown> | undefined {
	if (!config || typeof config !== "object") {
		return undefined
	}
	const source = config as Record<string, unknown>
	const captured: Record<string, unknown> = {}
	for (const key of PROVIDER_CONFIG_PROFILE_KEYS) {
		const value = source[key]
		if (value === undefined || value === null) {
			continue
		}
		captured[key] = value
	}
	const overrides = committedModelOverrides(source, mode)
	if (overrides) {
		captured[PROVIDER_CONFIG_MODEL_OVERRIDES_KEY] = overrides
	}
	return captured
}

/** Splits a configuration key into its mode and unprefixed name, if it has one. */
export function parseModeScopedKey(key: string): { mode: Mode; unprefixed: string } | null {
	for (const irregular of IRREGULAR_MODE_KEYS) {
		if (key === irregular.plan) {
			return { mode: "plan", unprefixed: irregular.unprefixed }
		}
		if (key === irregular.act) {
			return { mode: "act", unprefixed: irregular.unprefixed }
		}
	}
	const match = /^(plan|act)Mode(.+)$/.exec(key)
	if (!match) {
		return null
	}
	// `planModeApiProvider` -> `apiProvider`: the remainder keeps its own casing
	// apart from the first letter, which the prefix had capitalised.
	const remainder = match[2]
	return {
		mode: match[1] as Mode,
		unprefixed: remainder.charAt(0).toLowerCase() + remainder.slice(1),
	}
}

/** The storage key holding `unprefixed` for `mode`. */
export function modeScopedKey(unprefixed: string, mode: Mode): string {
	const irregular = IRREGULAR_MODE_KEYS.find((entry) => entry.unprefixed === unprefixed)
	if (irregular) {
		return mode === "plan" ? irregular.plan : irregular.act
	}
	return `${mode}Mode${unprefixed.charAt(0).toUpperCase()}${unprefixed.slice(1)}`
}

/**
 * Takes the panel as it stands for one mode.
 *
 * API keys are not captured. They live in secret storage, keyed by provider and
 * shared across modes, and a profile is an ordinary settings value that is sent
 * to the webview and written to global state — copying keys into it would move
 * them somewhere less protected for no benefit, since the key for a provider is
 * already there when a profile selects that provider.
 */
export function captureApiConfigurationSnapshot(
	configuration: ApiConfiguration | undefined,
	mode: Mode,
): ApiConfigurationSnapshot {
	const snapshot: ApiConfigurationSnapshot = { global: {}, mode: {} }
	if (!configuration) {
		return snapshot
	}
	const source = configuration as Record<string, unknown>
	for (const key of ApiHandlerSettingsKeys as string[]) {
		const scoped = parseModeScopedKey(key)
		if (!scoped) {
			if (source[key] !== undefined) {
				snapshot.global[key] = source[key]
			}
			continue
		}
		if (scoped.mode === mode && source[key] !== undefined) {
			snapshot.mode[scoped.unprefixed] = source[key]
		}
	}
	return snapshot
}

/**
 * Turns a snapshot back into configuration updates for the given modes.
 *
 * Every key the panel knows about appears in the result, with `undefined` for
 * anything the snapshot does not set. That is the point: loading a profile has
 * to clear what the previous one left behind, or a base URL from the profile
 * before it survives into a provider that has no business with it.
 */
export function applyApiConfigurationSnapshot(
	snapshot: ApiConfigurationSnapshot,
	modes: readonly Mode[],
): Partial<ApiConfiguration> {
	const updates: Record<string, unknown> = {}
	for (const key of ApiHandlerSettingsKeys as string[]) {
		const scoped = parseModeScopedKey(key)
		if (!scoped) {
			updates[key] = snapshot.global[key]
			continue
		}
		if (modes.includes(scoped.mode)) {
			updates[key] = snapshot.mode[scoped.unprefixed]
		}
	}
	return updates as Partial<ApiConfiguration>
}

/**
 * Whether two snapshots hold the same settings.
 *
 * Used to decide whether the loaded profile still matches the panel, so the
 * "unsaved changes" marker means what it says. Values are compared by their
 * JSON form because several of them are objects (`ModelInfo`, header maps)
 * whose key order is not stable across a round trip through storage.
 */
/**
 * Whether two snapshots describe the same configuration.
 *
 * The provider config counts. It was once excluded whenever either side lacked
 * one, to keep a profile saved before provider configs were carried from
 * reading as changed the moment it was opened — but a profile with none always
 * lacks one, so the exclusion was permanent: the context window lives in the
 * provider config (`contextWindow`, the value providers.json holds and the
 * session reads), changing it never marked the profile dirty, and it therefore
 * could not be saved. Reported as "unable to save different context windows for
 * each profile", which is exactly what it was.
 *
 * So a stored profile without one now reads as changed against a panel that has
 * one: it does differ, saving it carries the provider config from then on, and
 * a dot beside a profile that genuinely differs is the honest signal — a
 * profile that cannot be saved is not. Loading such a profile still writes
 * nothing to providers.json, which is the other half of what the old rule was
 * protecting.
 *
 * The arguments are not interchangeable, and the call site passes (stored,
 * panel). A panel that has not captured a provider config yet has not finished
 * reading it — the RPC behind it resolves after mount — and a snapshot that is
 * still loading is not evidence of a change.
 */
export function apiConfigurationSnapshotsEqual(a: ApiConfigurationSnapshot, b: ApiConfigurationSnapshot): boolean {
	return (
		sameValues(a.global, b.global) && sameValues(a.mode, b.mode) && providerConfigsEqual(a.providerConfig, b.providerConfig)
	)
}

/**
 * See {@link apiConfigurationSnapshotsEqual} — (stored, panel), not symmetric.
 *
 * `undefined` on the panel side means the RPC has not resolved, which is not
 * evidence of a change. An empty object means it resolved and the entry holds
 * nothing, which very much is: it is what a configuration looks like once its
 * last value has been cleared.
 */
function providerConfigsEqual(stored: Record<string, unknown> | undefined, panel: Record<string, unknown> | undefined): boolean {
	if (panel === undefined) {
		return true
	}
	return sameValues(stored ?? {}, panel)
}

function sameValues(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)])
	for (const key of keys) {
		if (stableJson(a[key]) !== stableJson(b[key])) {
			return false
		}
	}
	return true
}

function stableJson(value: unknown): string {
	if (value === undefined) {
		return "undefined"
	}
	return JSON.stringify(value, (_key, inner) => {
		if (inner && typeof inner === "object" && !Array.isArray(inner)) {
			const sorted: Record<string, unknown> = {}
			for (const key of Object.keys(inner as Record<string, unknown>).sort()) {
				sorted[key] = (inner as Record<string, unknown>)[key]
			}
			return sorted
		}
		return inner
	})
}

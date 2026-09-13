import { parseApiConfigurationSnapshot } from "@shared/api-config-profiles"
import { applyApiConfigurationSnapshot } from "@shared/api-config-snapshot"

/**
 * Whether a second model will actually run, asked once and answered the same
 * way everywhere.
 *
 * Two configurations in this fork name a model that is not the session's: the
 * Vision tab, whose model turns images into text, and the Agents tab, whose
 * model runs subagents and teammates. Both are stored the same way — a
 * `ApiConfigurationSnapshot` in a settings string of its own, rather than in
 * `providers.json`, which holds one entry per provider and therefore has no
 * room for a second configuration on the same one.
 *
 * There are two separate facts behind "the user configured a second model": the
 * toggle, and a tab that names a provider and a model. The toggle is what the
 * UI could see, the resolved configuration is what the session runs, and they
 * were allowed to disagree — see `vision-config.ts` for the measured case that
 * made this a shared question rather than a check at each call site.
 */

export type ScopedModelStatus =
	/** The toggle is off. The session's own model does the work, as before. */
	| "off"
	/** Toggle on, but the tab names no provider or no model — nothing to call. */
	| "unconfigured"
	/** A second model is configured and will be used. */
	| "ready"

/**
 * The model a stored snapshot holds, or `undefined` when it holds none.
 *
 * A tab stores its model as `providerConfig.selectedModelId` (what its picker
 * writes), and that is the field the second model is built from. A tab naming a
 * provider and no model names something to call and nothing to call on it.
 */
export function snapshotModelId(storedSnapshot: string | undefined): string | undefined {
	const snapshot = parseApiConfigurationSnapshot(storedSnapshot)
	if (!snapshot) {
		return undefined
	}
	const held = snapshot.providerConfig as Record<string, unknown> | undefined
	const selected = held?.selectedModelId
	if (typeof selected === "string" && selected) {
		return selected
	}
	// Either place counts. The picker writes `selectedModelId`, but a tab
	// configured through the settings fields carries its model in the mode keys
	// instead (`actModeOllamaModelId` and the per-provider rest of them), and the
	// handler is built from those. Requiring only the picker's copy would call a
	// working tab unconfigured.
	const settings = applyApiConfigurationSnapshot(snapshot, ["plan", "act"]) as Record<string, unknown>
	for (const [key, value] of Object.entries(settings)) {
		if (key.startsWith("actMode") && key.endsWith("ModelId") && typeof value === "string" && value) {
			return value
		}
	}
	return undefined
}

/** The provider a stored snapshot holds, or `undefined` when it holds none. */
export function snapshotProviderId(storedSnapshot: string | undefined): string | undefined {
	const snapshot = parseApiConfigurationSnapshot(storedSnapshot)
	if (!snapshot) {
		return undefined
	}
	const settings = applyApiConfigurationSnapshot(snapshot, ["plan", "act"]) as Record<string, unknown>
	const provider = settings.actModeApiProvider
	return typeof provider === "string" && provider ? provider : undefined
}

/**
 * The provider settings a stored snapshot carries — context window, sampler,
 * thinking budget.
 *
 * These live in the snapshot rather than in `providers.json` because the shared
 * entry belongs to the session's own model. This is the whole reason a second
 * scope can hold a context window of its own at all.
 */
export function snapshotProviderSettings(storedSnapshot: string | undefined): Record<string, unknown> | undefined {
	const snapshot = parseApiConfigurationSnapshot(storedSnapshot)
	const held = snapshot?.providerConfig as Record<string, unknown> | undefined
	return held && Object.keys(held).length > 0 ? held : undefined
}

/**
 * What a second-model setting amounts to for this session.
 *
 * `unconfigured` is a real state and not a synonym for `off`: the user asked
 * for a second model and has not got one, which is worth saying out loud rather
 * than acting on silently.
 */
export function resolveScopedModelStatus(enabled: boolean | undefined, storedSnapshot: string | undefined): ScopedModelStatus {
	if (enabled !== true) {
		return "off"
	}
	// A provider *and* a model. Naming only the provider was still enough to be
	// called "ready", which installed a describer with nothing to call: every
	// description came back empty, the images were dropped, and the run carried
	// on without them -- reported as "it says it removed the image from the
	// context and then just keeps going", with the vision model configured.
	if (!snapshotProviderId(storedSnapshot) || !snapshotModelId(storedSnapshot)) {
		return "unconfigured"
	}
	return "ready"
}

import { parseApiConfigurationSnapshot } from "@shared/api-config-profiles"
import { applyApiConfigurationSnapshot } from "@shared/api-config-snapshot"

/**
 * Whether a vision model will actually run, asked once and answered the same
 * way everywhere.
 *
 * There are two separate facts behind "the user configured a vision model": the
 * toggle, and a Vision tab that names a provider. The toggle is what the chat
 * UI could see, the resolved configuration is what the session runs, and they
 * were allowed to disagree — so a session with the toggle on and an empty
 * Vision tab let the file picker attach an image, installed no describer, and
 * sent the image to a primary model that answered "this model does not support
 * image input" and failed the run.
 *
 * Measured, from a tester's log on 4.99.91: `hasImages:true` on the submit,
 * `model: deepseek-v4-flash:0731-cloud` on the request, and not one line
 * mentioning vision anywhere in twenty thousand lines of extension log.
 *
 * So the question is resolved in one place and both sides ask it here.
 */

export type VisionModelStatus =
	/** The toggle is off. Images go to the primary model, as they always did. */
	| "off"
	/** Toggle on, but the Vision tab names no provider — nothing will describe. */
	| "unconfigured"
	/** A describer will be installed for the session. */
	| "ready"

/**
 * The model the Vision tab holds, or `undefined` when it holds none.
 *
 * The tab stores its model as `providerConfig.selectedModelId`
 * (`VisionModelTab.commitModelSelection`), and that is the field the describer
 * is built from. A tab naming a provider and no model names something to call
 * and nothing to call on it.
 */
export function visionSnapshotModelId(storedSnapshot: string | undefined): string | undefined {
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

/** The provider the Vision tab holds, or `undefined` when it holds none. */
export function visionSnapshotProviderId(storedSnapshot: string | undefined): string | undefined {
	const snapshot = parseApiConfigurationSnapshot(storedSnapshot)
	if (!snapshot) {
		return undefined
	}
	const settings = applyApiConfigurationSnapshot(snapshot, ["plan", "act"]) as Record<string, unknown>
	const provider = settings.actModeApiProvider
	return typeof provider === "string" && provider ? provider : undefined
}

/**
 * What the vision setting amounts to for this session.
 *
 * `unconfigured` is a real state and not a synonym for `off`: the user asked
 * for a describer and has not got one, which is worth saying out loud rather
 * than acting on silently.
 */
export function resolveVisionModelStatus(enabled: boolean | undefined, storedSnapshot: string | undefined): VisionModelStatus {
	if (enabled !== true) {
		return "off"
	}
	// A provider *and* a model. Naming only the provider was still enough to be
	// called "ready", which installed a describer with nothing to call: every
	// description came back empty, the images were dropped, and the run carried
	// on without them -- reported as "it says it removed the image from the
	// context and then just keeps going", with the vision model configured.
	// Same shape as the toggle-versus-tab disagreement above, one level down.
	if (!visionSnapshotProviderId(storedSnapshot) || !visionSnapshotModelId(storedSnapshot)) {
		return "unconfigured"
	}
	return "ready"
}

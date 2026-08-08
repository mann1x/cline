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
	return visionSnapshotProviderId(storedSnapshot) ? "ready" : "unconfigured"
}

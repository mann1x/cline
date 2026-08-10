import { resolveScopedModelStatus, type ScopedModelStatus, snapshotModelId, snapshotProviderId } from "@shared/model-scope-config"

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
 * So the question is resolved in one place and both sides ask it here. The
 * mechanics moved to `model-scope-config` once the Agents tab needed the same
 * answers about its own snapshot; the names here stay because the call sites
 * are about vision and read better for saying so.
 */

export type VisionModelStatus = ScopedModelStatus

/** The model the Vision tab holds, or `undefined` when it holds none. */
export const visionSnapshotModelId = snapshotModelId

/** The provider the Vision tab holds, or `undefined` when it holds none. */
export const visionSnapshotProviderId = snapshotProviderId

/** What the vision setting amounts to for this session. */
export const resolveVisionModelStatus = resolveScopedModelStatus

import path from "node:path"
import { createModelRequestWriter as createCoreModelRequestWriter } from "@cline/core"
import { setModelRequestCapture } from "@cline/llms"
import { Logger } from "@/shared/services/Logger"
import { resolveDataDir } from "./legacy-state-reader"

/**
 * "Save model requests" (Settings > General): every generation request's exact
 * body and the response it got, under `<dataDir>/logs/requests/<session>/`
 * (`<time>-<n>.json` and `<time>-<n>.response.json`).
 *
 * For replaying a turn: a garbled first token is the model's own sample or
 * engine state, and only the request that produced it, replayed on a fresh
 * engine, tells the two apart (opencoti #1553). The body is what the server
 * received -- on xOllama after every field the client adds. Headers are not
 * saved, so no key or token is written. Files are not pruned: the switch is
 * for a session being diagnosed, and turning it off stops the writing.
 */

export function modelRequestCaptureDir(): string {
	return path.join(resolveDataDir(), "logs", "requests")
}

/**
 * The writer is core's, so the plugin and an SDK host write one layout and one
 * reader serves both; only the directory and the log are the extension's.
 */
export function createModelRequestWriter(dir = modelRequestCaptureDir()) {
	return createCoreModelRequestWriter({ dir, logger: { log: (message) => Logger.warn(message) } })
}

/** Switch the capture to match the setting. */
export function applyModelRequestCapture(enabled: boolean, dir = modelRequestCaptureDir()): void {
	setModelRequestCapture(enabled ? createModelRequestWriter(dir) : undefined)
	Logger.log(
		enabled
			? `[request-capture] saving every model request and its response under ${dir}`
			: "[request-capture] model requests are not being saved",
	)
}

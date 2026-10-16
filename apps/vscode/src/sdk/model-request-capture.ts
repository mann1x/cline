import { promises as fs } from "node:fs"
import path from "node:path"
import { type CapturedModelRequest, setModelRequestCapture } from "@cline/llms"
import { Logger } from "@/shared/services/Logger"
import { resolveDataDir } from "./legacy-state-reader"

/**
 * "Save model requests" (Settings > General): every generation request's exact
 * body, one file each, under `<dataDir>/logs/requests/<session>/`.
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

/** A session id as a directory name. */
function folderFor(sessionId: string | undefined): string {
	return sessionId ? sessionId.replace(/[^A-Za-z0-9._-]/g, "_") : "no-session"
}

let sequence = 0

function fileFor(request: CapturedModelRequest): string {
	sequence += 1
	// Sorts in send order: the time, then a counter for requests in one millisecond.
	return `${request.at.replace(/[:.]/g, "-")}-${String(sequence).padStart(4, "0")}.json`
}

export function createModelRequestWriter(dir = modelRequestCaptureDir()) {
	let warned = false
	return (request: CapturedModelRequest) => {
		const folder = path.join(dir, folderFor(request.sessionId))
		const file = path.join(folder, fileFor(request))
		void fs
			.mkdir(folder, { recursive: true })
			.then(() => fs.writeFile(file, `${JSON.stringify(request, null, 2)}\n`, "utf8"))
			.catch((error) => {
				// Said once: a full disk would otherwise log every request.
				if (!warned) {
					warned = true
					Logger.warn(`[request-capture] could not save a model request under ${dir}: ${String(error)}`)
				}
			})
	}
}

/** Switch the capture to match the setting. */
export function applyModelRequestCapture(enabled: boolean, dir = modelRequestCaptureDir()): void {
	setModelRequestCapture(enabled ? createModelRequestWriter(dir) : undefined)
	Logger.log(
		enabled
			? `[request-capture] saving every model request's body under ${dir}`
			: "[request-capture] model requests are not being saved",
	)
}

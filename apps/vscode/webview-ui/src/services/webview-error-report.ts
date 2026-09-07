import { StringRequest } from "@shared/proto/cline/common"
import { UiServiceClient } from "@/services/grpc-client"

/**
 * Tells the extension host about a failure that happened in here.
 *
 * The webview runs in its own process with its own console, and nothing it
 * prints reaches the extension's output channel. So a render that throws takes
 * the whole tree down and leaves a blank panel with no record anywhere: the
 * host is healthy, the task keeps running, and the only trace is in a devtools
 * window nobody had open. Two users have reported exactly that, and neither
 * report could say what happened.
 *
 * Best effort by construction. This is called from an error handler, and an
 * error handler that throws is worse than the error.
 */

/**
 * Past this, a failure that repeats every frame would be writing the log rather
 * than appearing in it. The first few are the ones worth having.
 */
const MAX_REPORTS = 5

let reported = 0
const seen = new Set<string>()

export function reportWebviewFailure(context: string, detail: unknown, extra?: string): void {
	try {
		const message = describe(detail)
		const key = `${context}:${message}`
		// The same failure re-thrown on every re-render is one failure.
		if (seen.has(key) || reported >= MAX_REPORTS) {
			return
		}
		seen.add(key)
		reported += 1
		const body = extra ? `${context}: ${message}\n${extra}` : `${context}: ${message}`
		console.error(body)
		UiServiceClient.reportWebviewError(StringRequest.create({ value: body })).catch(() => {
			// The host is the thing that may be unreachable; nowhere left to say so.
		})
	} catch {
		// Reporting a failure must never become one.
	}
}

function describe(detail: unknown): string {
	if (detail instanceof Error) {
		return detail.stack ? `${detail.message}\n${detail.stack}` : detail.message
	}
	if (typeof detail === "string") {
		return detail
	}
	try {
		return JSON.stringify(detail)
	} catch {
		return String(detail)
	}
}

/**
 * Catches what never reaches a React boundary: a throw from an event handler, a
 * timer, or a promise nobody awaited. None of these blank the panel, but they
 * are the other half of the failures that today leave no trace at all.
 */
export function installGlobalWebviewErrorReporting(): void {
	window.addEventListener("error", (event) => {
		reportWebviewFailure("Uncaught error", event.error ?? event.message)
	})
	window.addEventListener("unhandledrejection", (event) => {
		reportWebviewFailure("Unhandled rejection", event.reason)
	})
}

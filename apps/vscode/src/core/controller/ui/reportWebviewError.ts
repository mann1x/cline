import type { StringRequest } from "@shared/proto/cline/common"
import { Empty } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/** Past this the log line stops being evidence and starts being the log. */
const MAX_REPORT_CHARS = 8_000

/**
 * Records a failure the webview hit, which the extension host cannot see.
 *
 * The webview is a separate process with its own console, and nothing it prints
 * reaches the extension's output channel — so a render that throws leaves an
 * empty panel and no trace at all. Two users have now reported the panel going
 * blank while the task carried on in the background, and neither report could
 * say why, because the only record was in a devtools window nobody had open.
 *
 * Logged as an error rather than surfaced, because the boundary that sends this
 * has already told the user on screen. The point of the log line is the report
 * collected afterwards.
 */
export async function reportWebviewError(_controller: Controller, request: StringRequest): Promise<Empty> {
	const detail = (request.value ?? "").slice(0, MAX_REPORT_CHARS)
	Logger.error(`[Webview] ${detail || "reported a failure with no detail"}`)
	return Empty.create({})
}

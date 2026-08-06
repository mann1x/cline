import { setOllamaNoStreamTimeoutDispatcher } from "@cline/llms"
import { Agent } from "undici"
import { Logger } from "@/shared/services/Logger"

/**
 * Give the Ollama vendor a dispatcher with undici's stream timeouts switched off.
 *
 * The vendor can find one by itself, but only where `undici` is resolvable from
 * disk at runtime. In a packaged extension it is not: the VSIX ships a single
 * bundled `extension.js` and no `node_modules`, and the vendor's import is
 * deliberately written so no bundler can see it — that is what keeps the
 * package browser-safe. The two requirements are in direct conflict, and the
 * import lost silently. Four releases shipped believing `UND_ERR_BODY_TIMEOUT`
 * was fixed while undici's five-minute default `bodyTimeout` was still aborting
 * runs during prompt prefill.
 *
 * This module is the other half. `undici` is a real dependency of this app and
 * `@/shared/net` already imports it, so it is genuinely in the bundle; naming
 * it here is a static import a bundler resolves at build time, and the instance
 * is handed to the vendor rather than discovered by it.
 *
 * Called for its effect at activation, and it says what happened either way —
 * a dispatcher that fails to attach is otherwise indistinguishable from one
 * that worked until a request stalls minutes later and looks like a network
 * fault.
 */
export function installOllamaStreamDispatcher(): void {
	try {
		setOllamaNoStreamTimeoutDispatcher(new Agent({ bodyTimeout: 0, headersTimeout: 0 }))
		Logger.log("[Ollama] Stream dispatcher installed: bodyTimeout and headersTimeout disabled")
	} catch (error) {
		// Left to the vendor's own lookup rather than rethrown: a missing
		// dispatcher degrades to undici's defaults, which is worse but not fatal.
		Logger.warn(
			`[Ollama] Could not install the stream dispatcher, falling back to undici defaults: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
	}
}

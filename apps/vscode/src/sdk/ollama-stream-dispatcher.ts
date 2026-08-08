import {
	hasOllamaFetch,
	hasOllamaNoStreamTimeoutDispatcher,
	setOllamaFetch,
	setOllamaNoStreamTimeoutDispatcher,
} from "@cline/llms"
import { Agent, fetch as undiciFetch } from "undici"
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
let installError: string | undefined

export function installOllamaStreamDispatcher(): void {
	try {
		setOllamaNoStreamTimeoutDispatcher(new Agent({ bodyTimeout: 0, headersTimeout: 0 }))
		// The dispatcher travels with a fetch that reads it. `dispatcher` is
		// undici's own extension to `RequestInit`, so it means something only to
		// undici's fetch — and the global here is not undici's. The extension
		// host installs a proxy-aware fetch over it, and a wrapper that rebuilds
		// the request from the fields it knows about drops the ones it does not.
		// That is why `UND_ERR_BODY_TIMEOUT` outlived the release that installed
		// the dispatcher: it was attached to every request and honoured by none,
		// and the log line saying so was true and useless.
		setOllamaFetch(undiciFetch as unknown as typeof fetch)
	} catch (error) {
		// Left to the vendor's own lookup rather than rethrown: a missing
		// dispatcher degrades to undici's defaults, which is worse but not fatal.
		installError = error instanceof Error ? error.message : String(error)
	}
}

/**
 * Say whether the dispatcher is in force, once there is somewhere to say it.
 *
 * Split from the install because `Logger` fans out to a set of subscribers and
 * the Cline output channel registers late in activation — anything logged
 * before that goes to an empty set. The first cut of this logged from the
 * installer at the top of `activate()`, so the one line written to prove the
 * dispatcher was attached could never appear, which is the same shape of
 * silent failure the dispatcher itself had. The install has to stay early
 * (before any session can cache the vendor's own answer); only the reporting
 * moves.
 */
export function reportOllamaStreamDispatcher(): void {
	if (installError !== undefined) {
		Logger.warn(`[Ollama] Could not install the stream dispatcher, falling back to undici defaults: ${installError}`)
		return
	}
	if (!hasOllamaNoStreamTimeoutDispatcher()) {
		Logger.log("[Ollama] No stream dispatcher in force; undici's default bodyTimeout applies")
		return
	}
	Logger.log(
		hasOllamaFetch()
			? "[Ollama] Stream dispatcher installed on undici's own fetch: bodyTimeout and headersTimeout disabled"
			: "[Ollama] Stream dispatcher installed, but no undici fetch to honour it; the host global may discard it",
	)
}

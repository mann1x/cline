import { StateManager } from "@/core/storage/StateManager"
import type { BrowserDriver } from "@/sdk/browser-tool"
import { BrowserSession } from "@/services/browser/BrowserSession"

/**
 * The VS Code half of `browser`.
 *
 * The tool takes its driver as an injected factory so it can be tested without
 * spawning Chrome. This is the real one, and it lives here because this is the
 * layer allowed to reach for `StateManager` and the browser service.
 */

/**
 * PNG rather than WebP.
 *
 * `BrowserSession` defaults to WebP because the webview renders it and it is
 * smaller. This screenshot is going to a model instead, and local vision
 * runtimes decode PNG universally while WebP support varies by runtime and by
 * quantization. A smaller image the model cannot read is not smaller.
 */
const SCREENSHOT_FORMAT_WEBP = false

export function createVscodeBrowserDriver(): BrowserDriver {
	return new BrowserSession(StateManager.get(), SCREENSHOT_FORMAT_WEBP)
}

/**
 * Whether to offer the tool at all.
 *
 * `browserSettings.disableToolUse` is the checkbox the user already has in the
 * browser settings menu. It had stopped meaning anything — the SDK migration
 * removed the tool that read it, leaving the setting plumbed through every
 * update path and consulted by nobody. This is the reader it lost.
 */
export function isBrowserToolEnabled(): boolean {
	try {
		// The same accessor `BrowserSession` itself reads this through, so the
		// tool's presence and the browser's configuration cannot disagree.
		return StateManager.get().getGlobalSettingsKey("browserSettings")?.disableToolUse !== true
	} catch {
		// Before the state manager is up there is no session to build tools for
		// either; the next call answers properly.
		return true
	}
}

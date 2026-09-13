import type { BrowserDriver } from "@cline/core"
import * as vscode from "vscode"
import { StateManager } from "@/core/storage/StateManager"
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
 * Deliberately *not* `browserSettings.disableToolUse`, which was the obvious
 * candidate and is a trap. That flag has no UI: it appears nowhere in the
 * webview, and the menu that would have owned it renders only inside a
 * `BrowserSessionRow` — which cannot exist until the browser has already run.
 * It also defaulted to `true` upstream and was written back verbatim by every
 * settings save, so a real machine had `"disableToolUse": true` persisted with
 * no way to change it. Gating on it removed the tool for everyone, permanently,
 * with no recourse.
 *
 * A VS Code setting instead: visible in the Settings UI, editable in
 * `settings.json`, overridable per workspace, and consistent with
 * `cline.lintCommand`, which `check_file` already reads the same way.
 */
export function isBrowserToolEnabled(): boolean {
	return vscode.workspace.getConfiguration("cline").get<boolean>("browserTool") !== false
}

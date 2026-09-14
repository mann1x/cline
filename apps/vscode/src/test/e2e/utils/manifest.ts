import { readFileSync } from "node:fs"
import * as path from "node:path"

/**
 * The extension manifest, read at run time.
 *
 * Every e2e test reaches the webview through the activity-bar tab, and the
 * only thing that names that tab is `package.json`. Spelling the name out in a
 * locator makes each test a claim about the brand: when the fork renamed the
 * container, all sixteen tests timed out waiting to click a tab the editor no
 * longer had, and the failure said nothing about a rename. Read the name from
 * the manifest and a rename moves the locators with it.
 */
interface ExtensionManifest {
	contributes: {
		commands: Array<{ command: string; title: string }>
		viewsContainers: { activitybar: Array<{ id: string; title: string }> }
	}
}

const MANIFEST: ExtensionManifest = JSON.parse(
	readFileSync(path.resolve(__dirname, "..", "..", "..", "..", "package.json"), "utf8"),
)

/** Title of the activity-bar container that holds the sidebar webview. */
export const SIDEBAR_TITLE: string = MANIFEST.contributes.viewsContainers.activitybar[0].title

/**
 * Title of a contributed command, as the editor renders it in menus and the
 * code-actions list.
 */
export function commandTitle(commandId: string): string {
	const command = MANIFEST.contributes.commands.find((entry) => entry.command === commandId)
	if (!command) {
		throw new Error(`No command "${commandId}" in the extension manifest`)
	}
	return command.title
}

/** Escapes a manifest string for use inside a locator's regular expression. */
export function asPattern(literal: string): RegExp {
	return new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
}

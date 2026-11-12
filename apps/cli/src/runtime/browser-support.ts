import {
	type BrowserDriver,
	type ChromeBrowserDriverOptions,
	createChromeBrowserDriver,
	findChrome,
	MissingChromeError,
} from "@cline/core";

/**
 * The CLI half of `browser`.
 *
 * The driver itself is core's (`createChromeBrowserDriver`), shared with every
 * host that is not VS Code. What stays here is the one thing only this
 * package can do: name `puppeteer-core` in its own code, so the CLI's build
 * sees the import and ships the module with it.
 */

export { findChrome, MissingChromeError };

export function createCliBrowserDriver(
	options?: Omit<ChromeBrowserDriverOptions, "loadPuppeteer">,
): BrowserDriver {
	return createChromeBrowserDriver({
		...options,
		loadPuppeteer: () => import("puppeteer-core"),
	});
}

/** Kept for symmetry with the extension's driver, which spawns Chrome itself. */
export function chromeIsAvailable(): boolean {
	return findChrome() !== undefined;
}

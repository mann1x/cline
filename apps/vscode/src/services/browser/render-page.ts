import {
	renderWithChrome as coreRenderWithChrome,
	type RenderEnvironment,
	type RenderRequest,
	type RenderResult,
} from "@cline/core"
import * as puppeteer from "puppeteer-core"

/**
 * One render in a headless Chrome: the browser half of `render_image`.
 *
 * The render lives in core (`renderWithChrome`), so every host can offer
 * `render_image` and `transform_image`. This wrapper exists for one reason:
 * puppeteer is named here, in the extension's own code, so the bundler ships
 * it inside the extension.
 */

export type { RenderEnvironment }

export function renderWithChrome(
	request: RenderRequest,
	environment: Omit<RenderEnvironment, "loadPuppeteer">,
): Promise<RenderResult> {
	return coreRenderWithChrome(request, { ...environment, loadPuppeteer: async () => puppeteer })
}

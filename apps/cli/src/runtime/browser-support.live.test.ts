import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createChromeRenderDriver,
	findChrome,
	transformWithDriver,
} from "@cline/core";
import { describe, expect, it } from "vitest";
import { createCliBrowserDriver } from "./browser-support";

/**
 * Core's Chrome drivers, for real, through the CLI (which ships
 * puppeteer-core). Run with CLI_BROWSER_LIVE=1 on a machine with a Chrome.
 */
const live = process.env.CLI_BROWSER_LIVE === "1" && findChrome() !== undefined;

describe.skipIf(!live)("Chrome drivers, live", () => {
	it("reports a page's console and its uncaught parse error as the extension does", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cli-browser-live-"));
		const page = join(dir, "page.html");
		writeFileSync(
			page,
			"<!doctype html><html><body><p>hi</p><script>console.log('hello'); console.warn('careful');</script><script>function f( {</script></body></html>",
		);
		const driver = createCliBrowserDriver();
		try {
			const result = await driver.navigateToUrl(pathToFileURL(page).href);
			expect(result.logs).toContain("hello");
			expect(result.logs).toContain("[warn] careful");
			expect(result.logs).toMatch(/\[Page Error\] SyntaxError/);
			expect(result.screenshot).toMatch(/^data:image\/png;base64,/);
		} finally {
			await driver.closeBrowser();
		}
	}, 60_000);

	it("renders, then transforms the render (the page script survives minification)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cli-render-live-"));
		const driver = createChromeRenderDriver({
			loadPuppeteer: () => import("puppeteer-core"),
		});
		const drawn = await driver.render({
			html: '<!doctype html><html><body style="margin:0"><div id="cerebriline-render-root" style="display:inline-block"><div style="width:100px;height:40px;background:red"></div></div></body></html>',
			baseDir: dir,
			width: 400,
			fitContent: true,
			scale: 1,
			transparent: false,
			wantSvg: false,
		});
		expect([drawn.width, drawn.height]).toEqual([100, 40]);
		const source = join(dir, "red.png");
		writeFileSync(source, drawn.data);
		const resized = await transformWithDriver(driver, {
			sourcePath: source,
			baseDir: dir,
			spec: { width: 50, fit: "inside" },
		});
		expect([resized.width, resized.height]).toEqual([50, 20]);
	}, 60_000);
});

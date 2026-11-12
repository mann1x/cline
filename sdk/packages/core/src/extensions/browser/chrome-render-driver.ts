import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	RENDER_ROOT_ID,
	type RenderDriver,
	type RenderRegion,
	type RenderRequest,
	type RenderResult,
} from "../tools/render-image";
import {
	DEFAULT_CHROME_ARGS,
	findChrome,
	loadPuppeteer,
	MissingChromeError,
	type PuppeteerLoader,
} from "./chrome-browser-driver";

/**
 * One render in a headless Chrome: the browser half of `render_image` (and of
 * `transform_image`, which renders through the same driver).
 *
 * Moved here from the extension so any host can offer both tools: Chrome's
 * path, its arguments and the Mermaid script are given, not looked up in VS
 * Code's settings. A browser is started for the render and closed after it --
 * a few hundred milliseconds beside a render that is rarely the tenth of a
 * session, and a browser that is never kept is never left running.
 */

export interface RenderEnvironment {
	executablePath: string;
	/** `mermaid.min.js`. Absent: a diagram is refused with the reason. */
	mermaidScriptPath?: string;
	args?: string[];
	/** How to load puppeteer-core. Defaults to resolving the installed peer. */
	loadPuppeteer?: PuppeteerLoader;
}

/** How long a page may take to load before it is captured as it stands. */
const LOAD_TIMEOUT_MS = 20_000;
/** How long to wait for late requests (fonts, a stylesheet's images) to stop. */
const SETTLE_TIMEOUT_MS = 3_000;
/** Chrome draws a capture as one texture, and this is as large as one gets. */
const MAX_CAPTURE_PIXELS = 16_000;
const VIEWPORT_HEIGHT = 800;

// The functions handed to `page.evaluate` run inside the page, where these
// exist. This package is compiled without the DOM library, so they are named
// here for those functions alone.
// biome-ignore lint/suspicious/noExplicitAny: a page global
declare const document: any;
// biome-ignore lint/suspicious/noExplicitAny: a page global
declare const window: any;
// biome-ignore lint/suspicious/noExplicitAny: a page global
declare const XMLSerializer: any;

/** Only the parts of puppeteer used here, so it can be typed without it. */
interface RenderPuppeteer {
	launch: (options: Record<string, unknown>) => Promise<RenderBrowser>;
}
interface RenderBrowser {
	newPage: () => Promise<RenderPage>;
	close: () => Promise<void>;
}
interface RenderPage {
	goto: (url: string, options: Record<string, unknown>) => Promise<unknown>;
	waitForNetworkIdle: (options: Record<string, unknown>) => Promise<unknown>;
	addScriptTag: (options: { path: string }) => Promise<unknown>;
	evaluate: <T>(
		// biome-ignore lint/suspicious/noExplicitAny: evaluated in the page, typed there
		fn: (...args: any[]) => T | Promise<T>,
		...args: unknown[]
	) => Promise<T>;
	screenshot: (
		options: Record<string, unknown>,
	) => Promise<Uint8Array | string>;
}

export async function renderWithChrome(
	request: RenderRequest,
	environment: RenderEnvironment,
): Promise<RenderResult> {
	if (request.mermaid && !environment.mermaidScriptPath) {
		throw new Error("this build has no Mermaid to draw the diagram with");
	}
	// A file, not `setContent`: a page set that way lives at about:blank, and
	// Chrome lets no such page load a local stylesheet or image. From a file it
	// can, and the page's `<base>` points those at the workspace.
	const scratch = await mkdtemp(path.join(os.tmpdir(), "cerebriline-render-"));
	const pagePath = path.join(scratch, "page.html");
	await writeFile(pagePath, request.html, "utf8");

	const puppeteer = (await loadPuppeteer(
		environment.loadPuppeteer,
	)) as RenderPuppeteer;
	const browser = await puppeteer.launch({
		executablePath: environment.executablePath,
		headless: "shell",
		args: environment.args ?? [],
		defaultViewport: {
			width: request.width,
			height: request.height ?? VIEWPORT_HEIGHT,
			deviceScaleFactor: request.scale,
		},
	});
	const stop = () => {
		void browser.close().catch(() => undefined);
	};
	request.signal?.addEventListener("abort", stop, { once: true });
	try {
		const page = await browser.newPage();
		try {
			await page.goto(pathToFileURL(pagePath).href, {
				waitUntil: "load",
				timeout: LOAD_TIMEOUT_MS,
			});
		} catch (error) {
			// A font server that never answers holds `load` back for ever. What
			// has arrived is drawn; a page that did not arrive at all is an error.
			if (!(error instanceof Error) || !/timeout/i.test(error.message)) {
				throw error;
			}
		}
		await page
			.waitForNetworkIdle({ idleTime: 300, timeout: SETTLE_TIMEOUT_MS })
			.catch(() => undefined);

		if (request.mermaid && environment.mermaidScriptPath) {
			await page.addScriptTag({ path: environment.mermaidScriptPath });
			const failure = await page.evaluate(
				async (rootId: string, theme: string) => {
					const root = document.getElementById(rootId);
					const text = root?.querySelector("pre.mermaid")?.textContent ?? "";
					const mermaid = window.mermaid;
					if (!root || !mermaid) {
						return "Mermaid did not load in the page";
					}
					mermaid.initialize({
						startOnLoad: false,
						theme,
						securityLevel: "strict",
					});
					try {
						const { svg } = await mermaid.render("cerebriline-diagram", text);
						root.innerHTML = svg;
					} catch (error) {
						return error instanceof Error ? error.message : String(error);
					}
					// Mermaid sizes its drawing as "100% of the container, at most
					// this wide". Here the container is as wide as the drawing, so
					// that is a circle; the drawing's own size is in its viewBox.
					const drawing = root.querySelector("svg");
					const box = drawing?.viewBox?.baseVal;
					if (drawing && box && box.width > 0 && box.height > 0) {
						drawing.setAttribute("width", String(Math.ceil(box.width)));
						drawing.setAttribute("height", String(Math.ceil(box.height)));
						drawing.style.maxWidth = "none";
					}
					return undefined;
				},
				RENDER_ROOT_ID,
				request.mermaid.theme,
			);
			if (failure) {
				throw new Error(failure);
			}
		}
		await page
			.evaluate(() => document.fonts.ready.then(() => true) as Promise<boolean>)
			.catch(() => undefined);

		const drawn = await page.evaluate(
			(
				rootId: string,
			): { x: number; y: number; width: number; height: number } => {
				const root = document.getElementById(rootId);
				if (root) {
					const box = root.getBoundingClientRect();
					return {
						x: Math.max(0, Math.floor(box.left + window.scrollX)),
						y: Math.max(0, Math.floor(box.top + window.scrollY)),
						width: Math.ceil(Math.max(box.width, root.scrollWidth)),
						height: Math.ceil(Math.max(box.height, root.scrollHeight)),
					};
				}
				// A whole document: as wide as its page, as tall as what it holds.
				const whole = document.documentElement;
				return {
					x: 0,
					y: 0,
					width: Math.max(whole.scrollWidth, whole.clientWidth),
					height: Math.max(
						whole.scrollHeight,
						document.body?.scrollHeight ?? 0,
					),
				};
			},
			RENDER_ROOT_ID,
		);

		const asked: RenderRegion =
			request.crop ??
			(request.fitContent
				? drawn
				: {
						x: 0,
						y: 0,
						width: request.width,
						height: request.height ?? Math.max(drawn.height, 1),
					});
		const limit = Math.floor(MAX_CAPTURE_PIXELS / request.scale);
		const clip = {
			x: asked.x,
			y: asked.y,
			width: Math.min(asked.width, limit),
			height: Math.min(asked.height, limit),
		};
		if (clip.width <= 0 || clip.height <= 0) {
			return { data: Buffer.alloc(0), width: 0, height: 0 };
		}
		const format = request.format ?? "png";
		const capture = await page.screenshot({
			type: format,
			...(format !== "png" && request.quality
				? { quality: Math.round(request.quality) }
				: {}),
			clip,
			omitBackground: request.transparent,
			captureBeyondViewport: true,
		});
		const svg = request.wantSvg
			? await page.evaluate((rootId: string) => {
					const drawing = document.getElementById(rootId)?.querySelector("svg");
					return drawing
						? new XMLSerializer().serializeToString(drawing)
						: undefined;
				}, RENDER_ROOT_ID)
			: undefined;
		return {
			data: Buffer.from(capture as Uint8Array),
			width: clip.width,
			height: clip.height,
			...(svg ? { svg } : {}),
		};
	} finally {
		request.signal?.removeEventListener("abort", stop);
		await browser.close().catch(() => undefined);
		await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
	}
}

export interface ChromeRenderDriverOptions {
	/**
	 * Chrome's executable, or how to find it per render (the extension asks
	 * its browser settings each time). Defaults to `findChrome()`.
	 */
	executablePath?:
		| string
		| (() => string | undefined | Promise<string | undefined>);
	/** `mermaid.min.js`; without it a Mermaid diagram is refused with the reason. */
	mermaidScriptPath?: string | (() => string | undefined);
	/** Chrome's arguments, or how to read them per render. Defaults to `DEFAULT_CHROME_ARGS`. */
	args?: string[] | (() => string[] | Promise<string[]>);
	/** How to load puppeteer-core. Defaults to resolving the installed peer. */
	loadPuppeteer?: PuppeteerLoader;
}

/** A `RenderDriver` over `renderWithChrome`, for `render_image` and `transform_image`. */
export function createChromeRenderDriver(
	options: ChromeRenderDriverOptions = {},
): RenderDriver {
	return {
		render: async (request) => {
			const executablePath =
				typeof options.executablePath === "function"
					? await options.executablePath()
					: (options.executablePath ?? findChrome());
			if (!executablePath) {
				throw new MissingChromeError();
			}
			const mermaidScriptPath =
				typeof options.mermaidScriptPath === "function"
					? options.mermaidScriptPath()
					: options.mermaidScriptPath;
			const args =
				typeof options.args === "function"
					? await options.args()
					: (options.args ?? DEFAULT_CHROME_ARGS);
			return renderWithChrome(request, {
				executablePath,
				...(mermaidScriptPath ? { mermaidScriptPath } : {}),
				args,
				...(options.loadPuppeteer
					? { loadPuppeteer: options.loadPuppeteer }
					: {}),
			});
		},
	};
}

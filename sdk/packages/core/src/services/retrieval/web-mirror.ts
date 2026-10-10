/**
 * A site's pages and the files they need, saved as they are.
 *
 * The scraping endpoint reads pages in a browser and gives back their content;
 * it does not give back a stylesheet, a script, a picture or a font. Those are
 * fetched here, straight from the site, by the machine this runs on.
 *
 * Nothing is rewritten. A page is saved as the site served it, byte for byte,
 * and beside it as the browser held it once its scripts had run -- on a site
 * built by JavaScript the first is a shell of a few lines and the second is
 * the page. Links inside them still point where they pointed.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface MirrorPage {
	url: string;
	/** The page as rendered, when the scraper gave it. */
	rawHtml?: string;
}

export interface MirrorLimits {
	/** Files fetched besides the pages, at most. @default 2000 */
	maxAssets?: number;
	/** One file's size, at most. @default 25 MB */
	maxAssetBytes?: number;
	/** Everything fetched, at most. @default 300 MB */
	maxTotalBytes?: number;
	/** How many requests run at once. @default 6 */
	concurrency?: number;
	/** How long one request may take. @default 30 s */
	timeoutMs?: number;
}

export interface MirrorOptions extends MirrorLimits {
	/** The folder everything is written under. */
	root: string;
	fetch?: typeof fetch;
	signal?: AbortSignal;
	onProgress?: (done: number, known: number) => void;
	/**
	 * The file already saved for an address, from an earlier crawl into the
	 * same folder: it is not fetched again.
	 */
	have?: (url: string) => string | undefined;
	/** Files to fetch besides those the pages name: what an earlier crawl left. */
	also?: readonly string[];
}

export interface MirroredPage {
	url: string;
	/** As the site served it; absent when the direct request failed. */
	served?: string;
	/** As the browser rendered it; absent when the scraper gave none. */
	rendered?: string;
	/** Why there is no `served`. */
	problem?: string;
}

export interface MirrorReport {
	pages: MirroredPage[];
	/** Files saved besides the pages, by their path under the folder. */
	assets: { url: string; file: string; bytes: number }[];
	failed: { url: string; reason: string }[];
	/** Files left out because a limit was reached. */
	skipped: number;
	/** Their addresses, for a later crawl to fetch. */
	left: string[];
	/** How many of them the limit of files stopped, and how many the total size. */
	leftForCount: number;
	leftForSize: number;
	/** Files over the size one file may have; they are in `failed` too. */
	tooLarge: number;
	/** Files an earlier crawl had already saved. */
	reused: number;
	bytes: number;
}

const HTML_EXTENSION = /\.(?:html?|xhtml)$/i;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;
/** `rel` values of a `<link>` that name a file the page uses. */
const LINK_RELS =
	/\b(?:stylesheet|icon|apple-touch-icon(?:-precomposed)?|mask-icon|manifest|preload|modulepreload|prefetch)\b/i;
const CONTENT_TYPE_EXTENSION: Record<string, string> = {
	"text/css": ".css",
	"text/javascript": ".js",
	"application/javascript": ".js",
	"application/json": ".json",
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/avif": ".avif",
	"image/svg+xml": ".svg",
	"image/x-icon": ".ico",
	"image/vnd.microsoft.icon": ".ico",
	"font/woff": ".woff",
	"font/woff2": ".woff2",
	"font/ttf": ".ttf",
	"font/otf": ".otf",
};
const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function segment(raw: string): string {
	let part: string;
	try {
		part = decodeURIComponent(raw);
	} catch {
		part = raw;
	}
	// What no Windows file name may hold, and what would climb out.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what a file name cannot hold
	part = part.replace(/[<>:"|?*\\/\u0000-\u001f]+/g, "-").replace(/[. ]+$/, "");
	if (part === "" || part === "." || part === "..") return "";
	if (WINDOWS_RESERVED.test(part)) part = `_${part}`;
	return part.length > 120 ? part.slice(0, 120) : part;
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Where a page or a file of a site goes under the folder: its host, then its
 * path as the site has it. A page always ends in `.html`; a path ending in `/`
 * is that folder's `index.html`. A page's query is part of its name, since two
 * queries are two pages; a file's is not, since it is nearly always a cache
 * stamp on one file.
 */
export function mirrorPath(
	url: string,
	kind: "page" | "asset",
	contentType?: string,
): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return undefined;
	}
	const host = segment(parsed.host) || "site";
	const folderLike = parsed.pathname.endsWith("/");
	const parts = parsed.pathname.split("/").map(segment).filter(Boolean);
	let name = folderLike || parts.length === 0 ? "" : (parts.pop() as string);
	if (kind === "page") {
		if (name === "") name = "index.html";
		else if (!HTML_EXTENSION.test(name)) name = `${name}.html`;
		if (parsed.search) {
			name = name.replace(
				HTML_EXTENSION,
				(extension) => `-${shortHash(parsed.search)}${extension}`,
			);
		}
	} else {
		if (name === "") name = "index";
		if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) {
			const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
			name += (type && CONTENT_TYPE_EXTENSION[type]) || "";
		}
	}
	return [host, ...parts, name].join("/");
}

/** `X.html` as `X.rendered.html`. */
export function renderedPath(served: string): string {
	return served.replace(HTML_EXTENSION, (extension) => `.rendered${extension}`);
}

function decodeAttribute(value: string): string {
	return value
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.trim();
}

function absolute(link: string, base: string): string | undefined {
	const raw = decodeAttribute(link);
	if (
		!raw ||
		raw.startsWith("#") ||
		/^(?:data|blob|javascript|mailto|tel|about):/i.test(raw)
	) {
		return undefined;
	}
	try {
		const url = new URL(raw, base);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

/** The files a stylesheet needs: what it imports, and every `url(...)`. */
export function cssLinks(css: string, base: string): string[] {
	const found = new Set<string>();
	for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
		const link = absolute(match[2] ?? "", base);
		if (link) found.add(link);
	}
	for (const match of css.matchAll(/@import\s+(['"])([^'"]+)\1/gi)) {
		const link = absolute(match[2] ?? "", base);
		if (link) found.add(link);
	}
	return [...found];
}

/**
 * The files a page needs to look and behave as it does: stylesheets, scripts,
 * pictures, fonts, icons, media. Not the pages it links to.
 */
export function assetLinks(html: string, pageUrl: string): string[] {
	const baseTag = /<base\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1/i.exec(html);
	const base = (baseTag && absolute(baseTag[2] ?? "", pageUrl)) || pageUrl;
	const found = new Set<string>();
	const add = (link: string | undefined) => {
		const url = link ? absolute(link, base) : undefined;
		if (url) found.add(url);
	};
	const attribute = (tag: string, name: string): string | undefined =>
		new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i").exec(tag)?.[2];
	for (const match of html.matchAll(
		/<(script|img|source|video|audio|embed|track|input|iframe)\b[^>]*>/gi,
	)) {
		const tag = match[0];
		// A frame is another page, not a file of this one.
		if (match[1]?.toLowerCase() !== "iframe") {
			add(attribute(tag, "src"));
			add(attribute(tag, "data-src"));
			add(attribute(tag, "poster"));
		}
		for (const set of [
			attribute(tag, "srcset"),
			attribute(tag, "data-srcset"),
		]) {
			for (const entry of (set ?? "").split(",")) {
				add(entry.trim().split(/\s+/)[0]);
			}
		}
	}
	for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
		const tag = match[0];
		if (LINK_RELS.test(attribute(tag, "rel") ?? "")) {
			add(attribute(tag, "href"));
			for (const entry of (attribute(tag, "imagesrcset") ?? "").split(",")) {
				add(entry.trim().split(/\s+/)[0]);
			}
		}
	}
	for (const match of html.matchAll(/<object\b[^>]*>/gi)) {
		add(attribute(match[0], "data"));
	}
	for (const match of html.matchAll(/<(?:use|image)\b[^>]*>/gi)) {
		add(attribute(match[0], "href") ?? attribute(match[0], "xlink:href"));
	}
	for (const match of html.matchAll(
		/<meta\b[^>]*\b(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]*>/gi,
	)) {
		add(attribute(match[0], "content"));
	}
	// Styles written into the page: `<style>` blocks and `style` attributes.
	for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
		for (const link of cssLinks(match[1] ?? "", base)) found.add(link);
	}
	for (const match of html.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) {
		for (const link of cssLinks(decodeAttribute(match[2] ?? ""), base)) {
			found.add(link);
		}
	}
	return [...found];
}

interface Fetched {
	bytes: Buffer;
	contentType: string;
}

async function get(
	url: string,
	options: MirrorOptions,
	most: number,
): Promise<Fetched> {
	const send = options.fetch ?? fetch;
	const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeout])
		: timeout;
	const response = await send(url, {
		redirect: "follow",
		signal,
		headers: { "user-agent": USER_AGENT, accept: "*/*" },
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error(`the site answered HTTP ${response.status}`);
	}
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > most) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error(
			`${Math.round(declared / 1_048_576)} MB, over the limit for one file`,
		);
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.length > most) {
		throw new Error(
			`${Math.round(bytes.length / 1_048_576)} MB, over the limit for one file`,
		);
	}
	return { bytes, contentType: response.headers.get("content-type") ?? "" };
}

/**
 * Write under the folder, never over a folder and never outside it. A site
 * can have both `/a` and `/a/b`: a file `a` already saved moves aside to
 * `a.file` when the folder `a` is needed, and a file arriving where a folder
 * stands is saved as `a.file` itself.
 */
async function writeUnder(
	root: string,
	relative: string,
	data: Buffer | string,
	moved?: (from: string, to: string) => void,
): Promise<string> {
	const parts = relative.split("/");
	// A file standing where one of this path's folders has to be.
	for (let depth = 1; depth < parts.length; depth += 1) {
		const ancestor = parts.slice(0, depth).join("/");
		const at = path.resolve(root, ...parts.slice(0, depth));
		const stat = await fs.stat(at).catch(() => undefined);
		if (stat?.isFile()) {
			await fs.rename(at, `${at}.file`);
			moved?.(ancestor, `${ancestor}.file`);
		}
	}
	for (const candidate of [relative, `${relative}.file`]) {
		const target = path.resolve(root, ...candidate.split("/"));
		if (path.relative(root, target).startsWith("..")) break;
		try {
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(target, data);
			return candidate;
		} catch {
			// A folder stands where this file would go.
		}
	}
	throw new Error("no place for it under the folder");
}

function reason(error: unknown): string {
	if (error instanceof Error) {
		return error.name === "TimeoutError" ? "no answer in time" : error.message;
	}
	return String(error);
}

/**
 * Save `pages` and every file they need under `options.root`.
 *
 * Never throws for a page or a file that could not be had: each is in the
 * report with its reason. Throws only when the run is aborted.
 */
export async function mirrorSite(
	pages: readonly MirrorPage[],
	options: MirrorOptions,
): Promise<MirrorReport> {
	const maxAssets = options.maxAssets ?? 2000;
	const maxAssetBytes = options.maxAssetBytes ?? 25 * 1_048_576;
	const maxTotalBytes = options.maxTotalBytes ?? 300 * 1_048_576;
	const report: MirrorReport = {
		pages: [],
		assets: [],
		failed: [],
		skipped: 0,
		left: [],
		leftForCount: 0,
		leftForSize: 0,
		tooLarge: 0,
		reused: 0,
		bytes: 0,
	};
	const pageUrls = new Set(pages.map((page) => page.url.replace(/#.*$/, "")));
	/** Files to fetch, with how many stylesheets deep they were found. */
	const queue: { url: string; depth: number }[] = [];
	const seen = new Set<string>();
	let queued = 0;
	const want = (url: string, depth: number) => {
		if (seen.has(url) || pageUrls.has(url)) return;
		seen.add(url);
		if (options.have?.(url) !== undefined) {
			report.reused += 1;
			return;
		}
		if (queued >= maxAssets) {
			report.skipped += 1;
			report.leftForCount += 1;
			report.left.push(url);
			return;
		}
		queued += 1;
		queue.push({ url, depth });
	};
	for (const url of options.also ?? []) want(url, 0);
	let done = 0;
	const progress = () => options.onProgress?.(done, pages.length + queued);

	const savePage = async (page: MirrorPage) => {
		const relative = mirrorPath(page.url, "page");
		if (!relative) {
			report.failed.push({ url: page.url, reason: "not an http address" });
			return;
		}
		const entry: MirroredPage = { url: page.url };
		let served: string | undefined;
		try {
			const got = await get(page.url, options, maxAssetBytes);
			entry.served = await writeUnder(options.root, relative, got.bytes);
			report.bytes += got.bytes.length;
			served = got.bytes.toString("utf8");
		} catch (error) {
			options.signal?.throwIfAborted();
			entry.problem = reason(error);
		}
		if (page.rawHtml) {
			// With no served copy, the rendered one takes the page's own name.
			entry.rendered = await writeUnder(
				options.root,
				entry.served ? renderedPath(relative) : relative,
				page.rawHtml,
			);
			report.bytes += Buffer.byteLength(page.rawHtml);
		}
		if (!entry.served && !entry.rendered) {
			report.failed.push({
				url: page.url,
				reason: entry.problem ?? "nothing to save",
			});
		}
		report.pages.push(entry);
		for (const html of [served, page.rawHtml]) {
			for (const link of html ? assetLinks(html, page.url) : []) want(link, 0);
		}
		done += 1;
		progress();
	};

	const saveAsset = async (item: { url: string; depth: number }) => {
		if (report.bytes >= maxTotalBytes) {
			report.skipped += 1;
			report.leftForSize += 1;
			report.left.push(item.url);
			return;
		}
		try {
			const got = await get(item.url, options, maxAssetBytes);
			const relative = mirrorPath(item.url, "asset", got.contentType);
			if (!relative) throw new Error("not an http address");
			const file = await writeUnder(
				options.root,
				relative,
				got.bytes,
				(from, to) => {
					for (const asset of report.assets) {
						if (asset.file === from) asset.file = to;
					}
				},
			);
			report.bytes += got.bytes.length;
			report.assets.push({ url: item.url, file, bytes: got.bytes.length });
			// A stylesheet's fonts and pictures, and what it imports, two deep.
			if (
				item.depth < 2 &&
				(/css/i.test(got.contentType) || /\.css$/i.test(relative))
			) {
				for (const link of cssLinks(got.bytes.toString("utf8"), item.url)) {
					want(link, item.depth + 1);
				}
			}
		} catch (error) {
			options.signal?.throwIfAborted();
			const why = reason(error);
			if (why.includes("over the limit for one file")) report.tooLarge += 1;
			report.failed.push({ url: item.url, reason: why });
		}
		done += 1;
		progress();
	};

	const workers = Math.max(1, options.concurrency ?? 6);
	const drain = async <T>(items: T[], work: (item: T) => Promise<void>) => {
		await Promise.all(
			Array.from({ length: workers }, async () => {
				for (;;) {
					options.signal?.throwIfAborted();
					const item = items.shift();
					if (item === undefined) return;
					await work(item);
				}
			}),
		);
	};
	await drain([...pages], savePage);
	// Stylesheets add to the queue while it drains, so drain until it stays empty.
	while (queue.length > 0) {
		await drain(queue, saveAsset);
	}
	return report;
}

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assetLinks,
	cssLinks,
	mirrorPath,
	mirrorSite,
	renderedPath,
} from "./web-mirror";

describe("where a mirrored file goes", () => {
	it("keeps the site's own paths, and ends every page in .html", () => {
		expect(mirrorPath("https://example.com/", "page")).toBe(
			"example.com/index.html",
		);
		expect(mirrorPath("https://example.com/docs/", "page")).toBe(
			"example.com/docs/index.html",
		);
		expect(mirrorPath("https://example.com/docs/intro", "page")).toBe(
			"example.com/docs/intro.html",
		);
		expect(mirrorPath("https://example.com/a/b.htm", "page")).toBe(
			"example.com/a/b.htm",
		);
		expect(mirrorPath("https://example.com/assets/app-C1.js", "asset")).toBe(
			"example.com/assets/app-C1.js",
		);
		expect(renderedPath("example.com/index.html")).toBe(
			"example.com/index.rendered.html",
		);
	});

	it("tells two queries of a page apart, and drops a file's cache stamp", () => {
		const one = mirrorPath("https://example.com/list?page=1", "page");
		const two = mirrorPath("https://example.com/list?page=2", "page");
		expect(one).toMatch(/^example\.com\/list-[0-9a-f]{8}\.html$/);
		expect(one).not.toBe(two);
		expect(mirrorPath("https://example.com/site.css?v=3", "asset")).toBe(
			"example.com/site.css",
		);
	});

	it("names a file with no extension after what it is", () => {
		expect(
			mirrorPath(
				"https://fonts.example/css2",
				"asset",
				"text/css; charset=utf-8",
			),
		).toBe("fonts.example/css2.css");
	});

	it("never climbs out, and never uses a name Windows refuses", () => {
		const climbing = mirrorPath(
			"https://example.com/a/%2e%2e/%2e%2e/x.js",
			"asset",
		);
		// The address itself resolves the dots; the file stays under its host.
		expect(climbing).toBe("example.com/x.js");
		expect(mirrorPath("https://example.com/con/a:b*c.png", "asset")).toBe(
			"example.com/_con/a-b-c.png",
		);
		expect(mirrorPath("ftp://example.com/x", "asset")).toBeUndefined();
		expect(mirrorPath("not a url", "page")).toBeUndefined();
	});
});

describe("the files a page uses", () => {
	it("finds stylesheets, scripts, pictures, fonts and media, not the pages it links to", () => {
		const html = `
			<link rel="stylesheet" href="/css/site.css">
			<link rel="icon" href="favicon.ico">
			<link rel="canonical" href="https://example.com/">
			<link rel="preload" as="font" href="/fonts/a.woff2">
			<script src="/assets/app.js?v=1&amp;x=2"></script>
			<img src="/img/a.png" srcset="/img/a-2x.png 2x, /img/a-3x.png 3x">
			<video poster="/img/poster.jpg"><source src="/media/clip.mp4"></video>
			<a href="/docs/intro">docs</a>
			<iframe src="/embed/other-page"></iframe>
			<div style="background:url(&quot;/img/bg.png&quot;)"></div>
			<style>@import "/css/extra.css"; .x{background:url(data:image/png;base64,AAA)}</style>
			<meta property="og:image" content="https://cdn.example/og.png">
			<svg><use href="/sprite.svg#icon"></use><use href="#local"></use></svg>`;
		expect(assetLinks(html, "https://example.com/docs/").sort()).toEqual(
			[
				"https://cdn.example/og.png",
				"https://example.com/assets/app.js?v=1&x=2",
				"https://example.com/css/extra.css",
				"https://example.com/css/site.css",
				"https://example.com/docs/favicon.ico",
				"https://example.com/fonts/a.woff2",
				"https://example.com/img/a-2x.png",
				"https://example.com/img/a-3x.png",
				"https://example.com/img/a.png",
				"https://example.com/img/bg.png",
				"https://example.com/img/poster.jpg",
				"https://example.com/media/clip.mp4",
				"https://example.com/sprite.svg",
			].sort(),
		);
	});

	it("resolves against the page's base when it names one", () => {
		expect(
			assetLinks(
				'<base href="https://static.example/v2/"><script src="app.js"></script>',
				"https://example.com/",
			),
		).toEqual(["https://static.example/v2/app.js"]);
	});

	it("reads a stylesheet's imports and urls relative to the stylesheet", () => {
		expect(
			cssLinks(
				"@import 'base.css'; @font-face{src:url(../fonts/a.woff2) format('woff2')} .x{background:url(\"data:x\")}",
				"https://example.com/css/site.css",
			).sort(),
		).toEqual([
			"https://example.com/css/base.css",
			"https://example.com/fonts/a.woff2",
		]);
	});
});

describe("mirroring a site", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "web-mirror-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const site = (files: Record<string, string>) => {
		const asked: string[] = [];
		const send = (async (input: string | URL | Request) => {
			const url = String(input);
			asked.push(url);
			const body = files[url];
			return body === undefined
				? new Response("no", { status: 404 })
				: new Response(body, {
						headers: {
							"content-type": url.endsWith(".css") ? "text/css" : "text/html",
						},
					});
		}) as typeof fetch;
		return { asked, send };
	};

	it("fetches each file once, however many pages use it", async () => {
		const page = '<link rel="stylesheet" href="/site.css"><img src="/a.png">';
		const { asked, send } = site({
			"https://example.com/": page,
			"https://example.com/two": page,
			"https://example.com/site.css": "body{}",
			"https://example.com/a.png": "PNG",
		});
		const report = await mirrorSite(
			[{ url: "https://example.com/" }, { url: "https://example.com/two" }],
			{ root, fetch: send },
		);
		expect(asked.filter((url) => url.endsWith("site.css"))).toHaveLength(1);
		expect(report.assets.map((asset) => asset.file).sort()).toEqual([
			"example.com/a.png",
			"example.com/site.css",
		]);
		expect(report.pages.map((page) => page.served).sort()).toEqual([
			"example.com/index.html",
			"example.com/two.html",
		]);
		expect(readFileSync(join(root, "example.com", "two.html"), "utf8")).toBe(
			page,
		);
		expect(report.failed).toEqual([]);
	});

	it("stops at the file limit and says how many it left", async () => {
		const { send } = site({
			"https://example.com/":
				'<img src="/1.png"><img src="/2.png"><img src="/3.png">',
			"https://example.com/1.png": "1",
			"https://example.com/2.png": "2",
			"https://example.com/3.png": "3",
		});
		const report = await mirrorSite([{ url: "https://example.com/" }], {
			root,
			fetch: send,
			maxAssets: 2,
		});
		expect(report.assets).toHaveLength(2);
		expect(report.skipped).toBe(1);
	});

	it("refuses a file over the size limit and carries on", async () => {
		const { send } = site({
			"https://example.com/": '<img src="/big.png"><img src="/small.png">',
			"https://example.com/big.png": "x".repeat(5000),
			"https://example.com/small.png": "ok",
		});
		const report = await mirrorSite([{ url: "https://example.com/" }], {
			root,
			fetch: send,
			maxAssetBytes: 1000,
		});
		expect(report.assets.map((asset) => asset.file)).toEqual([
			"example.com/small.png",
		]);
		expect(report.failed[0]?.reason).toContain("over the limit");
	});

	it("gives a file way to a folder of the same name", async () => {
		const { send } = site({
			"https://example.com/": '<img src="/a"><img src="/a/b.png">',
			"https://example.com/a": "A",
			"https://example.com/a/b.png": "B",
		});
		const report = await mirrorSite([{ url: "https://example.com/" }], {
			root,
			fetch: send,
			concurrency: 1,
		});
		expect(report.failed).toEqual([]);
		expect(report.assets.map((asset) => asset.file).sort()).toEqual([
			"example.com/a.file",
			"example.com/a/b.png",
		]);
		expect(readFileSync(join(root, "example.com", "a.file"), "utf8")).toBe("A");
	});
});

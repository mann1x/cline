import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryScrapeConfig } from "./library-tools";
import {
	createWebScrapeTool,
	createWebScrapeTools,
	pageFileName,
	workspacePath,
} from "./web-scrape-tool";

const CONTEXT = { agentId: "a", conversationId: "c", iteration: 1 } as never;

const PAGES: Record<string, string> = {
	"https://example.com/": "<h1>Home</h1><p>Welcome.</p>",
	"https://example.com/docs/intro.html":
		"<h1>Intro</h1><h2>Setup</h2><p>Install it.</p>",
	"https://example.com/docs/api?v=2": "<h1>API</h1><p>Calls.</p>",
};

let pages: Record<string, string>;
/** What each page links to, as the endpoint reports it. */
let links: Record<string, string[]>;
let mapped: string[];

let root: string;
let crawlBody: Record<string, unknown> | undefined;
let scrape: LibraryScrapeConfig | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "web-scrape-"));
	crawlBody = undefined;
	pages = { ...PAGES };
	links = {};
	mapped = [];
	scrape = {
		baseUrl: "http://scrape.test",
		maxPages: 2,
		maxDepth: 3,
		librarianOnly: false,
	};
	vi.stubGlobal("fetch", (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = String(input);
		const body = JSON.parse(String(init?.body ?? "{}"));
		const entry = (link: string) => ({
			html: pages[link],
			links: links[link] ?? [],
			metadata: { sourceURL: link, title: `Title of ${link}`, statusCode: 200 },
		});
		if (url.endsWith("/v2/scrape")) {
			return Response.json({ success: true, data: entry(body.url) });
		}
		if (url.endsWith("/v2/map")) {
			return Response.json({ success: true, links: mapped });
		}
		if (url.endsWith("/v2/crawl")) {
			crawlBody = body;
			return Response.json({ success: true, id: "job1" });
		}
		if (url.includes("/v2/crawl/job1")) {
			const skip = Number(new URL(url).searchParams.get("skip"));
			const all = Object.keys(pages)
				.slice(0, Number(crawlBody?.limit))
				.map(entry);
			return Response.json({
				success: true,
				status: "completed",
				completed: all.length,
				total: all.length,
				data: all.slice(skip),
			});
		}
		return Response.json(
			{ success: false, error: "unexpected" },
			{ status: 404 },
		);
	}) as typeof fetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(root, { recursive: true, force: true });
});

const general = () =>
	createWebScrapeTool({ cwd: root, getScrape: () => scrape, general: true });
const run = async (input: Record<string, unknown>) =>
	String(await general().execute(input, CONTEXT));

describe("web_scrape for any task", () => {
	it("is offered only when scraping is set up and not kept for the librarian", () => {
		const offered = () =>
			createWebScrapeTools({ cwd: root, getScrape: () => scrape }).map(
				(tool) => tool.name,
			);
		expect(offered()).toEqual(["web_scrape"]);
		scrape = { ...(scrape as LibraryScrapeConfig), librarianOnly: true };
		expect(offered()).toEqual([]);
		// A config that does not say is the librarian's: the default.
		const { librarianOnly: _only, ...unsaid } = scrape;
		scrape = unsaid;
		expect(offered()).toEqual([]);
		scrape = undefined;
		expect(offered()).toEqual([]);
	});

	it("offers crawl and save_to on the general tool only", () => {
		const actions = (tool: { inputSchema: unknown }) =>
			(
				tool.inputSchema as {
					properties: { action: { enum: string[] }; save_to?: unknown };
				}
			).properties;
		expect(actions(general()).action.enum).toContain("crawl");
		expect(actions(general()).save_to).toBeDefined();
		const librarian = createWebScrapeTool({
			cwd: root,
			getScrape: () => scrape,
		});
		expect(actions(librarian).action.enum).toEqual(["search", "map", "read"]);
		expect(actions(librarian).save_to).toBeUndefined();
		expect(librarian.readOnly).toBe(true);
		expect(general().readOnly).toBeFalsy();
	});

	it("crawls a site into markdown files, held to the user's ceiling", async () => {
		const report = await run({
			action: "crawl",
			url: "https://example.com/",
			limit: 50,
			depth: 9,
			include_paths: ["^/docs/"],
			whole_site: true,
			save_to: "site",
		});
		// Asked for 50 pages and depth 9; the settings allow 2 and 3.
		expect(crawlBody).toMatchObject({
			url: "https://example.com/",
			limit: 2,
			maxDiscoveryDepth: 3,
			includePaths: ["^/docs/"],
			crawlEntireDomain: true,
		});
		expect(report).toContain(
			"2 pages of https://example.com/ written under site/",
		);
		expect(report).toContain("The page limit was reached");
		const intro = readFileSync(
			join(root, "site", "example.com", "docs", "intro.md"),
			"utf8",
		);
		expect(intro).toContain('url: "https://example.com/docs/intro.html"');
		expect(intro).toContain("# Intro");
		const index = readFileSync(join(root, "site", "index.md"), "utf8");
		expect(index).toContain("](example.com/index.md)");
		expect(index).toContain("](example.com/docs/intro.md)");
		// The pages themselves are not returned.
		expect(report).not.toContain("Install it.");
	});

	it("says a site of one page is one, instead of an empty map", async () => {
		links["https://example.com/"] = [
			"https://github.com/x/y",
			"https://discord.gg/z",
			"https://example.com/#top",
		];
		const report = await run({ action: "map", url: "https://example.com" });
		expect(report).toContain("is a site of one page");
		expect(report).toContain("github.com, discord.gg");
		expect(report).toContain("nothing more to map");
		// A map that missed pages the front page links to lists them.
		links["https://example.com/"] = ["https://example.com/docs/intro.html"];
		expect(await run({ action: "map", url: "https://example.com" })).toContain(
			"links to 1 page of the same site:\nhttps://example.com/docs/intro.html",
		);
	});

	it("says why a crawl ended before its limit", async () => {
		scrape = { ...(scrape as LibraryScrapeConfig), maxPages: 100 };
		const only = { "https://example.com/": pages["https://example.com/"] };
		for (const link of Object.keys(pages)) {
			if (!(link in only)) delete pages[link];
		}
		links["https://example.com/"] = ["https://github.com/x/y"];
		const whole = await run({
			action: "crawl",
			url: "https://example.com/",
			save_to: "one",
		});
		expect(whole).toContain(
			"1 page of https://example.com/ written under one/",
		);
		expect(whole).toContain("That is the whole site from this address");
		expect(whole).toContain(
			"Links to other sites (github.com) are not followed.",
		);
		expect(whole).toContain("do not need reading back");
		// Pages of the site that were linked and not read are named.
		links["https://example.com/"] = ["https://example.com/blog/a"];
		const short = await run({
			action: "crawl",
			url: "https://example.com/",
			depth: 0,
			save_to: "two",
		});
		expect(short).toContain(
			"1 more page of this site is linked and was not read",
		);
		expect(short).toContain("https://example.com/blog/a");
		expect(short).toContain("`whole_site` follows those");
	});

	it("needs a folder inside the workspace to crawl into", async () => {
		expect(
			await run({ action: "crawl", url: "https://example.com/" }),
		).toContain("needs `save_to`");
		expect(
			await run({
				action: "crawl",
				url: "https://example.com/",
				save_to: "../outside",
			}),
		).toContain("inside the workspace");
		expect(crawlBody).toBeUndefined();
	});

	it("reads a page into a file and returns its outline", async () => {
		const report = await run({
			action: "read",
			url: "https://example.com/docs/intro.html",
			save_to: "notes/intro.md",
		});
		expect(report).toContain("Written to notes/intro.md.");
		expect(report).toContain("## Setup");
		expect(report).not.toContain("Install it.");
		expect(readFileSync(join(root, "notes", "intro.md"), "utf8")).toContain(
			"Install it.",
		);
	});

	it("does not crawl or save for the librarian's tool", async () => {
		const librarian = createWebScrapeTool({
			cwd: root,
			getScrape: () => scrape,
		});
		expect(
			String(
				await librarian.execute(
					{ action: "crawl", url: "https://example.com/", save_to: "x" },
					CONTEXT,
				),
			),
		).toContain('"search", "map" or "read"');
		const read = String(
			await librarian.execute(
				{
					action: "read",
					url: "https://example.com/docs/intro.html",
					save_to: "x.md",
				},
				CONTEXT,
			),
		);
		expect(read).toContain("Install it.");
		expect(() => readFileSync(join(root, "x.md"))).toThrow();
	});

	it("says scraping is not set up when it is not", async () => {
		scrape = undefined;
		expect(await run({ action: "search", query: "x" })).toContain("not set up");
	});

	it("names a page's file after its address, never twice the same", () => {
		const taken = new Set<string>(["index.md"]);
		expect(pageFileName("https://example.com/", taken)).toBe(
			"example.com/index.md",
		);
		expect(pageFileName("https://example.com/docs/intro.html", taken)).toBe(
			"example.com/docs/intro.md",
		);
		expect(pageFileName("https://example.com/docs/api?v=2", taken)).toBe(
			"example.com/docs/api-v-2.md",
		);
		expect(pageFileName("https://example.com/docs/Intro", taken)).toBe(
			"example.com/docs/Intro-2.md",
		);
		expect(
			pageFileName("https://example.com/a/../../etc", taken),
		).not.toContain("..");
	});

	it("keeps a save path inside the workspace", () => {
		expect(workspacePath(root, "site")).toBe(join(root, "site"));
		expect(workspacePath(root, "../x")).toBeUndefined();
		expect(workspacePath(root, "/etc/passwd")).toBeUndefined();
		expect(workspacePath(root, ".")).toBeUndefined();
	});
});

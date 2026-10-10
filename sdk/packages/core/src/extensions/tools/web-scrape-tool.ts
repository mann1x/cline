/**
 * `web_scrape`: the web through a Firecrawl endpoint.
 *
 * Two shapes of one tool. The librarian's looks at the web to choose what a
 * book is made from: search, map, read. The general one is offered to any
 * task when the user turns "Only for the librarian" off, and adds what a task
 * outside the Library needs: a crawl of a site, and saving what was read as
 * markdown files in the workspace -- a site to rework, notes to keep on disk.
 *
 * The lead's only: it is not in `DELEGATED_HOST_TOOLS`, so a delegated agent,
 * whose writes go through its overlay, is never handed a tool that writes to
 * the workspace directly.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AgentTool, createTool } from "@cline/shared";
import {
	crawlSite,
	mapSite,
	type ScrapedPage,
	scrapePage,
	searchWeb,
} from "../../services/retrieval/firecrawl";
import type { LibraryScrapeConfig } from "./library-tools";

export const WEB_SCRAPE_TOOL_NAME = "web_scrape";

export const NO_SCRAPER =
	"Web scraping is not set up for this session. The user sets the endpoint under Settings > Features and allows it in the API configuration; do not call this again in this task.";

export interface WebScrapeToolOptions {
	/** The folder saved pages are written under. */
	cwd: string;
	/** The endpoint and its limits, read on every call. Undefined: not set up. */
	getScrape: () => LibraryScrapeConfig | undefined;
	/** What stops the tool before the endpoint is asked, said to the model. */
	unavailable?: () => string | undefined;
	/** The general tool: `crawl`, and `save_to`. @default false, the librarian's */
	general?: boolean;
	onError?: (message: string, error: unknown) => void;
}

const LIBRARIAN_DESCRIPTION =
	'Look at the web before making a book from it. "search": find pages for a topic, with their titles and what they are about. "map": the pages of a site, by their links, without reading them. "read": one page as markdown, to judge whether it belongs in the book. Rendered in a browser, so pages built by JavaScript are read too. Use it to choose the links; library_web_book reads them into the Library.';

const GENERAL_DESCRIPTION =
	'Read the web through a browser, so pages built by JavaScript are read too. Asked to scrape, copy or download a site, `crawl` it with `save_to`: the result of a scrape is the files, and your reply says where they are. "search": find pages for a topic, with their titles and what they are about. "map": the pages of a site, by their links, without reading them. "read": one page as markdown; with `save_to` it is written to that file and only its outline is returned. "crawl": read a page and the pages it links to, as deep and as many as asked, and write each as a markdown file under the folder `save_to`, with an `index.md` listing them; the pages are not returned, read the files you need afterwards. A crawl stays below the address it starts from (from /docs/ it reads /docs/...), unless `whole_site` is true. Map a site before crawling it, to choose where to start, `include_paths` and a sensible `limit`.';

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown): string[] {
	return (Array.isArray(value) ? value : value == null ? [] : [value])
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** An http(s) address without its fragment, or nothing. */
export function cleanLink(link: string): string | undefined {
	try {
		const url = new URL(link.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

/** `target` under `cwd`, or nothing when it would leave the folder. */
export function workspacePath(cwd: string, target: string): string | undefined {
	const resolved = path.resolve(cwd, target);
	const relative = path.relative(cwd, resolved);
	return relative === "" ||
		relative.startsWith("..") ||
		path.isAbsolute(relative)
		? undefined
		: resolved;
}

/**
 * A page's file under the crawl's folder: its host and path, with what a
 * file name cannot hold replaced, so two pages of a site never collide and
 * the folder reads like the site.
 */
export function pageFileName(url: string, taken: Set<string>): string {
	let parsed: URL | undefined;
	try {
		parsed = new URL(url);
	} catch {
		parsed = undefined;
	}
	const clean = (part: string) =>
		part
			.replace(/\.(?:html?|php|aspx?)$/i, "")
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.replace(/^[-.]+|[-.]+$/g, "")
			.slice(0, 80);
	const parts = (parsed?.pathname ?? url)
		.split("/")
		.map((part) => {
			try {
				return clean(decodeURIComponent(part));
			} catch {
				return clean(part);
			}
		})
		.filter(Boolean);
	const query = parsed?.search ? clean(parsed.search) : "";
	if (parts.length === 0) parts.push("index");
	if (query) parts[parts.length - 1] = `${parts[parts.length - 1]}-${query}`;
	const base = [clean(parsed?.host ?? "site") || "site", ...parts].join("/");
	let name = `${base}.md`;
	for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
		name = `${base}-${n}.md`;
	}
	taken.add(name.toLowerCase());
	return name;
}

function pageFile(page: ScrapedPage): string {
	const quoted = (value: string) => JSON.stringify(value);
	return [
		"---",
		`url: ${quoted(page.url)}`,
		...(page.title ? [`title: ${quoted(page.title)}`] : []),
		...(page.description ? [`description: ${quoted(page.description)}`] : []),
		"---",
		"",
		page.markdown.trimEnd(),
		"",
	].join("\n");
}

/**
 * Where the links of the pages read lead: pages of the same site that were
 * not read, and other sites. It is what tells "the site has no more pages"
 * from "the crawl stopped short" -- the two read the same from a page count.
 */
export function linkCensus(
	pages: readonly ScrapedPage[],
	start: string,
): { unread: string[]; elsewhere: string[] } {
	let host = "";
	try {
		host = new URL(start).host.replace(/^www\./, "");
	} catch {
		// No host to compare with: every link counts as elsewhere.
	}
	const key = (link: string) => link.replace(/\/+$/, "");
	const read = new Set(pages.map((page) => key(page.url)));
	const unread = new Set<string>();
	const elsewhere = new Set<string>();
	for (const page of pages) {
		for (const raw of page.links ?? []) {
			const link = cleanLink(raw);
			if (!link) continue;
			const there = new URL(link).host.replace(/^www\./, "");
			if (there !== host) elsewhere.add(there);
			else if (!read.has(key(link))) unread.add(link);
		}
	}
	return { unread: [...unread], elsewhere: [...elsewhere] };
}

function sitesLine(hosts: readonly string[], most = 8): string {
	return hosts.length === 0
		? ""
		: ` (${hosts.slice(0, most).join(", ")}${hosts.length > most ? `, and ${hosts.length - most} more` : ""})`;
}

function outline(markdown: string, most = 40): string[] {
	const headings = markdown
		.split("\n")
		.filter((line) => /^#{1,3} \S/.test(line));
	return headings.length > most
		? [...headings.slice(0, most), `[${headings.length - most} more headings.]`]
		: headings;
}

export function createWebScrapeTool(options: WebScrapeToolOptions): AgentTool {
	const general = options.general === true;
	return createTool({
		name: WEB_SCRAPE_TOOL_NAME,
		description: general ? GENERAL_DESCRIPTION : LIBRARIAN_DESCRIPTION,
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: general
						? ["search", "map", "read", "crawl"]
						: ["search", "map", "read"],
				},
				query: { type: "string", description: "search: what to find." },
				url: {
					type: "string",
					description: general
						? "map: a site. read: a page. crawl: the page to start from."
						: "map: a site. read: a page.",
				},
				limit: {
					type: "integer",
					description: general
						? "search: results (default 10). map: links (default 200). crawl: pages read at most (default 25; the user's setting is the ceiling)."
						: "search: results (default 10). map: links (default 200).",
				},
				max_chars: {
					type: "integer",
					description: "read: how much of the page to return (default 12000).",
				},
				...(general
					? {
							depth: {
								type: "integer",
								description:
									"crawl: how many links deep from the starting page (default 1; the user's setting is the ceiling).",
							},
							include_paths: {
								type: "array",
								items: { type: "string" },
								description:
									'crawl: only paths matching these regular expressions, e.g. ["^/docs/"].',
							},
							exclude_paths: {
								type: "array",
								items: { type: "string" },
								description:
									"crawl: never paths matching these regular expressions.",
							},
							whole_site: {
								type: "boolean",
								description:
									"crawl: follow links anywhere on the site, not only below the starting address (default false).",
							},
							save_to: {
								type: "string",
								description:
									"crawl: the folder the pages are written under, relative to the workspace (required). read: a file to write the page to (optional).",
							},
						}
					: {}),
			},
			required: ["action"],
		},
		// The general tool writes files; the librarian's only looks.
		readOnly: !general,
		timeoutMs: general ? 30 * 60_000 : 5 * 60_000,
		retryable: false,
		execute: async (input: unknown, context): Promise<string> => {
			const stopped = options.unavailable?.();
			if (stopped) return stopped;
			const scrape = options.getScrape();
			if (!scrape) return NO_SCRAPER;
			const request = (input ?? {}) as Record<string, unknown>;
			const action = text(request.action);
			const limit = Number(request.limit);
			const signal = context?.signal;
			const actions = general
				? '"search", "map", "read" or "crawl"'
				: '"search", "map" or "read"';
			try {
				if (action === "search") {
					const query = text(request.query);
					if (!query) return "`search` needs a `query`.";
					const hits = await searchWeb(scrape, query, {
						limit:
							Number.isFinite(limit) && limit > 0 ? Math.min(50, limit) : 10,
						...(signal ? { signal } : {}),
					});
					if (hits.length === 0) return `Nothing found for "${query}".`;
					return [
						`${plural(hits.length, "result")} for "${query}":`,
						...hits.map(
							(hit) =>
								`- ${hit.url}\n  ${hit.title ?? ""}${hit.description ? ` — ${hit.description.slice(0, 240)}` : ""}`,
						),
					].join("\n");
				}
				if (action !== "map" && action !== "read" && action !== "crawl") {
					return `Say \`action\`: ${actions}.`;
				}
				if (action === "crawl" && !general) {
					return `Say \`action\`: ${actions}.`;
				}
				const url = cleanLink(text(request.url));
				if (!url)
					return `\`${action}\` needs a \`url\` starting with http:// or https://.`;
				if (action === "map") {
					const links = await mapSite(scrape, url, {
						limit:
							Number.isFinite(limit) && limit > 0 ? Math.min(2000, limit) : 200,
						...(signal ? { signal } : {}),
					});
					if (links.length === 0) {
						// A site with one page maps to nothing. Its own links say
						// whether that is what this is.
						const page = await scrapePage(scrape, url, {
							links: true,
							...(signal ? { signal } : {}),
						}).catch(() => undefined);
						if (!page) {
							return `No pages found for ${url}, and the page itself could not be read. Check the address.`;
						}
						const census = linkCensus([page], url);
						if (census.unread.length > 0) {
							return [
								`The site's map is empty, but ${url} links to ${plural(census.unread.length, "page")} of the same site:`,
								...census.unread.slice(0, 200),
							].join("\n");
						}
						return `${url} is a site of one page: it links to no other page of its own.${
							census.elsewhere.length
								? ` Its ${plural(census.elsewhere.length, "other link")} go to other sites${sitesLine(census.elsewhere)}.`
								: ""
						} Read it${general ? ", or crawl it to save it" : ""}; there is nothing more to map.`;
					}
					return [`${plural(links.length, "page")} of ${url}:`, ...links].join(
						"\n",
					);
				}
				const saveTo = general ? text(request.save_to) : "";
				const target = saveTo ? workspacePath(options.cwd, saveTo) : undefined;
				if (saveTo && !target) {
					return `\`save_to\` has to be a path inside the workspace; "${saveTo}" is not.`;
				}
				if (action === "read") {
					const page = await scrapePage(scrape, url, {
						...(signal ? { signal } : {}),
					});
					const head = `${page.url}${page.title ? ` — ${page.title}` : ""} (${page.markdown.length.toLocaleString("en-US")} characters)`;
					if (target) {
						await fs.mkdir(path.dirname(target), { recursive: true });
						await fs.writeFile(target, pageFile(page), "utf8");
						return [
							head,
							`Written to ${path.relative(options.cwd, target).split(path.sep).join("/")}.`,
							...outline(page.markdown),
						].join("\n");
					}
					const max = Number(request.max_chars);
					const cut = Number.isFinite(max) && max > 0 ? max : 12_000;
					return [
						head,
						"---",
						page.markdown.slice(0, cut),
						...(page.markdown.length > cut
							? [`[Cut at ${cut.toLocaleString("en-US")} characters.]`]
							: []),
					].join("\n");
				}
				// crawl
				if (!target) {
					return "`crawl` needs `save_to`: the folder the pages are written under, relative to the workspace.";
				}
				const depth = Number(request.depth);
				const asked = {
					limit: Math.max(
						1,
						Math.min(
							scrape.maxPages,
							Number.isFinite(limit) && limit > 0 ? Math.round(limit) : 25,
						),
					),
					depth: Math.max(
						0,
						Math.min(
							scrape.maxDepth,
							Number.isFinite(depth) && depth >= 0 ? Math.round(depth) : 1,
						),
					),
				};
				const include = strings(request.include_paths);
				const exclude = strings(request.exclude_paths);
				const started = Date.now();
				let lastUpdate = 0;
				const crawl = await crawlSite(scrape, url, {
					...asked,
					...(include.length ? { includePaths: include } : {}),
					...(exclude.length ? { excludePaths: exclude } : {}),
					...(request.whole_site === true ? { entireDomain: true } : {}),
					links: true,
					...(signal ? { signal } : {}),
					onProgress: (done, total) => {
						if (Date.now() - lastUpdate < 2000) return;
						lastUpdate = Date.now();
						context?.emitUpdate?.({
							status: `Crawling ${url}: ${done} of ${total} pages read, ${Math.round((Date.now() - started) / 1000)} s`,
						});
					},
				});
				// Fewer pages than asked for is either the whole site or a crawl
				// that stopped short; the links of what was read say which.
				const census = linkCensus(crawl.pages, url);
				const whyItEnded = (): string => {
					const elsewhere = census.elsewhere.length
						? ` Links to other sites${sitesLine(census.elsewhere)} are not followed.`
						: "";
					if (census.unread.length === 0) {
						return `That is the whole site from this address: every page of it that these pages link to was read.${elsewhere}`;
					}
					const wholeSite = request.whole_site === true;
					return `${plural(census.unread.length, "more page")} of this site ${census.unread.length === 1 ? "is" : "are"} linked and ${census.unread.length === 1 ? "was" : "were"} not read: ${
						wholeSite
							? `deeper than depth ${asked.depth}`
							: `deeper than depth ${asked.depth}, or not below ${url} (\`whole_site\` follows those)`
					}. For example ${census.unread.slice(0, 5).join(", ")}.${elsewhere}`;
				};
				await fs.mkdir(target, { recursive: true });
				const taken = new Set<string>(["index.md"]);
				const folder =
					path.relative(options.cwd, target).split(path.sep).join("/") || ".";
				const rows: string[] = [];
				let characters = 0;
				for (const page of crawl.pages) {
					const name = pageFileName(page.url, taken);
					const file = path.join(target, ...name.split("/"));
					await fs.mkdir(path.dirname(file), { recursive: true });
					await fs.writeFile(file, pageFile(page), "utf8");
					characters += page.markdown.length;
					rows.push(
						`- [${page.title || page.url}](${name}) — ${page.url} (${page.markdown.length.toLocaleString("en-US")} characters)`,
					);
				}
				const failed = crawl.failed.map(
					(failure) => `- ${failure.url}: ${failure.reason}`,
				);
				const summary = [
					`${plural(crawl.pages.length, "page")} of ${url} written under ${folder}/ (${characters.toLocaleString("en-US")} characters; depth ${asked.depth}, at most ${plural(asked.limit, "page")}).`,
					...(crawl.unfinished
						? [
								"The crawl was still running at the time limit: these are the pages read so far.",
							]
						: []),
					...(crawl.pages.length >= asked.limit
						? [
								`The page limit was reached, so the site may have more. The user's ceiling is ${plural(scrape.maxPages, "page")} and depth ${scrape.maxDepth}.`,
							]
						: crawl.unfinished
							? []
							: [whyItEnded()]),
					"Each page is saved whole, with its address and title at the top: the files do not need reading back to check them.",
				];
				await fs.writeFile(
					path.join(target, "index.md"),
					[
						`# ${url}`,
						"",
						...summary,
						"",
						...rows,
						...(failed.length ? ["", "## Not read", "", ...failed] : []),
						"",
					].join("\n"),
					"utf8",
				);
				if (crawl.pages.length === 0) {
					return [
						`No page of ${url} could be read.`,
						...(failed.length ? ["Not read:", ...failed.slice(0, 20)] : []),
					].join("\n");
				}
				const shown = 60;
				return [
					...summary,
					`The list is in ${folder}/index.md.`,
					...rows.slice(0, shown),
					...(rows.length > shown
						? [`[${rows.length - shown} more in index.md.]`]
						: []),
					...(failed.length
						? [
								`Not read (${failed.length}):`,
								...failed.slice(0, 20),
								...(failed.length > 20
									? [`[${failed.length - 20} more in index.md.]`]
									: []),
							]
						: []),
				].join("\n");
			} catch (error) {
				options.onError?.(`[web_scrape] ${action} failed`, error);
				return `Not done: ${errorText(error)}`;
			}
		},
	});
}

/**
 * The general tool, when scraping is set up, allowed, and not kept for the
 * librarian. Decided at session start, like every other tool list; the
 * endpoint itself is read again on every call.
 */
export function createWebScrapeTools(
	options: Omit<WebScrapeToolOptions, "general"> & {
		log?: (message: string) => void;
	},
): AgentTool[] {
	const scrape = options.getScrape();
	if (!scrape) {
		options.log?.("web_scrape omitted: scraping is not set up or not allowed");
		return [];
	}
	if (scrape.librarianOnly !== false) {
		options.log?.("web_scrape is the librarian's only");
		return [];
	}
	options.log?.("web_scrape offered to the task");
	return [createWebScrapeTool({ ...options, general: true })];
}

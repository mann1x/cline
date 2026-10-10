/**
 * `web_scrape`: the web through a Firecrawl endpoint.
 *
 * Two shapes of one tool. The librarian's looks at the web to choose what a
 * book is made from: search, map, read. The general one is offered to any
 * task when the user turns "Only for the librarian" off, and adds what a task
 * outside the Library needs: a crawl that saves a site into the workspace.
 * By default that is the site itself -- every page as it was served and as
 * the browser rendered it, with the stylesheets, scripts, pictures and fonts
 * it uses -- beside a markdown reading of each page; `content: "text"` keeps
 * the markdown alone, for notes.
 *
 * The lead's only: it is not in `DELEGATED_HOST_TOOLS`, so a delegated agent,
 * whose writes go through its overlay, is never handed a tool that writes to
 * the workspace directly.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AgentTool, createTool } from "@cline/shared";
import {
	mapSite,
	scrapePage,
	searchWeb,
} from "../../services/retrieval/firecrawl";
import type { LibraryScrapeConfig } from "./library-tools";
import {
	cleanLink,
	crawlToFolder,
	linkCensus,
	pageFile,
	plural,
	sitesLine,
} from "./web-site-crawl";

export { cleanLink, linkCensus, pageFileName } from "./web-site-crawl";

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
	/**
	 * A text file the tool wrote, by absolute path. The host forgets what it
	 * knew of the file, so a later read is not told that something outside the
	 * session changed it.
	 */
	onWrote?: (file: string) => void;
}

const LIBRARIAN_DESCRIPTION =
	'Look at the web before making a book from it. "search": find pages for a topic, with their titles and what they are about. "map": the pages of a site, by their links, without reading them. "read": one page as markdown, to judge whether it belongs in the book. Rendered in a browser, so pages built by JavaScript are read too. Use it to choose the links; library_web_book reads them into the Library.';

const GENERAL_DESCRIPTION =
	'Read the web through a browser, so pages built by JavaScript are read too. Asked to scrape, copy, mirror or download a site, `crawl` it with `save_to`: the result of a scrape is the files, and your reply says where they are. "search": find pages for a topic, with their titles and what they are about. "map": the pages of a site, by their links, without reading them. "read": one page as markdown; with `save_to` it is written to that file and only its outline is returned. "crawl": read a page and the pages it links to, as deep and as many as asked, and save them under the folder `save_to`. By default (`content` "site") that is the site itself, unaltered: each page as the site served it (`.html`) and as the browser rendered it (`.rendered.html`), every stylesheet, script, picture and font the pages use at the path the site has it, and a markdown reading of each page (`.md`); use it for a site that is to be reworked or used as the source of new pages. `content` "text" saves the markdown alone, for notes and reference. `index.md` lists everything; the files are not returned, read the ones you need afterwards. A crawl stays below the address it starts from (from /docs/ it reads /docs/...), unless `whole_site` is true. Map a site before crawling it, to choose where to start, `include_paths` and a sensible `limit`. The user sets how many pages and files, and how much, one crawl may fetch. When a crawl stops at one of those limits its result begins with NOT COMPLETE: do not report the scrape as complete, and tell the user what was left out and which setting raises it. A crawl can be continued: when the user asks for more, or says a limit was raised, `crawl` again with the same `save_to` and `resume` true reads the pages and fetches the files that are missing, and nothing that is already saved. Do not resume on your own to get past a limit, and do not fetch the missing files another way.';

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown): string[] {
	return (Array.isArray(value) ? value : value == null ? [] : [value])
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
							content: {
								type: "string",
								enum: ["site", "text"],
								description:
									'crawl: "site" (default) saves the pages unaltered with their stylesheets, scripts, pictures and fonts, and a markdown reading of each; "text" saves the markdown alone.',
							},
							whole_site: {
								type: "boolean",
								description:
									"crawl: follow links anywhere on the site, not only below the starting address (default false).",
							},
							resume: {
								type: "boolean",
								description:
									"crawl: continue the crawl already in `save_to` (default false). Reads the pages that were linked and not read, fetches the files a limit left out, and fetches nothing that is saved; `url` is not needed.",
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
				const url = cleanLink(text(request.url)) ?? "";
				const resume = action === "crawl" && request.resume === true;
				if (!url && !resume)
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
					// What `read` saves is a markdown reading. Written to a .js or
					// a .png it is a broken copy of that file, and the way a model
					// went around the user's file limit (pandorum, 2026-10-10).
					if (target && !/\.(md|markdown|txt)$/i.test(target)) {
						return `\`read\` saves a page as markdown, so \`save_to\` has to end in .md; "${saveTo}" would be a broken copy of the file it is named after. A site's own files (scripts, stylesheets, pictures, fonts) are saved by \`crawl\`, within the limits the user set.`;
					}
					const page = await scrapePage(scrape, url, {
						...(signal ? { signal } : {}),
					});
					const head = `${page.url}${page.title ? ` — ${page.title}` : ""} (${page.markdown.length.toLocaleString("en-US")} characters)`;
					if (target) {
						await fs.mkdir(path.dirname(target), { recursive: true });
						await fs.writeFile(target, pageFile(page), "utf8");
						options.onWrote?.(target);
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
					return "`crawl` needs `save_to`: the folder the site is saved under, relative to the workspace.";
				}
				return await crawlToFolder({
					scrape,
					url,
					target,
					folder:
						path.relative(options.cwd, target).split(path.sep).join("/") || ".",
					...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
					...(Number.isFinite(Number(request.depth)) && request.depth != null
						? { depth: Number(request.depth) }
						: {}),
					include: strings(request.include_paths),
					exclude: strings(request.exclude_paths),
					...(typeof request.whole_site === "boolean"
						? { wholeSite: request.whole_site }
						: {}),
					...(text(request.content)
						? { content: text(request.content) === "text" ? "text" : "site" }
						: {}),
					resume,
					...(signal ? { signal } : {}),
					emit: (status) => context?.emitUpdate?.({ status }),
					...(options.onWrote ? { wrote: options.onWrote } : {}),
				});
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

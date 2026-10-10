/**
 * A Firecrawl endpoint, as the Library's scraper uses it: one page, a crawl
 * from a page outwards, the links of a site, and a web search.
 *
 * Pages are asked for as HTML and turned into markdown here. Firecrawl's own
 * markdown loses fenced code blocks, which is most of what a book made from
 * documentation is for.
 */

import { createHash } from "node:crypto";

export interface ScrapeEndpoint {
	/** The endpoint's address: `http://host:3002`. */
	baseUrl: string;
	apiKey?: string;
}

export interface ScrapedPage {
	url: string;
	title?: string;
	description?: string;
	language?: string;
	markdown: string;
	/** A hash of the markdown: whether the page changed since it was last read. */
	sha256: string;
	/** The links on the page, when they were asked for. */
	links?: string[];
}

export interface ScrapeFailure {
	url: string;
	reason: string;
}

export interface CrawlOptions {
	/** Pages read, at most. */
	limit: number;
	/** How many links deep from the starting page. */
	depth: number;
	/** Only paths matching these (regular expressions), when given. */
	includePaths?: readonly string[];
	excludePaths?: readonly string[];
	/**
	 * Follow links anywhere on the site. Without it a crawl stays below the
	 * address it starts from: from `/docs/intro` it never reaches `/docs/api`.
	 */
	entireDomain?: boolean;
	/** Also give each page's links, to tell what a crawl left unread. */
	links?: boolean;
	signal?: AbortSignal;
	fetch?: typeof fetch;
	/** How long to wait for the crawl. @default 20 minutes */
	timeoutMs?: number;
	onProgress?: (done: number, total: number) => void;
}

export interface CrawlResult {
	pages: ScrapedPage[];
	failed: ScrapeFailure[];
	/** Set when the crawl was still running at the time limit. */
	unfinished?: boolean;
}

export interface WebSearchHit {
	url: string;
	title?: string;
	description?: string;
}

interface RequestOptions {
	signal?: AbortSignal;
	fetch?: typeof fetch;
}

export class ScrapeError extends Error {}

function root(endpoint: ScrapeEndpoint): string {
	return endpoint.baseUrl
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/v[12]$/, "");
}

async function call(
	endpoint: ScrapeEndpoint,
	path: string,
	body: unknown | undefined,
	options: RequestOptions & { timeoutMs?: number },
): Promise<Record<string, unknown>> {
	const send = options.fetch ?? fetch;
	const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeout])
		: timeout;
	let response: Response;
	try {
		response = await send(`${root(endpoint)}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
				...(endpoint.apiKey
					? { Authorization: `Bearer ${endpoint.apiKey}` }
					: {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal,
		});
	} catch (error) {
		if (options.signal?.aborted) throw error;
		throw new ScrapeError(
			`The scraping endpoint at ${root(endpoint)} did not answer (${error instanceof Error ? error.message : String(error)}).`,
		);
	}
	const text = await response.text();
	let parsed: Record<string, unknown> | undefined;
	try {
		parsed = JSON.parse(text) as Record<string, unknown>;
	} catch {
		parsed = undefined;
	}
	if (!response.ok || parsed?.success === false) {
		const said =
			(typeof parsed?.error === "string" && parsed.error) ||
			text
				.replace(/<[^>]+>/g, " ")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 200);
		throw new ScrapeError(
			response.status === 401 || response.status === 403
				? `The scraping endpoint refused the key (HTTP ${response.status}). Set it under Settings > Features.`
				: response.status === 502 || response.status === 503
					? `The scraping endpoint at ${root(endpoint)} is not running (HTTP ${response.status}).`
					: `The scraping endpoint answered HTTP ${response.status}${said ? `: ${said}` : ""}.`,
		);
	}
	if (!parsed) {
		throw new ScrapeError("The scraping endpoint's answer was not JSON.");
	}
	return parsed;
}

let turndown: Promise<{ turndown(html: string): string }> | undefined;

async function converter(): Promise<{ turndown(html: string): string }> {
	turndown ??= (async () => {
		const { default: Turndown } = await import("turndown");
		const { gfm } = await import("@joplin/turndown-plugin-gfm");
		const service = new Turndown({
			headingStyle: "atx",
			codeBlockStyle: "fenced",
			bulletListMarker: "-",
		});
		service.use(gfm);
		service.remove(["script", "style", "head", "noscript", "iframe"]);
		// A code block keeps its lines and its language, whatever wraps it:
		// documentation sites put highlighted code in `div.highlight-<lang> pre`
		// with a span per token and no <code> at all.
		service.addRule("pre", {
			filter: "pre",
			replacement: (_content, node) => {
				const element = node as unknown as {
					textContent: string | null;
					getAttribute(name: string): string | null;
					parentNode?: { getAttribute?(name: string): string | null } | null;
					firstChild?: { getAttribute?(name: string): string | null } | null;
				};
				const classes = [
					element.getAttribute("class"),
					element.firstChild?.getAttribute?.("class"),
					element.parentNode?.getAttribute?.("class"),
					(
						element.parentNode as unknown as {
							parentNode?: { getAttribute?(name: string): string | null };
						}
					)?.parentNode?.getAttribute?.("class"),
				]
					.filter(Boolean)
					.join(" ");
				const language =
					/(?:language-|lang-|highlight-)([a-z0-9+#_-]+)/i.exec(classes)?.[1] ??
					"";
				const code = (element.textContent ?? "").replace(/\n+$/, "");
				const fence = code.includes("```") ? "````" : "```";
				return `\n\n${fence}${language === "default" ? "" : language}\n${code}\n${fence}\n\n`;
			},
		});
		// "¶" anchors beside every heading are navigation, not text.
		service.addRule("headerlink", {
			filter: (node) => {
				const element = node as unknown as {
					nodeName: string;
					getAttribute(name: string): string | null;
				};
				return (
					element.nodeName === "A" &&
					/headerlink|anchor-link|hash-link/.test(
						element.getAttribute("class") ?? "",
					)
				);
			},
			replacement: () => "",
		});
		return service;
	})();
	return turndown;
}

/** A page's HTML as markdown, with its code blocks fenced. */
export async function htmlToMarkdown(html: string): Promise<string> {
	const service = await converter();
	return service
		.turndown(html)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

async function toPage(
	data: Record<string, unknown>,
	fallbackUrl: string,
): Promise<ScrapedPage | ScrapeFailure> {
	const metadata = (data.metadata ?? {}) as Record<string, unknown>;
	const url =
		(typeof metadata.sourceURL === "string" && metadata.sourceURL) ||
		(typeof metadata.url === "string" && metadata.url) ||
		fallbackUrl;
	const status = Number(metadata.statusCode ?? 200);
	if (status >= 400) {
		return { url, reason: `the site answered HTTP ${status}` };
	}
	const markdown =
		typeof data.html === "string" && data.html.trim()
			? await htmlToMarkdown(data.html)
			: typeof data.markdown === "string"
				? data.markdown.trim()
				: "";
	if (!markdown) return { url, reason: "the page has no text" };
	const text = (value: unknown) =>
		typeof value === "string" && value.trim() ? value.trim() : undefined;
	return {
		url,
		...(text(metadata.title) ? { title: text(metadata.title) } : {}),
		...(text(metadata.description)
			? { description: text(metadata.description) }
			: {}),
		...(text(metadata.language) ? { language: text(metadata.language) } : {}),
		markdown,
		sha256: createHash("sha256").update(markdown).digest("hex"),
		...(Array.isArray(data.links)
			? {
					links: data.links.filter(
						(link): link is string => typeof link === "string",
					),
				}
			: {}),
	};
}

/** Read one page. */
export async function scrapePage(
	endpoint: ScrapeEndpoint,
	url: string,
	options: RequestOptions & { links?: boolean } = {},
): Promise<ScrapedPage> {
	const answer = await call(
		endpoint,
		"/v2/scrape",
		{
			url,
			formats: options.links ? ["html", "links"] : ["html"],
			onlyMainContent: true,
		},
		options,
	);
	const page = await toPage(
		(answer.data ?? {}) as Record<string, unknown>,
		url,
	);
	if ("reason" in page) throw new ScrapeError(`${url}: ${page.reason}.`);
	return page;
}

/** Read a page and the pages it links to, as deep and as many as `options` allow. */
export async function crawlSite(
	endpoint: ScrapeEndpoint,
	url: string,
	options: CrawlOptions,
): Promise<CrawlResult> {
	const started = await call(
		endpoint,
		"/v2/crawl",
		{
			url,
			limit: options.limit,
			maxDiscoveryDepth: options.depth,
			...(options.includePaths?.length
				? { includePaths: options.includePaths }
				: {}),
			...(options.excludePaths?.length
				? { excludePaths: options.excludePaths }
				: {}),
			...(options.entireDomain ? { crawlEntireDomain: true } : {}),
			scrapeOptions: {
				formats: options.links ? ["html", "links"] : ["html"],
				onlyMainContent: true,
			},
		},
		options,
	);
	const id = typeof started.id === "string" ? started.id : "";
	if (!id) throw new ScrapeError("The scraping endpoint started no crawl.");
	const deadline = Date.now() + (options.timeoutMs ?? 20 * 60_000);
	const result: CrawlResult = { pages: [], failed: [] };
	const seen = new Set<string>();
	let skip = 0;
	for (;;) {
		options.signal?.throwIfAborted();
		// The job's own `next` link is not followed: behind a proxy it names
		// a host and port the client cannot reach. `skip` says the same.
		const status = await call(
			endpoint,
			`/v2/crawl/${encodeURIComponent(id)}?skip=${skip}`,
			undefined,
			options,
		);
		const data = Array.isArray(status.data) ? status.data : [];
		for (const entry of data) {
			const page = await toPage(entry as Record<string, unknown>, url);
			if (seen.has(page.url)) continue;
			seen.add(page.url);
			if ("reason" in page) result.failed.push(page);
			else result.pages.push(page);
		}
		skip += data.length;
		options.onProgress?.(
			Number(status.completed ?? result.pages.length),
			Number(status.total ?? result.pages.length),
		);
		const state = String(status.status ?? "");
		if (state === "failed" || state === "cancelled") {
			if (result.pages.length === 0) {
				throw new ScrapeError(`The crawl of ${url} ${state}.`);
			}
			break;
		}
		if (state === "completed" && data.length === 0) break;
		if (Date.now() > deadline) {
			result.unfinished = true;
			break;
		}
		if (data.length === 0) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, 2000);
				options.signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(options.signal?.reason);
					},
					{ once: true },
				);
			});
		}
	}
	return result;
}

/** The pages of a site, by their links, without reading them. */
export async function mapSite(
	endpoint: ScrapeEndpoint,
	url: string,
	options: RequestOptions & { limit?: number; search?: string } = {},
): Promise<string[]> {
	const answer = await call(
		endpoint,
		"/v2/map",
		{
			url,
			limit: options.limit ?? 200,
			...(options.search ? { search: options.search } : {}),
		},
		options,
	);
	const links = Array.isArray(answer.links) ? answer.links : [];
	return links
		.map((link) =>
			typeof link === "string"
				? link
				: typeof (link as { url?: unknown })?.url === "string"
					? ((link as { url: string }).url as string)
					: "",
		)
		.filter(Boolean);
}

/** Search the web. Works when the endpoint has a search provider behind it. */
export async function searchWeb(
	endpoint: ScrapeEndpoint,
	query: string,
	options: RequestOptions & { limit?: number } = {},
): Promise<WebSearchHit[]> {
	const answer = await call(
		endpoint,
		"/v2/search",
		{ query, limit: options.limit ?? 10 },
		options,
	);
	const data = answer.data;
	const hits = Array.isArray(data)
		? data
		: Array.isArray((data as { web?: unknown })?.web)
			? (data as { web: unknown[] }).web
			: [];
	return hits
		.map((hit) => hit as Record<string, unknown>)
		.filter((hit) => typeof hit.url === "string")
		.map((hit) => ({
			url: String(hit.url),
			...(typeof hit.title === "string" ? { title: hit.title } : {}),
			...(typeof hit.description === "string"
				? { description: hit.description }
				: {}),
		}));
}

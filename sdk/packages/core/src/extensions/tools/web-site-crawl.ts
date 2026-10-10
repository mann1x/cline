/**
 * A site crawled into a folder of the workspace, and continued later.
 *
 * The folder keeps a record of the crawl (`.scrape.json`): the pages read
 * and where each was saved, the files fetched, the pages that are linked and
 * were not read, and the files a limit left out. A later crawl into the same
 * folder with `resume` reads only what is missing -- the pages from that
 * list, one by one through the endpoint, and the files not yet on disk --
 * and nothing that is already there.
 *
 * Every limit that stopped something is said at the top of the result, as an
 * alert the model is told to pass on: the user set those limits, and only
 * the user can raise them.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_SCRAPE_SETTINGS } from "@cline/shared";
import {
	crawlSite,
	type ScrapedPage,
	type ScrapeFailure,
	scrapePage,
} from "../../services/retrieval/firecrawl";
import {
	type MirrorReport,
	mirrorSite,
} from "../../services/retrieval/web-mirror";
import type { LibraryScrapeConfig } from "./library-tools";

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
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

export function pageFile(page: ScrapedPage): string {
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

export function sitesLine(hosts: readonly string[], most = 8): string {
	return hosts.length === 0
		? ""
		: ` (${hosts.slice(0, most).join(", ")}${hosts.length > most ? `, and ${hosts.length - most} more` : ""})`;
}

/** The record a crawl leaves in its folder. */
export const SITE_RECORD_FILE = ".scrape.json";

export interface SiteRecord {
	version: 1;
	/** The address the crawl started from. */
	url: string;
	content: "site" | "text";
	wholeSite: boolean;
	include: string[];
	exclude: string[];
	/** Pages read, by address. */
	pages: Record<
		string,
		{
			title?: string;
			markdown: string;
			characters: number;
			served?: string;
			rendered?: string;
		}
	>;
	/** Files fetched, by address. */
	assets: Record<string, { file: string; bytes: number }>;
	/** Pages of the site that are linked and were not read. */
	unread: string[];
	/** Files a limit left out. */
	assetsLeft: string[];
	/** Files that could not be fetched, with the reason. */
	failed: Record<string, string>;
	/** Pages that could not be read, with the reason. */
	failedPages: Record<string, string>;
}

export interface CrawlToFolderRequest {
	scrape: LibraryScrapeConfig;
	url: string;
	/** The folder, absolute. */
	target: string;
	/** The folder as the model named it, for the result. */
	folder: string;
	limit?: number;
	depth?: number;
	include: string[];
	exclude: string[];
	wholeSite?: boolean;
	content?: "site" | "text";
	resume: boolean;
	signal?: AbortSignal;
	emit?: (status: string) => void;
	/** A text file the crawl wrote or rewrote, by absolute path. */
	wrote?: (file: string) => void;
}

async function readRecord(target: string): Promise<SiteRecord | undefined> {
	try {
		const parsed = JSON.parse(
			await fs.readFile(path.join(target, SITE_RECORD_FILE), "utf8"),
		) as SiteRecord;
		return parsed?.version === 1 &&
			typeof parsed.url === "string" &&
			parsed.pages &&
			parsed.assets
			? {
					...parsed,
					unread: Array.isArray(parsed.unread) ? parsed.unread : [],
					assetsLeft: Array.isArray(parsed.assetsLeft) ? parsed.assetsLeft : [],
					failed: parsed.failed ?? {},
					failedPages: parsed.failedPages ?? {},
				}
			: undefined;
	} catch {
		return undefined;
	}
}

function siteHost(url: string): string {
	try {
		return new URL(url).host.replace(/^www\./, "");
	} catch {
		return "";
	}
}

/**
 * Whether a link is one this crawl reads: the same site, below the starting
 * address unless the whole site was asked for, and through the path filters.
 */
export function inCrawlScope(
	link: string,
	record: Pick<SiteRecord, "url" | "wholeSite" | "include" | "exclude">,
): boolean {
	let parsed: URL;
	let start: URL;
	try {
		parsed = new URL(link);
		start = new URL(record.url);
	} catch {
		return false;
	}
	if (siteHost(link) !== siteHost(record.url)) return false;
	if (!record.wholeSite) {
		const below = start.pathname.replace(/\/+$/, "");
		if (
			below !== "" &&
			parsed.pathname !== below &&
			!parsed.pathname.startsWith(`${below}/`)
		) {
			return false;
		}
	}
	const matches = (patterns: readonly string[]) =>
		patterns.some((pattern) => {
			try {
				return new RegExp(pattern).test(parsed.pathname);
			} catch {
				return false;
			}
		});
	if (record.include.length > 0 && !matches(record.include)) return false;
	return !matches(record.exclude);
}

const megabytes = (bytes: number) =>
	bytes >= 1_048_576
		? `${(bytes / 1_048_576).toFixed(1)} MB`
		: `${Math.max(1, Math.round(bytes / 1024))} KB`;

const key = (link: string) => link.replace(/\/+$/, "");

function indexFile(record: SiteRecord): string {
	const pages = Object.entries(record.pages);
	const assets = Object.entries(record.assets);
	const failed = [
		...Object.entries(record.failedPages),
		...Object.entries(record.failed),
	];
	return [
		`# ${record.url}`,
		"",
		`${plural(pages.length, "page")}${record.content === "site" ? ` and ${plural(assets.length, "file")} they use` : ""}. ${
			record.unread.length || record.assetsLeft.length
				? `Not complete: ${plural(record.unread.length, "linked page")} not read, ${plural(record.assetsLeft.length, "file")} not fetched. A crawl into this folder with \`resume\` continues it.`
				: "Nothing known is missing."
		}`,
		"",
		"## Pages",
		"",
		...pages.map(
			([url, page]) =>
				`- ${url} — ${[
					`[markdown](${page.markdown})`,
					page.served ? `[as served](${page.served})` : "",
					page.rendered ? `[as rendered](${page.rendered})` : "",
				]
					.filter(Boolean)
					.join(", ")}${page.title ? ` — ${page.title}` : ""}`,
		),
		...(assets.length
			? [
					"",
					`## Files the pages use (${assets.length})`,
					"",
					...assets.map(
						([url, asset]) =>
							`- [${asset.file}](${asset.file}) — ${url} (${megabytes(asset.bytes)})`,
					),
				]
			: []),
		...(record.unread.length
			? [
					"",
					`## Linked and not read (${record.unread.length})`,
					"",
					...record.unread.map((link) => `- ${link}`),
				]
			: []),
		...(record.assetsLeft.length
			? [
					"",
					`## Files left out by a limit (${record.assetsLeft.length})`,
					"",
					...record.assetsLeft.map((link) => `- ${link}`),
				]
			: []),
		...(failed.length
			? [
					"",
					`## Not read or not fetched (${failed.length})`,
					"",
					...failed.map(([url, why]) => `- ${url}: ${why}`),
				]
			: []),
		"",
	].join("\n");
}

/** Read `links` through the endpoint, a few at a time. */
async function readPages(
	request: CrawlToFolderRequest,
	links: readonly string[],
	rawHtml: boolean,
	progress: (done: number) => void,
): Promise<{ pages: ScrapedPage[]; failed: ScrapeFailure[] }> {
	const pages: ScrapedPage[] = [];
	const failed: ScrapeFailure[] = [];
	const queue = [...links];
	await Promise.all(
		Array.from({ length: 3 }, async () => {
			for (;;) {
				request.signal?.throwIfAborted();
				const link = queue.shift();
				if (link === undefined) return;
				try {
					pages.push(
						await scrapePage(request.scrape, link, {
							links: true,
							...(rawHtml ? { rawHtml: true } : {}),
							...(request.signal ? { signal: request.signal } : {}),
						}),
					);
				} catch (error) {
					request.signal?.throwIfAborted();
					failed.push({
						url: link,
						reason: error instanceof Error ? error.message : String(error),
					});
				}
				progress(pages.length + failed.length);
			}
		}),
	);
	return { pages, failed };
}

/** Crawl a site into a folder, or continue the crawl that is there. */
export async function crawlToFolder(
	request: CrawlToFolderRequest,
): Promise<string> {
	const { scrape, target, folder } = request;
	const earlier = await readRecord(target);
	if (request.resume && !earlier) {
		return `There is no earlier crawl in ${folder}/ to resume. Leave \`resume\` out to start one.`;
	}
	// A resumed crawl is the earlier one continued: its address, its scope
	// and what it saves, unless this call says otherwise.
	const record: SiteRecord =
		request.resume && earlier
			? {
					...earlier,
					wholeSite: request.wholeSite ?? earlier.wholeSite,
					include: request.include.length ? request.include : earlier.include,
					exclude: request.exclude.length ? request.exclude : earlier.exclude,
				}
			: {
					version: 1,
					url: request.url,
					content: request.content ?? "site",
					wholeSite: request.wholeSite === true,
					include: request.include,
					exclude: request.exclude,
					pages: {},
					// Files already in the folder are not fetched twice, even by
					// a crawl that reads its pages afresh.
					assets: earlier?.assets ?? {},
					unread: [],
					assetsLeft: [],
					failed: {},
					failedPages: {},
				};
	const url = record.url;
	const site = record.content === "site";
	const limit = Math.max(
		1,
		Math.min(
			scrape.maxPages,
			request.limit !== undefined ? Math.round(request.limit) : 25,
		),
	);
	const depth = Math.max(
		request.resume ? 1 : 0,
		Math.min(
			Math.max(scrape.maxDepth, request.resume ? 1 : 0),
			request.depth !== undefined && request.depth >= 0
				? Math.round(request.depth)
				: 1,
		),
	);
	const started = Date.now();
	const seconds = () => Math.round((Date.now() - started) / 1000);
	let lastEmit = 0;
	const emit = (status: string) => {
		if (Date.now() - lastEmit < 2000) return;
		lastEmit = Date.now();
		request.emit?.(`${status}, ${seconds()} s`);
	};

	let pages: ScrapedPage[] = [];
	let pageFailures: ScrapeFailure[] = [];
	let unfinished = false;
	let pageLimitReached = false;
	const alreadyPages = Object.keys(record.pages).length;

	if (!request.resume) {
		const crawl = await crawlSite(scrape, url, {
			limit,
			depth,
			...(record.include.length ? { includePaths: record.include } : {}),
			...(record.exclude.length ? { excludePaths: record.exclude } : {}),
			...(record.wholeSite ? { entireDomain: true } : {}),
			links: true,
			...(site ? { rawHtml: true } : {}),
			...(request.signal ? { signal: request.signal } : {}),
			onProgress: (done, total) =>
				emit(`Crawling ${url}: ${done} of ${total} pages read`),
		});
		pages = crawl.pages;
		pageFailures = crawl.failed;
		unfinished = crawl.unfinished === true;
		pageLimitReached = crawl.pages.length >= limit;
		record.unread = linkCensus(pages, url).unread;
	} else {
		// From the pages that were linked and not read, level by level.
		const known = new Set(Object.keys(record.pages).map(key));
		// A page that could not be read last time gets another try.
		const waiting = [
			...new Set([...Object.keys(record.failedPages), ...record.unread]),
		];
		record.failedPages = {};
		let frontier = waiting.filter(
			(link) => !known.has(key(link)) && inCrawlScope(link, record),
		);
		const outside = record.unread.filter(
			(link) => !known.has(key(link)) && !inCrawlScope(link, record),
		);
		const later = new Set<string>();
		let budget = limit;
		for (let level = 0; level < depth && frontier.length > 0; level += 1) {
			const batch = frontier.slice(0, budget);
			for (const link of frontier.slice(budget)) later.add(link);
			for (const link of batch) known.add(key(link));
			const read = await readPages(request, batch, site, (done) =>
				emit(
					`Resuming ${url}: ${pages.length + done} of ${Math.min(limit, pages.length + batch.length)} pages read`,
				),
			);
			pages.push(...read.pages);
			pageFailures.push(...read.failed);
			budget -= batch.length;
			const next = linkCensus(read.pages, url).unread.filter(
				(link) => !known.has(key(link)) && !later.has(link),
			);
			if (budget <= 0) {
				for (const link of next) later.add(link);
				pageLimitReached = later.size > 0;
				frontier = [];
				break;
			}
			frontier = next.filter((link) => inCrawlScope(link, record));
			for (const link of next) {
				if (!inCrawlScope(link, record)) later.add(link);
			}
		}
		for (const link of frontier) later.add(link);
		record.unread = [...new Set([...later, ...outside])].filter(
			(link) => !known.has(key(link)),
		);
	}

	// The markdown reading of each page read now.
	await fs.mkdir(target, { recursive: true });
	const taken = new Set<string>([
		"index.md",
		...Object.values(record.pages).map((page) => page.markdown.toLowerCase()),
	]);
	let characters = 0;
	for (const page of pages) {
		const name =
			record.pages[page.url]?.markdown ?? pageFileName(page.url, taken);
		const file = path.join(target, ...name.split("/"));
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, pageFile(page), "utf8");
		request.wrote?.(file);
		characters += page.markdown.length;
		record.pages[page.url] = {
			...(page.title ? { title: page.title } : {}),
			markdown: name,
			characters: page.markdown.length,
		};
		delete record.failedPages[page.url];
	}
	for (const failure of pageFailures) {
		record.failedPages[failure.url] = failure.reason;
	}

	// The pages as they are and the files they use, fetched from the site
	// itself: the endpoint gives content, not stylesheets.
	const maxFiles = scrape.maxFiles ?? DEFAULT_SCRAPE_SETTINGS.maxFiles;
	const maxFileMb = scrape.maxFileMb ?? DEFAULT_SCRAPE_SETTINGS.maxFileMb;
	const maxTotalMb = scrape.maxTotalMb ?? DEFAULT_SCRAPE_SETTINGS.maxTotalMb;
	let mirror: MirrorReport | undefined;
	if (site && (pages.length > 0 || request.resume)) {
		// Only files that are really still there count as saved.
		const onDisk = new Map<string, string>();
		await Promise.all(
			Object.entries(record.assets).map(async ([address, asset]) => {
				const there = await fs
					.stat(path.join(target, ...asset.file.split("/")))
					.then((stat) => stat.isFile())
					.catch(() => false);
				if (there) onDisk.set(address, asset.file);
				else delete record.assets[address];
			}),
		);
		const retry = request.resume
			? [
					...record.assetsLeft,
					// A file that failed last time gets another try.
					...Object.keys(record.failed),
				]
			: [];
		mirror = await mirrorSite(
			pages.map((page) => ({
				url: page.url,
				...(page.rawHtml ? { rawHtml: page.rawHtml } : {}),
			})),
			{
				root: target,
				maxAssets: maxFiles,
				maxAssetBytes: maxFileMb * 1_048_576,
				maxTotalBytes: maxTotalMb * 1_048_576,
				have: (address) => onDisk.get(address),
				also: retry,
				...(request.signal ? { signal: request.signal } : {}),
				onProgress: (done, known) =>
					emit(`Saving ${url}: ${done} of ${known} pages and files`),
			},
		);
		for (const address of retry) delete record.failed[address];
		for (const page of mirror.pages) {
			const held = record.pages[page.url];
			if (held) {
				if (page.served) held.served = page.served;
				if (page.rendered) held.rendered = page.rendered;
			}
		}
		for (const asset of mirror.assets) {
			record.assets[asset.url] = { file: asset.file, bytes: asset.bytes };
		}
		for (const failure of mirror.failed) {
			record.failed[failure.url] = failure.reason;
		}
		record.assetsLeft = mirror.left;
	}

	await fs.writeFile(
		path.join(target, SITE_RECORD_FILE),
		JSON.stringify(record, null, "\t"),
		"utf8",
	);
	await fs.writeFile(path.join(target, "index.md"), indexFile(record), "utf8");
	request.wrote?.(path.join(target, "index.md"));
	request.wrote?.(path.join(target, SITE_RECORD_FILE));

	const failedNow = [
		...pageFailures.map((failure) => `- ${failure.url}: ${failure.reason}`),
		...(mirror?.failed ?? []).map(
			(failure) => `- ${failure.url}: ${failure.reason}`,
		),
	];
	if (!request.resume && pages.length === 0) {
		return [
			`No page of ${url} could be read.`,
			...(failedNow.length ? ["Not read:", ...failedNow.slice(0, 20)] : []),
		].join("\n");
	}

	// What a limit stopped, first, and as something to pass on.
	const alerts: string[] = [];
	if (pageLimitReached) {
		alerts.push(
			`- Pages: the limit of ${plural(limit, "page")} for this call was reached${record.unread.length ? `; ${plural(record.unread.length, "more page")} of the site ${record.unread.length === 1 ? "is" : "are"} linked and not read` : ", so the site may have more"}. The user's setting allows up to ${plural(scrape.maxPages, "page")} a call ("Pages one crawl or book may read in a call").`,
		);
	}
	if (unfinished) {
		alerts.push(
			"- Time: the crawl was still running at its time limit; what was read so far is saved.",
		);
	}
	if (mirror && mirror.leftForCount > 0) {
		alerts.push(
			`- Files: ${plural(mirror.leftForCount, "file")} ${mirror.leftForCount === 1 ? "was" : "were"} not fetched, because one crawl may fetch ${plural(maxFiles, "file")} ("Files one site crawl may fetch").`,
		);
	}
	if (mirror && mirror.leftForSize > 0) {
		alerts.push(
			`- Size: ${plural(mirror.leftForSize, "file")} ${mirror.leftForSize === 1 ? "was" : "were"} not fetched, because one crawl may fetch ${maxTotalMb} MB in all ("Most one site crawl may fetch in all").`,
		);
	}
	if (mirror && mirror.tooLarge > 0) {
		alerts.push(
			`- Large files: ${plural(mirror.tooLarge, "file")} over ${maxFileMb} MB ${mirror.tooLarge === 1 ? "was" : "were"} skipped ("Largest file fetched"). ${mirror.tooLarge === 1 ? "It is" : "They are"} listed below.`,
		);
	}
	const canContinue = record.unread.length > 0 || record.assetsLeft.length > 0;
	const alertBlock = alerts.length
		? [
				"NOT COMPLETE: a limit the user set stopped this crawl before everything was fetched. Do not report the scrape as complete. Your reply must tell the user what was left out and which setting raises it (Settings > Features > Web scraping; only the user can change it):",
				...alerts,
				canContinue
					? `To continue without fetching again what is already saved, call crawl with save_to "${folder}" and resume: true.`
					: "The pages read link to no other page of this site, and no file was left out, so there may be nothing more to fetch.",
				"",
			]
		: [];

	const census = linkCensus(pages, url);
	const elsewhere = census.elsewhere.length
		? ` Links to other sites${sitesLine(census.elsewhere)} are not followed.`
		: "";
	const ending =
		pageLimitReached || unfinished
			? []
			: record.unread.length === 0
				? [
						alerts.length
							? `No page is missing: every page of the site that the pages read link to was read.${elsewhere}`
							: `That is the whole site from this address: every page of it that the pages read link to was read.${elsewhere}`,
					]
				: [
						`${plural(record.unread.length, "more page")} of this site ${record.unread.length === 1 ? "is" : "are"} linked and ${record.unread.length === 1 ? "was" : "were"} not read: ${
							record.wholeSite
								? `deeper than depth ${depth}`
								: `deeper than depth ${depth}, or not below ${url} (\`whole_site\` follows those)`
						}. For example ${record.unread.slice(0, 5).join(", ")}. resume: true reads them.${elsewhere}`,
					];

	const mirrorLines: string[] = [];
	if (mirror) {
		const served = mirror.pages.filter((page) => page.served).length;
		const renderedOnly = mirror.pages.filter(
			(page) => !page.served && page.rendered,
		);
		if (mirror.pages.length === 0) {
			mirrorLines.push(
				`${plural(mirror.assets.length, "file")} the pages use ${mirror.assets.length === 1 ? "was" : "were"} fetched (${megabytes(mirror.bytes)}), each at the path the site has it under its host's folder.`,
			);
		} else
			mirrorLines.push(
				`The site itself is saved unaltered beside the markdown: ${plural(served, "page")} as served (.html), ${plural(mirror.pages.filter((page) => page.rendered).length, "page")} as rendered in the browser (${served ? ".rendered.html" : ".html"}), and ${plural(mirror.assets.length, "file")} they use (stylesheets, scripts, pictures, fonts), ${megabytes(mirror.bytes)} fetched, each at the path the site has it under its host's folder.`,
			);
		if (mirror.reused > 0) {
			mirrorLines.push(
				`${plural(mirror.reused, "file")} already in the folder ${mirror.reused === 1 ? "was" : "were"} not fetched again.`,
			);
		}
		if (renderedOnly.length > 0) {
			mirrorLines.push(
				`${plural(renderedOnly.length, "page")} could not be fetched directly (${renderedOnly[0]?.problem ?? "refused"}), so only the rendered form is saved for ${renderedOnly.length === 1 ? "it" : "them"}.`,
			);
		}
		mirrorLines.push(
			"Links inside the saved pages are as the site wrote them; nothing was rewritten.",
		);
	}

	const rows = pages.map((page) => {
		const held = record.pages[page.url];
		return `- [${page.title || page.url}](${held?.markdown}) — ${page.url} (${page.markdown.length.toLocaleString("en-US")} characters)${
			held?.served || held?.rendered
				? `; ${[held.served, held.rendered].filter(Boolean).join(", ")}`
				: ""
		}`;
	});
	const shown = 60;
	const total = Object.keys(record.pages).length;
	return [
		...alertBlock,
		request.resume
			? pages.length === 0
				? `Resumed the crawl of ${url} in ${folder}/: no page was left to read; the ${plural(alreadyPages, "page")} already saved ${alreadyPages === 1 ? "was" : "were"} not read again.`
				: `Resumed the crawl of ${url} in ${folder}/: ${plural(pages.length, "more page")} read (${characters.toLocaleString("en-US")} characters), ${plural(total, "page")} there now; the ${plural(alreadyPages, "page")} already saved ${alreadyPages === 1 ? "was" : "were"} not read again.`
			: `${plural(pages.length, "page")} of ${url} written under ${folder}/ (${characters.toLocaleString("en-US")} characters; depth ${depth}, at most ${plural(limit, "page")}).`,
		...ending,
		...mirrorLines,
		`${alerts.length ? "What was fetched" : "Everything"} is saved whole, and ${folder}/index.md lists it for the user: neither it nor the files need reading back to check them.`,
		...rows.slice(0, shown),
		...(rows.length > shown
			? [`[${rows.length - shown} more in index.md.]`]
			: []),
		...(failedNow.length
			? [
					`Not read or not fetched (${failedNow.length}):`,
					...failedNow.slice(0, 20),
					...(failedNow.length > 20
						? [`[${failedNow.length - 20} more in index.md.]`]
						: []),
				]
			: []),
		// Said again last, where it is read just before the reply is written.
		...(alerts.length
			? [
					"Reminder: this crawl is NOT complete. Say so in your reply, with what was left out.",
				]
			: []),
	].join("\n");
}

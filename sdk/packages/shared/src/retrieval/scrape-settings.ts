/**
 * The web scraper's settings: the Firecrawl endpoint pages are read through,
 * who may use it, and how far one crawl may go.
 */

export interface ScrapeSettings {
	/** Whether scraping is set up at all. A profile still has to allow it. */
	enabled: boolean;
	/** The endpoint's address: `http://host:3002`. */
	baseUrl: string;
	/** Pages one crawl reads, at most. */
	maxPages: number;
	/** How many links deep a crawl follows from where it starts. */
	maxDepth: number;
	/**
	 * Only the librarian scrapes, to make books. Off, every task is offered a
	 * general `web_scrape` that can also crawl a site into files.
	 */
	librarianOnly: boolean;
	/** Files one crawl fetches besides its pages, at most. */
	maxFiles: number;
	/** One fetched file's size in megabytes, at most. */
	maxFileMb: number;
	/** Everything one crawl fetches, in megabytes, at most. */
	maxTotalMb: number;
}

export const DEFAULT_SCRAPE_SETTINGS: ScrapeSettings = {
	enabled: false,
	baseUrl: "",
	maxPages: 100,
	maxDepth: 3,
	librarianOnly: true,
	maxFiles: 2000,
	maxFileMb: 25,
	maxTotalMb: 300,
};

/** Stored settings, whatever shape they are in, as settings that can be used. */
export function resolveScrapeSettings(
	stored: Partial<Record<keyof ScrapeSettings, unknown>> | undefined | null,
): ScrapeSettings {
	const d = DEFAULT_SCRAPE_SETTINGS;
	const s = stored ?? {};
	const integer = (
		value: unknown,
		fallback: number,
		min: number,
		max: number,
	) => {
		const number = Number(value);
		return Number.isFinite(number)
			? Math.min(max, Math.max(min, Math.round(number)))
			: fallback;
	};
	return {
		enabled: typeof s.enabled === "boolean" ? s.enabled : d.enabled,
		baseUrl: typeof s.baseUrl === "string" ? s.baseUrl.trim() : d.baseUrl,
		maxPages: integer(s.maxPages, d.maxPages, 1, 5000),
		maxDepth: integer(s.maxDepth, d.maxDepth, 0, 10),
		librarianOnly:
			typeof s.librarianOnly === "boolean" ? s.librarianOnly : d.librarianOnly,
		maxFiles: integer(s.maxFiles, d.maxFiles, 0, 100_000),
		maxFileMb: integer(s.maxFileMb, d.maxFileMb, 1, 2048),
		maxTotalMb: integer(s.maxTotalMb, d.maxTotalMb, 1, 102_400),
	};
}

/**
 * The web scraper's settings: the Firecrawl endpoint the librarian reads
 * pages through, and how far one crawl may go.
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
}

export const DEFAULT_SCRAPE_SETTINGS: ScrapeSettings = {
	enabled: false,
	baseUrl: "",
	maxPages: 100,
	maxDepth: 3,
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
	};
}

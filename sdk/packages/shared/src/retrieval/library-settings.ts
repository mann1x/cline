/**
 * The Library's settings, with their defaults.
 *
 * The set and the defaults follow open-webui's document settings, which are
 * a good starting point; they are meant to be tuned.
 */

export interface LibrarySettings {
	/** Whether the model is offered the Library at all. */
	enabled: boolean;
	/** How chunk sizes are measured. */
	splitter: "characters" | "tokens";
	/** Break at markdown headers first, and keep each chunk's headers with it. */
	markdownHeaders: boolean;
	chunkSize: number;
	chunkOverlap: number;
	/** Chunks smaller than this are merged with a neighbour. 0 is off. */
	chunkMinSize: number;
	/** Texts per embedding request. */
	embeddingBatchSize: number;
	/** Embedding requests in flight at once. 0 is no limit of ours. */
	embeddingConcurrency: number;
	/** Put in front of a query, and of a document, for instruction-tuned embedders. */
	embeddingQueryPrefix: string;
	embeddingDocumentPrefix: string;
	/** Search keywords together with vectors. */
	hybridSearch: boolean;
	/** Also match file names, titles and section headers by keyword. */
	enrichHybridText: boolean;
	/** 0 is semantic alone, 1 lexical alone. */
	bm25Weight: number;
	topK: number;
	topKReranker: number;
	relevanceThreshold: number;
	rerankingBatchSize: number;
	/** Have a vision model describe the pictures of a book as it is added. */
	describeImages: boolean;
	/**
	 * The saved profile whose model describes them. Empty is the session's own
	 * vision model, when it has one.
	 */
	imageProfile: string;
	/** Pictures described per file added, at most. */
	describeImagesLimit: number;
}

export const DEFAULT_LIBRARY_SETTINGS: LibrarySettings = {
	enabled: false,
	splitter: "characters",
	markdownHeaders: true,
	chunkSize: 1500,
	chunkOverlap: 100,
	chunkMinSize: 0,
	embeddingBatchSize: 64,
	embeddingConcurrency: 4,
	embeddingQueryPrefix: "",
	embeddingDocumentPrefix: "",
	hybridSearch: true,
	enrichHybridText: true,
	bm25Weight: 0.5,
	topK: 5,
	topKReranker: 3,
	relevanceThreshold: 0,
	rerankingBatchSize: 32,
	describeImages: true,
	imageProfile: "",
	describeImagesLimit: 40,
};

function integer(value: unknown, fallback: number, min: number, max: number) {
	const number = Number(value);
	return Number.isFinite(number)
		? Math.min(max, Math.max(min, Math.round(number)))
		: fallback;
}

function fraction(value: unknown, fallback: number) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

/** Stored settings, whatever shape they are in, as settings that can be used. */
export function resolveLibrarySettings(
	stored: Partial<Record<keyof LibrarySettings, unknown>> | undefined | null,
): LibrarySettings {
	const d = DEFAULT_LIBRARY_SETTINGS;
	const s = stored ?? {};
	const flag = (value: unknown, fallback: boolean) =>
		typeof value === "boolean" ? value : fallback;
	const text = (value: unknown, fallback: string) =>
		typeof value === "string" ? value : fallback;
	const chunkSize = integer(s.chunkSize, d.chunkSize, 100, 100_000);
	return {
		enabled: flag(s.enabled, d.enabled),
		splitter: s.splitter === "tokens" ? "tokens" : "characters",
		markdownHeaders: flag(s.markdownHeaders, d.markdownHeaders),
		chunkSize,
		// An overlap of the whole chunk would never advance.
		chunkOverlap: integer(
			s.chunkOverlap,
			Math.min(d.chunkOverlap, Math.floor(chunkSize / 2)),
			0,
			Math.floor(chunkSize / 2),
		),
		chunkMinSize: integer(s.chunkMinSize, d.chunkMinSize, 0, chunkSize),
		embeddingBatchSize: integer(
			s.embeddingBatchSize,
			d.embeddingBatchSize,
			1,
			8192,
		),
		embeddingConcurrency: integer(
			s.embeddingConcurrency,
			d.embeddingConcurrency,
			0,
			64,
		),
		embeddingQueryPrefix: text(s.embeddingQueryPrefix, d.embeddingQueryPrefix),
		embeddingDocumentPrefix: text(
			s.embeddingDocumentPrefix,
			d.embeddingDocumentPrefix,
		),
		hybridSearch: flag(s.hybridSearch, d.hybridSearch),
		enrichHybridText: flag(s.enrichHybridText, d.enrichHybridText),
		bm25Weight: fraction(s.bm25Weight, d.bm25Weight),
		topK: integer(s.topK, d.topK, 1, 100),
		topKReranker: integer(s.topKReranker, d.topKReranker, 1, 100),
		relevanceThreshold: fraction(s.relevanceThreshold, d.relevanceThreshold),
		rerankingBatchSize: integer(
			s.rerankingBatchSize,
			d.rerankingBatchSize,
			1,
			1024,
		),
		describeImages: flag(s.describeImages, d.describeImages),
		imageProfile: text(s.imageProfile, d.imageProfile).trim(),
		describeImagesLimit: integer(
			s.describeImagesLimit,
			d.describeImagesLimit,
			0,
			1000,
		),
	};
}

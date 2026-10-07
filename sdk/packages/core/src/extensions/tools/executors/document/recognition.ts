/**
 * Reading scanned pages and describing pictures: which engine a call uses,
 * and the work itself.
 *
 * Three ways to read a scanned page, in the user's order of preference:
 * tesseract on this machine; the vision model the user configured for the
 * session (the Vision tab, or the CLI's --vision-model); or, with neither, the
 * session's own model, which is handed the page images when it can see them.
 */

import type { AgentImageToDescribe } from "@cline/shared";
import type { PageImage, RecognizedText } from "./formats";
import {
	type DocumentReaderSettings,
	OcrLanguageMissingError,
	parseOcrLanguages,
	resolveOcrDataDir,
	TesseractReader,
} from "./ocr";
import { formatUnits } from "./range";

export type DescribeImages = (
	images: readonly AgentImageToDescribe[],
) => Promise<readonly (string | undefined)[]>;

/** What the call asked for: `auto` is the user's setting. */
export type OcrRequest = "auto" | "tesseract" | "vision" | "none";

/**
 * Pages recognized per call. Past it the rest are named, and a range reads
 * them: a 400-page scanned book is minutes of recognition, and the call would
 * outlast its timeout long before it finished.
 */
export const TESSERACT_PAGE_LIMIT = 40;
/** A vision model reads a page in seconds, and each page is a request. */
export const VISION_PAGE_LIMIT = 12;
/** Pages handed to the session's own model: each is an image in its context. */
export const SELF_PAGE_LIMIT = 4;
/** Pictures described per call. */
export const DESCRIBE_LIMIT = 16;

const TRANSCRIBE_INSTRUCTION =
	"This is a scanned page from a document. Transcribe all of its text exactly as written, " +
	"in reading order, keeping paragraphs, headings and lists, and table rows as Markdown tables. " +
	"Do not describe the page, summarize or add anything. Reply with the text only, " +
	"or with nothing if the page has no text.";

const DESCRIBE_INSTRUCTION =
	"This picture comes from a document. Describe it for a reader who cannot see it: " +
	"what kind of picture it is (photo, chart, diagram, table, screenshot, drawing), what it shows, " +
	"any text in it quoted exactly, and for a chart its axes, series and trend. " +
	"Two to five sentences.";

export interface RecognitionPlan {
	/** Passed to the reader; undefined when no recognition happens. */
	recognize?: (
		page: number,
		images: readonly PageImage[],
	) => Promise<RecognizedText | undefined>;
	/** Page images for the session's model to read, in `self` mode. */
	readonly attachments: { page: number; png: Uint8Array }[];
	/** Sentences for the result header. */
	notes(
		scannedPages: readonly number[],
		recognizedPages: readonly number[],
	): string[];
	/**
	 * Every scanned page that has no recognized text, with the reason, a line
	 * each. `notes` is the summary a reader skims; this is the whole account.
	 */
	problems(
		scannedPages: readonly number[],
		recognizedPages: readonly number[],
	): string[];
	close(): Promise<void>;
}

interface PlanInput {
	request: OcrRequest | undefined;
	languages: string | undefined;
	settings: DocumentReaderSettings;
	describeImages?: DescribeImages;
	modelSupportsImages: boolean;
	/**
	 * How many scanned pages are recognized. A book kept in the Library is
	 * read whole: its call is long by design and reports as it goes.
	 * @default the engine's per-call limit
	 */
	pageLimit?: number;
}

type Engine =
	| { kind: "none"; reason: string }
	| { kind: "tesseract"; languages: string[]; fallback?: string }
	| { kind: "vision" }
	| { kind: "self"; why: string };

const SETTINGS_HINT =
	"The user can change this under Settings > Features > Document Reader.";

function chooseEngine(input: PlanInput): Engine {
	const setting = input.settings.ocr ?? "tesseract";
	if (input.request === "none") {
		return {
			kind: "none",
			reason: 'Text recognition was skipped (ocr: "none").',
		};
	}
	if (setting === "off") {
		return {
			kind: "none",
			reason: `Text recognition (OCR) is turned off. ${SETTINGS_HINT}`,
		};
	}
	const wanted =
		!input.request || input.request === "auto" ? setting : input.request;
	const languages = parseOcrLanguages(
		input.languages ?? input.settings.ocrLanguages ?? ["eng"],
	);
	if (wanted === "tesseract") {
		return {
			kind: "tesseract",
			languages: languages.length ? languages : ["eng"],
		};
	}
	if (input.describeImages) return { kind: "vision" };
	if (input.modelSupportsImages) {
		return { kind: "self", why: "no vision model is configured" };
	}
	return {
		kind: "tesseract",
		languages: languages.length ? languages : ["eng"],
		fallback:
			"No vision model is configured and this model does not take images, so tesseract read the pages instead.",
	};
}

/**
 * The recognition a call will do, ready to hand to the reader.
 *
 * tesseract's worker is started on the first scanned page, not before: most
 * documents have none, and starting it costs a fifth of a second and a thread.
 */
export function planRecognition(input: PlanInput): RecognitionPlan {
	const engine = chooseEngine(input);
	const attachments: { page: number; png: Uint8Array }[] = [];
	const skipped: number[] = [];
	const failed: string[] = [];
	let reader: Promise<TesseractReader> | undefined;
	let used = 0;

	const limit =
		input.pageLimit !== undefined
			? input.pageLimit
			: engine.kind === "tesseract"
				? TESSERACT_PAGE_LIMIT
				: engine.kind === "vision"
					? VISION_PAGE_LIMIT
					: SELF_PAGE_LIMIT;

	const recognize =
		engine.kind === "none"
			? undefined
			: async (
					page: number,
					images: readonly PageImage[],
				): Promise<RecognizedText | undefined> => {
					if (used >= limit) {
						skipped.push(page);
						return undefined;
					}
					used++;
					// Largest first: on a page drawn from several pictures, the
					// page is the biggest one.
					const ordered = [...images].sort((a, b) => b.coverage - a.coverage);
					if (engine.kind === "self") {
						const first = ordered[0];
						if (first) attachments.push({ page, png: first.png });
						return undefined;
					}
					if (engine.kind === "vision") {
						return recognizeWithVision(
							input.describeImages,
							page,
							ordered,
							failed,
						);
					}
					reader ??= TesseractReader.open(
						engine.languages,
						input.settings.ocrDataDir ?? resolveOcrDataDir(),
					);
					let tesseract: TesseractReader;
					try {
						tesseract = await reader;
					} catch (error) {
						if (!failed.length) failed.push(tesseractFailure(error));
						return undefined;
					}
					const texts: string[] = [];
					let confidence = 0;
					for (const image of ordered) {
						try {
							const result = await tesseract.recognize(image.png);
							if (result.text.trim()) {
								texts.push(result.text.trim());
								confidence = Math.max(confidence, result.confidence);
							}
						} catch (error) {
							failed.push(
								`page ${page}: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					}
					if (!texts.length) return undefined;
					return {
						text: texts.join("\n\n"),
						by: `tesseract (${engine.languages.join("+")}, ${confidence}% confidence)`,
					};
				};

	return {
		recognize,
		attachments,
		notes(scannedPages, recognizedPages) {
			if (!scannedPages.length) return [];
			const notes: string[] = [];
			const unread = scannedPages.filter(
				(page) => !recognizedPages.includes(page),
			);
			if (engine.kind === "none") {
				notes.push(
					`Scanned pages ${formatUnits(scannedPages)}: an image of text with no text layer, so their words are not in this text. ${engine.reason}`,
				);
				return notes;
			}
			if (recognizedPages.length) {
				const by =
					engine.kind === "vision"
						? "the vision model"
						: `tesseract (${engine.kind === "tesseract" ? engine.languages.join("+") : "eng"})`;
				notes.push(
					`Scanned pages ${formatUnits(recognizedPages)}: their text was recognized from the page image by ${by}, and may contain recognition errors.`,
				);
			}
			if (engine.kind === "tesseract" && engine.fallback)
				notes.push(engine.fallback);
			if (engine.kind === "self" && attachments.length) {
				notes.push(
					`Scanned pages ${formatUnits(attachments.map((a) => a.page))} are attached below as images (${engine.why}): read their text from them.`,
				);
			}
			if (skipped.length) {
				notes.push(
					`Scanned pages ${formatUnits(skipped)} were not read: one call reads at most ${limit} scanned pages. Call again with range: "${skipped[0]}-" for the rest.`,
				);
			}
			const rest = unread.filter(
				(page) =>
					!skipped.includes(page) &&
					!(engine.kind === "self" && attachments.some((a) => a.page === page)),
			);
			if (rest.length) {
				notes.push(
					`Scanned pages ${formatUnits(rest)}: no text could be recognized${failed.length ? ` (${failed.slice(0, 3).join("; ")})` : ""}.`,
				);
			}
			return notes;
		},
		problems(scannedPages, recognizedPages) {
			const lines: string[] = [];
			const reasons = new Map<number, string>();
			for (const line of failed) {
				const match = /^page (\d+): ([\s\S]*)$/.exec(line);
				if (match) reasons.set(Number(match[1]), match[2] ?? "");
			}
			const general = failed.filter((line) => !/^page \d+: /.test(line));
			for (const page of scannedPages) {
				if (recognizedPages.includes(page)) continue;
				const why = skipped.includes(page)
					? `past the ${limit} pages recognized in one call`
					: (reasons.get(page) ??
						general[0] ??
						(engine.kind === "none"
							? engine.reason
							: "nothing readable was found on it"));
				lines.push(`page ${page}: a scan with no recognized text, ${why}`);
			}
			return lines;
		},
		async close() {
			if (reader) await (await reader.catch(() => undefined))?.close();
		},
	};
}

function tesseractFailure(error: unknown): string {
	if (error instanceof OcrLanguageMissingError) {
		return `${error.message} ${SETTINGS_HINT} In the CLI, --ocr-languages installs them`;
	}
	return `tesseract did not start: ${error instanceof Error ? error.message : String(error)}`;
}

async function recognizeWithVision(
	describeImages: DescribeImages | undefined,
	page: number,
	images: readonly PageImage[],
	failed: string[],
): Promise<RecognizedText | undefined> {
	if (!describeImages) return undefined;
	const first = images[0];
	if (!first) return undefined;
	try {
		const [text] = await describeImages([
			{
				image: Buffer.from(first.png).toString("base64"),
				mediaType: "image/png",
				instruction: TRANSCRIBE_INSTRUCTION,
			},
		]);
		return text?.trim()
			? { text: text.trim(), by: "the vision model" }
			: undefined;
	} catch (error) {
		failed.push(
			`page ${page}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

export interface PictureToDescribe {
	link: string;
	mediaType: string;
	/** The bytes, or where to read them when they are asked for: one picture in memory at a time. */
	data: Uint8Array | (() => Promise<Uint8Array>);
	source?: string;
}

/**
 * Descriptions of a document's pictures, one request each, in order.
 * `undefined` for any the vision model could not describe.
 */
/**
 * One picture described, or the reason it was not. For a caller that has to
 * say why: `describePictures` keeps the answers and drops the reasons.
 */
const bytesOf = async (picture: PictureToDescribe): Promise<Uint8Array> =>
	typeof picture.data === "function" ? await picture.data() : picture.data;

export async function describePicture(
	describeImages: DescribeImages,
	picture: PictureToDescribe,
	documentName: string,
): Promise<string | undefined> {
	const [description] = await describeImages([
		{
			image: Buffer.from(await bytesOf(picture)).toString("base64"),
			mediaType: picture.mediaType,
			instruction: DESCRIBE_INSTRUCTION,
			context: `From ${documentName}${picture.source ? `, ${picture.source}` : ""}.`,
		},
	]);
	return description?.trim() || undefined;
}

export async function describePictures(
	describeImages: DescribeImages,
	pictures: readonly PictureToDescribe[],
	documentName: string,
): Promise<(string | undefined)[]> {
	const descriptions: (string | undefined)[] = [];
	for (const picture of pictures) {
		try {
			const [description] = await describeImages([
				{
					image: Buffer.from(await bytesOf(picture)).toString("base64"),
					mediaType: picture.mediaType,
					instruction: DESCRIBE_INSTRUCTION,
					context: `From ${documentName}${picture.source ? `, ${picture.source}` : ""}.`,
				},
			]);
			descriptions.push(description?.trim() || undefined);
		} catch {
			descriptions.push(undefined);
		}
	}
	return descriptions;
}

/** A description short enough for alt text: its first sentences, up to 300 characters. */
export function altTextOf(description: string): string {
	const flat = description.replace(/\s+/g, " ").replace(/[[\]]/g, "").trim();
	if (flat.length <= 300) return flat;
	const cut = flat.slice(0, 300);
	const sentence = cut.lastIndexOf(". ");
	return sentence > 80 ? cut.slice(0, sentence + 1) : `${cut.trimEnd()}…`;
}

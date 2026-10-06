/**
 * What a document is, and which reader takes it.
 */

import * as path from "node:path";
import type { ImageCollector } from "./images";

export type DocumentFormat =
	| "pdf"
	| "docx"
	| "pptx"
	| "xlsx"
	| "odt"
	| "odp"
	| "ods"
	| "odg"
	| "rtf"
	| "csv"
	| "html"
	| "epub"
	| "mobi"
	| "azw3"
	| "fb2"
	| "doc"
	| "xls"
	| "ppt";

/** The names a format is known by, and the reader it goes to. */
export const FORMAT_LABELS: Record<DocumentFormat, string> = {
	pdf: "PDF",
	docx: "Word document (DOCX)",
	pptx: "PowerPoint presentation (PPTX)",
	xlsx: "Excel workbook (XLSX)",
	odt: "OpenDocument text (ODT)",
	odp: "OpenDocument presentation (ODP)",
	ods: "OpenDocument spreadsheet (ODS)",
	odg: "OpenDocument drawing (ODG)",
	rtf: "Rich Text (RTF)",
	csv: "CSV",
	html: "HTML",
	epub: "EPUB ebook",
	mobi: "Mobipocket / Kindle ebook (MOBI)",
	azw3: "Kindle KF8 ebook (AZW3)",
	fb2: "FictionBook (FB2)",
	doc: "Word 97-2003 document (DOC)",
	xls: "Excel 97-2003 workbook (XLS)",
	ppt: "PowerPoint 97-2003 presentation (PPT)",
};

const BY_EXTENSION: Record<string, DocumentFormat> = {
	".pdf": "pdf",
	".docx": "docx",
	".docm": "docx",
	".dotx": "docx",
	".pptx": "pptx",
	".pptm": "pptx",
	".ppsx": "pptx",
	".xlsx": "xlsx",
	".xlsm": "xlsx",
	".odt": "odt",
	".odp": "odp",
	".ods": "ods",
	".odg": "odg",
	".rtf": "rtf",
	".csv": "csv",
	".html": "html",
	".htm": "html",
	".xhtml": "html",
	".epub": "epub",
	".mobi": "mobi",
	".prc": "mobi",
	".azw": "mobi",
	".azw3": "azw3",
	".kf8": "azw3",
	".fb2": "fb2",
	".doc": "doc",
	".dot": "doc",
	".xls": "xls",
	".ppt": "ppt",
	".pps": "ppt",
};

/**
 * Formats that are documents but that no reader here takes, and what to say.
 *
 * Named so the answer is a reason rather than "unsupported": a model told why
 * can tell the user what would work instead.
 */
const UNSUPPORTED: Record<string, string> = {
	".djvu": "DjVu has no JavaScript reader.",
	".djv": "DjVu has no JavaScript reader.",
	".chm": "Compiled HTML Help (CHM) has no JavaScript reader.",
	".lit": "Microsoft Reader (LIT) has no JavaScript reader.",
	".lrf": "Sony BBeB (LRF) has no JavaScript reader.",
	".kfx": "KFX is Amazon's DRM-bound format and cannot be read.",
	".pages":
		"Apple Pages files have no JavaScript reader; export them as DOCX or PDF.",
	".key":
		"Apple Keynote files have no JavaScript reader; export them as PPTX or PDF.",
	".numbers":
		"Apple Numbers files have no JavaScript reader; export them as XLSX or CSV.",
	".xlsb":
		"Binary Excel workbooks (XLSB) are not read; save the workbook as XLSX.",
	".wps": "Microsoft Works documents are not read; save them as DOCX.",
	".cbz": "Comic archives are not read yet.",
	".cbr": "Comic archives are not read yet.",
};

/** Every extension this tool reads, for the tool description and read_files. */
export const DOCUMENT_EXTENSIONS: readonly string[] = Object.keys(BY_EXTENSION);

export type FormatVerdict =
	| { format: DocumentFormat }
	| { unsupported: string };

/**
 * The format of a file, from its extension and checked against its bytes.
 *
 * The bytes decide when the two disagree. A `.doc` that is really an RTF or a
 * DOCX is common (Word saves under whatever name it was opened as), and so is
 * a `.mobi` that is a KF8 file.
 */
export function detectFormat(
	filePath: string,
	head: Uint8Array,
): FormatVerdict {
	const extension = path.extname(filePath).toLowerCase();
	const unsupported = UNSUPPORTED[extension];
	if (unsupported) {
		return { unsupported };
	}
	const text = Buffer.from(head.subarray(0, 512)).toString("latin1");
	const byExtension = BY_EXTENSION[extension];
	if (text.startsWith("%PDF")) return { format: "pdf" };
	if (text.startsWith("{\\rtf")) return { format: "rtf" };
	if (text.slice(60, 68) === "BOOKMOBI") {
		return { format: byExtension === "azw3" ? "azw3" : "mobi" };
	}
	const isZip = text.startsWith("PK\u0003\u0004");
	const isOle = text.startsWith("ÐÏ\u0011à¡±\u001aá");
	if (isZip) {
		if (text.includes("mimetypeapplication/epub+zip"))
			return { format: "epub" };
		const odf =
			/mimetypeapplication\/vnd\.oasis\.opendocument\.(text|presentation|spreadsheet|graphics)/.exec(
				text,
			);
		if (odf) {
			return {
				format: (
					{
						text: "odt",
						presentation: "odp",
						spreadsheet: "ods",
						graphics: "odg",
					} as const
				)[odf[1] as "text" | "presentation" | "spreadsheet" | "graphics"],
			};
		}
		if (
			byExtension &&
			["docx", "pptx", "xlsx", "epub", "odt", "odp", "ods", "odg"].includes(
				byExtension,
			)
		) {
			return { format: byExtension };
		}
		// A legacy extension on an OOXML file: Word and Excel both do this.
		if (byExtension === "doc") return { format: "docx" };
		if (byExtension === "xls") return { format: "xlsx" };
		if (byExtension === "ppt") return { format: "pptx" };
	}
	if (isOle) {
		if (
			byExtension === "doc" ||
			byExtension === "xls" ||
			byExtension === "ppt"
		) {
			return { format: byExtension };
		}
		if (byExtension === "docx") return { format: "doc" };
		if (byExtension === "xlsx") return { format: "xls" };
		if (byExtension === "pptx") return { format: "ppt" };
		return {
			unsupported:
				"This is an OLE compound file, but its extension does not say which Office program wrote it; rename it to .doc, .xls or .ppt.",
		};
	}
	if (byExtension === "fb2" || /<FictionBook[\s>]/.test(text))
		return { format: "fb2" };
	if (byExtension === "html" || byExtension === "csv")
		return { format: byExtension };
	if (byExtension) {
		return {
			unsupported: `The file is named as ${FORMAT_LABELS[byExtension]} but its contents are not; it may be damaged or a different format.`,
		};
	}
	return {
		unsupported: `No reader for ${extension || "files without an extension"}. Readable: PDF, DOCX/DOC, PPTX/PPT, XLSX/XLS, ODT/ODP/ODS/ODG, RTF, CSV, HTML, EPUB, MOBI/AZW/AZW3, FB2.`,
	};
}

/** A unit a range can select: pages, slides, sheets or chapters. */
export type UnitName = "page" | "slide" | "sheet" | "chapter";

export interface ReadOptions {
	images: ImageCollector;
	/** Whether pictures are wanted at all (`images: "none"` skips the work). */
	wantImages: boolean;
	password?: string;
	/** Which units to read; undefined reads everything. */
	selects?: (unit: number) => boolean;
	/** A scratch directory inside the extraction directory, removed afterwards. */
	scratchDir: string;
	/**
	 * Reads the text of a scanned page from its pictures (OCR). Undefined when
	 * recognition is off; resolves undefined for a page it did not read.
	 */
	recognize?: (
		page: number,
		images: readonly PageImage[],
	) => Promise<RecognizedText | undefined>;
	/** Stops the read at the next page or chapter; the read throws. */
	signal?: AbortSignal;
	/** Called as the read moves: once a page or chapter, and around recognition. */
	onProgress?: (progress: ReadProgress) => void;
	/**
	 * Everything the read left out, a line each: a picture that could not be
	 * taken out, and why. The reader appends; nothing is left out silently.
	 */
	problems?: string[];
	/**
	 * Lines for the log, not for the reader of the document: what the PDF
	 * decoder warned about, a picture that needed asking for twice.
	 */
	onNote?: (line: string) => void;
}

/** Where a read is. */
export interface ReadProgress {
	unit: UnitName;
	/** The page or chapter being read, from 1. */
	at: number;
	total: number;
	/** Pictures taken out so far. */
	pictures: number;
	/** What it is doing there, when that is more than reading: "recognizing text". */
	activity?: string;
}

/** A picture a scanned page is drawn from, as a PNG. */
export interface PageImage {
	png: Uint8Array;
	width: number;
	height: number;
	/** Share of the page it covers, 0-1. */
	coverage: number;
}

export interface RecognizedText {
	text: string;
	/** Who read it, for the page's note: `tesseract (eng, 91%)`, `the vision model`. */
	by: string;
}

export interface DocumentReadResult {
	markdown: string;
	reader: string;
	title?: string;
	author?: string;
	/** How many units the document has, and what they are called. */
	units?: { name: UnitName; total: number; read: number[] };
	/** Chapter titles for an ebook, in reading order. */
	contents?: string[];
	/** Pages whose text is an image of text, for OCR. */
	scannedPages?: number[];
	/** Scanned pages whose text was recognized here, by `ReadOptions.recognize`. */
	recognizedPages?: number[];
	/** Pages scanned with a hidden text layer already on them. */
	ocrLayerPages?: number[];
	/** Pages drawn as shapes: no text and no pictures to read. */
	vectorPages?: number[];
	notes?: string[];
}

/** Formats that are binary: read as text, they are noise. */
const BINARY_FORMATS = new Set<DocumentFormat>([
	"pdf",
	"docx",
	"pptx",
	"xlsx",
	"odt",
	"odp",
	"ods",
	"odg",
	"epub",
	"mobi",
	"azw3",
	"doc",
	"xls",
	"ppt",
]);

/**
 * What `read_files` says instead of returning a binary document as text.
 *
 * Decided by the bytes, so a PDF saved as `.txt` is caught and an RTF, CSV,
 * HTML or FB2 file, which are text, is still read as text. Undefined for
 * everything else.
 */
export function unreadableDocumentMessage(
	filePath: string,
	head: Uint8Array,
	documentReader: boolean,
): string | undefined {
	const verdict = detectFormat(filePath, head);
	if (!("format" in verdict) || !BINARY_FORMATS.has(verdict.format)) {
		return undefined;
	}
	const what = `${path.basename(filePath)} is a ${FORMAT_LABELS[verdict.format]}, which read_files would return as unreadable bytes.`;
	return documentReader
		? `${what} Read it with extract_document instead.`
		: `${what} The extract_document tool reads it but is turned off in this session: the user can turn it on under Settings > Features, or give you the document as text.`;
}

import { randomBytes } from "node:crypto";
import {
	copyFileSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { AgentImageToDescribe, AgentToolContext } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtractDocumentInput } from "../schemas";
import {
	installedOcrLanguages,
	installOcrLanguages,
	parseOcrLanguages,
} from "./document/ocr";
import { altTextOf } from "./document/recognition";
import {
	createDocumentExtractExecutor,
	type DocumentExtractExecutorOptions,
	documentReaderExecutorOptions,
} from "./document-extract";

const FIXTURES = join(
	__dirname,
	"..",
	"..",
	"..",
	"..",
	"fixtures",
	"documents",
);
const BLIND = {} as AgentToolContext;
const SEEING = {
	metadata: { modelSupportsImages: true },
} as unknown as AgentToolContext;

let workspace: string;
let dataDir: string;

function place(name: string): string {
	copyFileSync(join(FIXTURES, name), join(workspace, name));
	return name;
}

async function run(
	input: Partial<ExtractDocumentInput> & { path: string },
	options: DocumentExtractExecutorOptions = {},
	context = BLIND,
) {
	const extract = createDocumentExtractExecutor({
		...options,
		reader: { ocrDataDir: dataDir, ...options.reader },
	});
	return extract(input as ExtractDocumentInput, workspace, context);
}

/** A vision model that answers from a script and records what it was asked. */
function fakeVision(
	answer: (image: AgentImageToDescribe) => string | undefined,
) {
	const asked: AgentImageToDescribe[] = [];
	const describeImages = async (images: readonly AgentImageToDescribe[]) => {
		asked.push(...images);
		return images.map(answer);
	};
	return { asked, describeImages };
}

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "extract-ocr-"));
	dataDir = mkdtempSync(join(tmpdir(), "tessdata-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
	rmSync(dataDir, { recursive: true, force: true });
});

describe("scanned pages", () => {
	it("recognizes a scanned page with tesseract by default", async () => {
		const result = String(await run({ path: place("scan-only.pdf") }));
		expect(result).toContain("invoice 4711");
		expect(result).toMatch(
			/Text recognized from the page image by tesseract \(eng, \d+% confidence\)/,
		);
		expect(result).toContain("Scanned pages 1: their text was recognized");
		// Never tesseract's default cache, which writes into the working directory.
		expect(
			readdirSync(workspace).some((name) => name.endsWith(".traineddata")),
		).toBe(false);
	}, 60_000);

	it("decodes and reads a CCITT bilevel scan", async () => {
		const result = String(await run({ path: place("scan-ccitt.pdf") }));
		expect(result).toContain("Quarterly report 2026");
		expect(result).toContain("Invoice number 4711 is overdue");
	}, 60_000);

	it("keeps recognized text out of pages that have a text layer", async () => {
		const result = String(await run({ path: place("probe.pdf") }));
		expect(result).not.toContain("Text recognized");
	});

	it('skips recognition for ocr: "none", and says so', async () => {
		const result = String(
			await run({ path: place("scan-only.pdf"), ocr: "none" }),
		);
		expect(result).not.toContain("invoice 4711");
		expect(result).toContain('Text recognition was skipped (ocr: "none")');
	});

	it("does no recognition when the user turned it off, whatever the call asks", async () => {
		const result = String(
			await run(
				{ path: place("scan-only.pdf"), ocr: "tesseract" },
				{ reader: { ocr: "off" } },
			),
		);
		expect(result).not.toContain("invoice 4711");
		expect(result).toContain("Text recognition (OCR) is turned off");
		expect(result).toContain("Settings > Features > Document Reader");
	});

	it("names a language that is not installed rather than guessing", async () => {
		const result = String(
			await run({ path: place("scan-only.pdf"), ocr_languages: "deu" }),
		);
		expect(result).toContain("OCR language deu is not installed");
		expect(result).not.toContain("invoice 4711");
	});

	it("asks the vision model to transcribe, when it is the chosen engine", async () => {
		const vision = fakeVision(() => "Scanned page: invoice 4711 (vision)");
		const result = String(
			await run(
				{ path: place("scan-only.pdf") },
				{ reader: { ocr: "vision" }, describeImages: vision.describeImages },
			),
		);
		expect(result).toContain("invoice 4711 (vision)");
		expect(result).toContain("by the vision model");
		expect(vision.asked).toHaveLength(1);
		expect(vision.asked[0]?.instruction).toMatch(/Transcribe all of its text/);
		expect(vision.asked[0]?.mediaType).toBe("image/png");
	});

	it("hands the page to a model that can see, when there is no vision model", async () => {
		const result = await run(
			{ path: place("scan-only.pdf"), ocr: "vision" },
			{},
			SEEING,
		);
		expect(Array.isArray(result)).toBe(true);
		const parts = result as { type: string; text?: string }[];
		expect(parts.filter((part) => part.type === "image")).toHaveLength(1);
		expect(parts[0]?.text).toContain(
			"attached below as images (no vision model is configured)",
		);
		expect(parts.some((part) => part.text === "Scanned page 1, to read:")).toBe(
			true,
		);
	});

	it("falls back to tesseract for a model that cannot see and no vision model", async () => {
		const result = String(
			await run({ path: place("scan-only.pdf"), ocr: "vision" }),
		);
		expect(result).toContain("invoice 4711");
		expect(result).toContain("so tesseract read the pages instead");
	}, 60_000);
});

describe("picture descriptions", () => {
	it("writes the vision model's description into the index and the alt text", async () => {
		const vision = fakeVision((image) =>
			image.instruction?.includes("Describe it")
				? "A solid red rectangle on a white ground."
				: undefined,
		);
		const result = String(
			await run(
				{ path: place("probe.docx"), describe_images: true },
				{ describeImages: vision.describeImages },
			),
		);
		expect(result).toContain(
			"![A solid red rectangle on a white ground.](images/image1.png)",
		);
		expect(result).toContain("2 of 2 picture(s) described by the vision model");
		const index = JSON.parse(
			readFileSync(
				join(workspace, ".cline/extracted/probe/images/index.json"),
				"utf8",
			),
		) as { images: { description?: string }[] };
		expect(index.images[0]?.description).toBe(
			"A solid red rectangle on a white ground.",
		);
		expect(vision.asked[0]?.context).toContain("probe.docx");
	});

	it("follows the user's setting when the call does not say", async () => {
		const vision = fakeVision(() => "Blue square.");
		const result = String(
			await run(
				{ path: place("probe.docx") },
				{
					reader: { describePictures: true },
					describeImages: vision.describeImages,
				},
			),
		);
		expect(result).toContain("![Blue square.]");
	});

	it("says why nothing was described without a vision model", async () => {
		const result = String(
			await run({ path: place("probe.docx"), describe_images: true }),
		);
		expect(result).toContain("no vision model is configured");
	});

	it("shortens a long description for the alt text", () => {
		const long = `${"A chart of shipments by month. ".repeat(20)}`;
		expect(altTextOf(long).length).toBeLessThanOrEqual(301);
		expect(altTextOf(long).endsWith(".")).toBe(true);
	});
});

describe("OCR languages", () => {
	it("parses codes from a setting or a call", () => {
		expect(parseOcrLanguages("eng+deu, fra")).toEqual(["eng", "deu", "fra"]);
		expect(parseOcrLanguages(["ENG", "eng"])).toEqual(["eng"]);
	});

	it("installs a language from its model, and refuses what is not one", async () => {
		const model = gzipSync(randomBytes(20_000));
		const fetched: string[] = [];
		const fetchStub = (async (url: string) => {
			fetched.push(url);
			if (url.includes("/xyz/")) return new Response("nope", { status: 404 });
			if (url.includes("/fra/"))
				return new Response("<html>error</html>", { status: 200 });
			return new Response(model, { status: 200 });
		}) as unknown as typeof fetch;
		const result = await installOcrLanguages(
			["deu", "xyz", "fra", "eng", "no such"],
			{
				dataDir,
				fetch: fetchStub,
			},
		);
		expect(result.installed).toEqual(["deu"]);
		expect(result.failed.map((failure) => failure.language)).toEqual([
			"xyz",
			"fra",
			"no such",
		]);
		expect(result.failed[0]?.reason).toContain("no model for this code");
		// English ships with the tool and is never downloaded.
		expect(fetched.some((url) => url.includes("/eng/"))).toBe(false);
		expect(fetched[0]).toBe(
			"https://cdn.jsdelivr.net/npm/@tesseract.js-data/deu/4.0.0_best_int/deu.traineddata.gz",
		);
		expect(await installedOcrLanguages(dataDir)).toEqual(["deu", "eng"]);
		expect(readdirSync(dataDir)).toEqual(["deu.traineddata.gz"]);
	});

	it("reads with an installed language beside the bundled English", async () => {
		// English copied in beside another model: tesseract takes one folder.
		const english = readFileSync(
			join(
				require.resolve("@tesseract.js-data/eng/package.json"),
				"..",
				"4.0.0_best_int",
				"eng.traineddata.gz",
			),
		);
		writeFileSync(join(dataDir, "osd.traineddata.gz"), english);
		const result = String(
			await run({ path: place("scan-only.pdf"), ocr_languages: "eng+osd" }),
		);
		expect(result).toContain("tesseract (eng+osd");
		expect(readdirSync(dataDir).sort()).toEqual([
			"eng.traineddata.gz",
			"osd.traineddata.gz",
		]);
	}, 60_000);
});

describe("session wiring", () => {
	it("gives the executor the settings and the vision model only when the tool is on", () => {
		const describeImages = async () => [];
		expect(
			documentReaderExecutorOptions({
				documentReader: { ocr: "vision" },
				describeImages,
			}),
		).toBeUndefined();
		expect(
			documentReaderExecutorOptions({
				enableExtractDocument: true,
				documentReader: { ocr: "vision" },
				describeImages,
			}),
		).toEqual({ reader: { ocr: "vision" }, describeImages });
	});
});

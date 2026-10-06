import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolContext } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtractDocumentInput } from "../schemas";
import { detectFormat } from "./document/formats";
import { parseUnitRange } from "./document/range";
import {
	createDocumentExtractExecutor,
	markdownToText,
	readDocumentForBook,
} from "./document-extract";
import { createFileReadExecutor } from "./file-read";

const FIXTURES = join(
	__dirname,
	"..",
	"..",
	"..",
	"..",
	"fixtures",
	"documents",
);
const CONTEXT = {} as AgentToolContext;

let workspace: string;
const extract = createDocumentExtractExecutor();

function place(name: string): string {
	copyFileSync(join(FIXTURES, name), join(workspace, name));
	return name;
}

async function run(
	input: Partial<ExtractDocumentInput> & { path: string },
	context = CONTEXT,
) {
	return extract(input as ExtractDocumentInput, workspace, context);
}

function imagesOf(stem: string): string[] {
	const dir = join(workspace, ".cline", "extracted", stem, "images");
	return existsSync(dir)
		? readdirSync(dir)
				.filter((name) => name !== "index.json")
				.sort()
		: [];
}

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "extract-document-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

describe("extract_document", () => {
	it("reads a DOCX to markdown, its pictures to files linked from the text", async () => {
		const result = String(await run({ path: place("probe.docx") }));
		expect(result).toContain("Word document (DOCX)");
		expect(result).toContain("# Probe document");
		expect(result).toMatch(/!\[[^\]]*\]\(images\/image1\.png\)/);
		expect(result).not.toContain("data:image");
		expect(imagesOf("probe")).toEqual(["image1.png", "image2.png"]);
		const written = readFileSync(
			join(workspace, ".cline/extracted/probe/probe.md"),
			"utf8",
		);
		expect(written).toContain("cell A");
	});

	it("reads a PDF per page, with its pictures as PNGs", async () => {
		const result = String(await run({ path: place("probe.pdf") }));
		expect(result).toContain("## Page 1");
		expect(result).toContain("First paragraph with a red picture below.");
		const images = imagesOf("probe");
		expect(images).toHaveLength(2);
		const png = readFileSync(
			join(workspace, ".cline/extracted/probe/images", images[0] as string),
		);
		expect(png.subarray(1, 4).toString()).toBe("PNG");
	});

	it("names a scanned page, with or without a stamped page number", async () => {
		expect(String(await run({ path: place("scan-only.pdf") }))).toContain(
			"Scanned pages 1:",
		);
		expect(String(await run({ path: place("scan-stamped.pdf") }))).toContain(
			"Scanned pages 1-2:",
		);
	});

	it("keeps the text layer of a scan that was already recognized", async () => {
		const result = String(await run({ path: place("scan-ocrd.pdf") }));
		expect(result).not.toContain("Scanned pages");
		expect(result).toContain("already carry a recognized text layer");
		expect(result).toContain("invoice 4711");
	});

	it("reads only the pages a range selects", async () => {
		const result = String(
			await run({ path: place("scan-ocrd.pdf"), range: "2" }),
		);
		expect(result).toContain("2 pages; read pages 2.");
		expect(result).not.toContain("## Page 1");
		expect(
			existsSync(join(workspace, ".cline/extracted/scan-ocrd/scan-ocrd.2.md")),
		).toBe(true);
	});

	it("asks for the password of an encrypted PDF", async () => {
		await expect(run({ path: place("op-encrypted.pdf") })).rejects.toThrow(
			/password-protected/,
		);
	});

	it.each([
		"probe.epub",
		"probe.mobi",
		"probe.azw3",
		"probe.fb2",
	])("reads the ebook %s by chapter", async (name) => {
		const result = String(await run({ path: place(name) }));
		expect(result).toMatch(/\d+ chapters?\./);
		expect(result).toContain("First paragraph with a red picture below.");
		expect(result).not.toMatch(/<\/?p>/);
	});

	it("says an EPUB cut short is damaged instead of waiting on it", async () => {
		// The first two thirds of a real book: entries, and no index at the end.
		const whole = place("probe.epub");
		const cut = "cut.epub";
		writeFileSync(
			join(workspace, cut),
			readFileSync(join(workspace, whole)).subarray(
				0,
				Math.floor(statSync(join(workspace, whole)).size * 0.66),
			),
		);
		const started = Date.now();
		await expect(run({ path: cut })).rejects.toThrow(
			/damaged: it ends before its index/,
		);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("reads a book's text alone when the pictures are not wanted", async () => {
		const file = join(workspace, place("probe.epub"));
		const scratchDir = join(workspace, "scratch");
		const whole = await readDocumentForBook(file, { scratchDir });
		const text = await readDocumentForBook(file, {
			scratchDir,
			pictures: false,
		});
		expect(whole.images.length).toBeGreaterThanOrEqual(2);
		expect(text.images).toEqual([]);
		expect(text.markdown).toContain(
			"First paragraph with a red picture below.",
		);
	});

	it("takes an ebook's pictures before the reader deletes them", async () => {
		await run({ path: place("probe.epub") });
		const images = imagesOf("probe");
		expect(images.length).toBeGreaterThanOrEqual(2);
		expect(
			existsSync(
				join(
					workspace,
					".cline/extracted/probe",
					readdirSync(join(workspace, ".cline/extracted/probe")).find((n) =>
						n.startsWith(".scratch"),
					) ?? "none",
				),
			),
		).toBe(false);
	});

	it("reads Word 97-2003 with its pictures", async () => {
		const result = String(await run({ path: place("two_images.doc") }));
		expect(result).toContain("the jpg file");
		expect(result).not.toContain("image-base64");
		expect(imagesOf("two_images").map((name) => name.split(".").pop())).toEqual(
			["jpg", "png"],
		);
	});

	it("finds a picture office_oxide does not place, and lists it after the text", async () => {
		const result = String(await run({ path: place("PngPicture.doc") }));
		expect(result).toContain("Pictures not placed in the text");
		expect(imagesOf("PngPicture")).toHaveLength(1);
	});

	it("reads Excel and PowerPoint 97-2003, inflating their metafiles", async () => {
		const xls = String(await run({ path: place("SimpleWithImages.xls") }));
		expect(xls).toContain("Sheet1");
		const ppt = String(await run({ path: place("pictures.ppt") }));
		expect(ppt).toContain("Slide 1");
		const kinds = imagesOf("pictures").map((name) => name.split(".").pop());
		expect(kinds).toContain("jpg");
		expect(kinds).toContain("png");
		expect(kinds.some((kind) => kind === "emf" || kind === "wmf")).toBe(true);
		expect(ppt).toContain("not viewable as they are");
	});

	it("reads a range of slides", async () => {
		const result = String(
			await run({ path: place("op-test.pptx"), range: "1" }),
		);
		expect(result).toMatch(/\d+ slides; read slides 1\./);
	});

	it("returns plain text when asked", async () => {
		const result = String(
			await run({ path: place("probe.docx"), format: "text" }),
		);
		expect(result).not.toContain("# Probe document");
		expect(result).toContain("[image: images/image1.png]");
		expect(
			existsSync(join(workspace, ".cline/extracted/probe/probe.txt")),
		).toBe(true);
	});

	it("skips pictures when told to", async () => {
		const result = String(
			await run({ path: place("probe.docx"), images: "none" }),
		);
		expect(result).toContain('Pictures were not extracted (images: "none").');
		expect(imagesOf("probe")).toEqual([]);
	});

	it("attaches pictures only for a model that can see them", async () => {
		const blind = await run({ path: place("probe.docx"), images: "inline" });
		expect(typeof blind).toBe("string");
		expect(String(blind)).toContain("does not take image input");
		const seeing = await run({ path: "probe.docx", images: "inline" }, {
			metadata: { modelSupportsImages: true },
		} as unknown as AgentToolContext);
		expect(Array.isArray(seeing)).toBe(true);
		expect(
			(seeing as { type: string }[]).filter((part) => part.type === "image"),
		).toHaveLength(2);
	});

	it("writes where output_dir says, and nowhere outside the workspace", async () => {
		await run({ path: place("probe.docx"), output_dir: "docs/probe" });
		expect(existsSync(join(workspace, "docs/probe/probe.md"))).toBe(true);
		await expect(
			run({ path: "probe.docx", output_dir: "../elsewhere" }),
		).rejects.toThrow(/outside the workspace/);
	});

	it("cuts a long text at max_chars and says where the rest is", async () => {
		const result = String(
			await run({ path: place("probe.pdf"), max_chars: 1000 }),
		);
		expect(result).not.toContain("[Cut at");
		const long = String(
			await run({ path: place("op-test.pptx"), max_chars: 1000 }),
		);
		expect(long).toContain("[Cut at 1,000 of");
		expect(long).toContain(".cline/extracted/op-test/op-test.md");
	});

	it("says why it cannot read a format", async () => {
		const djvu = join(workspace, "book.djvu");
		copyFileSync(join(FIXTURES, "probe.pdf"), djvu);
		await expect(run({ path: "book.djvu" })).rejects.toThrow(/DjVu/);
	});
});

describe("read_files on a document", () => {
	it("says what the file is instead of returning its bytes", async () => {
		const pdf = place("probe.pdf");
		const withTool = createFileReadExecutor({
			cwd: workspace,
			documentReader: true,
		});
		await expect(withTool({ path: pdf }, CONTEXT)).rejects.toThrow(
			/is a PDF.*Read it with extract_document/,
		);
		const without = createFileReadExecutor({ cwd: workspace });
		await expect(without({ path: pdf }, CONTEXT)).rejects.toThrow(
			/turned off in this session/,
		);
	});

	it("still reads the formats that are text", async () => {
		const rtf = place("probe.rtf");
		const read = createFileReadExecutor({
			cwd: workspace,
			documentReader: true,
		});
		expect(String(await read({ path: rtf }, CONTEXT))).toContain("{\\rtf");
	});
});

describe("format detection", () => {
	it("believes the bytes over the name", () => {
		const docx = readFileSync(join(FIXTURES, "probe.docx"));
		expect(detectFormat("letter.doc", docx)).toEqual({ format: "docx" });
		const rtf = readFileSync(join(FIXTURES, "probe.rtf"));
		expect(detectFormat("letter.doc", rtf)).toEqual({ format: "rtf" });
		const ole = readFileSync(join(FIXTURES, "two_images.doc"));
		expect(detectFormat("letter.docx", ole)).toEqual({ format: "doc" });
	});
});

describe("range", () => {
	it("parses units, spans and an open end", () => {
		const range = parseUnitRange("1-3, 7,10-");
		expect(
			[1, 3, 4, 7, 9, 10, 500].map((unit) => range?.selects(unit)),
		).toEqual([true, true, false, true, false, true, true]);
	});

	it("says what is wrong with a range it cannot read", () => {
		expect(() => parseUnitRange("pages 1 to 3")).toThrow(/one-based numbers/);
		expect(() => parseUnitRange("5-2")).toThrow(/low to high/);
	});
});

describe("markdown to text", () => {
	it("keeps the words and the picture files", () => {
		expect(
			markdownToText(
				"# Title {#title}\n\n**bold** and *it*\n\n![logo](images/a.png)",
			),
		).toBe("Title\n\nbold and it\n\n[image: logo (images/a.png)]");
	});
});

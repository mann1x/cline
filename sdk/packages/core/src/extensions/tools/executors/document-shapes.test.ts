/**
 * Documents whose shape the reader used to misdescribe: a scan inside a form
 * object read as a blank page, a tiled scan never recognized, a photo with a
 * caption said to have "no text layer", an encrypted DOCX reported as a
 * broken Word file, a JPEG 2000 called "EMF, WMF, PICT, TIFF or BMP", and
 * every killed reader called out of memory (automaticum audit 2026-11-08,
 * readers 12 and 28, d2-d4).
 */

import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolContext } from "@cline/shared";
import * as CFB from "cfb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtractDocumentInput } from "../schemas";
import { formatName, ImageCollector } from "./document/images";
import { describeReaderExit } from "./document/read-process";
import { createDocumentExtractExecutor } from "./document-extract";

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

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "document-shapes-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

async function run(
	input: Partial<ExtractDocumentInput> & { path: string },
	context = BLIND,
) {
	const extract = createDocumentExtractExecutor();
	return extract(input as ExtractDocumentInput, workspace, context);
}

function text(result: unknown): string {
	return Array.isArray(result)
		? result.map((part: { text?: string }) => part.text ?? "").join("\n")
		: String(result);
}

function place(name: string): string {
	copyFileSync(join(FIXTURES, name), join(workspace, name));
	return name;
}

/** A PDF from object bodies; object 1 is the catalog. */
function writePdf(name: string, objects: Buffer[]): string {
	const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
	let length = parts[0].length;
	const offsets: number[] = [];
	objects.forEach((body, index) => {
		offsets.push(length);
		const chunk = Buffer.concat([
			Buffer.from(`${index + 1} 0 obj\n`),
			body,
			Buffer.from("\nendobj\n"),
		]);
		parts.push(chunk);
		length += chunk.length;
	});
	const xref = [
		"xref",
		`0 ${objects.length + 1}`,
		"0000000000 65535 f ",
		...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
		"trailer",
		`<< /Size ${objects.length + 1} /Root 1 0 R >>`,
		"startxref",
		String(length),
		"%%EOF",
		"",
	].join("\n");
	parts.push(Buffer.from(xref));
	writeFileSync(join(workspace, name), Buffer.concat(parts));
	return name;
}

function stream(dictionary: string, data: Buffer | string): Buffer {
	const bytes = typeof data === "string" ? Buffer.from(data) : data;
	return Buffer.concat([
		Buffer.from(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`),
		bytes,
		Buffer.from("\nendstream"),
	]);
}

/** A grey gradient: decodable, with nothing a recognizer would call text. */
function grey(width: number, height: number): Buffer {
	const data = Buffer.alloc(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++)
			data[y * width + x] = (x * 7 + y * 13) % 256;
	}
	return stream(
		`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8`,
		data,
	);
}

const CATALOG = Buffer.from("<< /Type /Catalog /Pages 2 0 R >>");
const PAGES = Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
const page = (resources: string) =>
	Buffer.from(
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << ${resources} >> /Contents 4 0 R >>`,
	);

describe("PDF page shapes", () => {
	it("sees a full-page scan drawn inside a form object", async () => {
		const name = writePdf("form-scan.pdf", [
			CATALOG,
			PAGES,
			page("/XObject << /Fm1 5 0 R >>"),
			stream("", "/Fm1 Do\n"),
			stream(
				"/Type /XObject /Subtype /Form /BBox [0 0 1 1] /Matrix [612 0 0 792 0 0] /Resources << /XObject << /Im1 6 0 R >> >>",
				"/Im1 Do\n",
			),
			grey(300, 400),
		]);
		const result = text(await run({ path: name, ocr: "none", images: "none" }));
		expect(result).toContain("Scanned pages 1");
		expect(result).not.toContain("no text and no picture");
	});

	it("recognizes a scan drawn as strips no one of which is the page", async () => {
		const strips = 20;
		const height = 792 / strips;
		const objects = [
			CATALOG,
			PAGES,
			page(
				`/XObject << ${Array.from({ length: strips }, (_, i) => `/S${i} ${5 + i} 0 R`).join(" ")} >>`,
			),
			stream(
				"",
				Array.from(
					{ length: strips },
					(_, i) => `q 612 0 0 ${height} 0 ${i * height} cm /S${i} Do Q`,
				).join("\n"),
			),
			...Array.from({ length: strips }, () => grey(200, 13)),
		];
		const name = writePdf("tiled-scan.pdf", objects);
		const result = await run(
			{ path: name, ocr: "vision", images: "none" },
			SEEING,
		);
		const parts = result as { type: string; text?: string }[];
		expect(Array.isArray(parts)).toBe(true);
		// The strips went to the model that can see: before, recognition was
		// never asked and the page was reported as unreadable.
		expect(parts.some((part) => part.type === "image")).toBe(true);
		expect(text(result)).toContain("attached below as images");
	});

	it("does not say 'no text layer' of a photo with its caption printed", async () => {
		const name = writePdf("photo-caption.pdf", [
			CATALOG,
			PAGES,
			page("/XObject << /Im1 5 0 R >> /Font << /F1 6 0 R >>"),
			stream(
				"",
				"q 612 0 0 700 0 92 cm /Im1 Do Q\nBT /F1 14 Tf 50 40 Td (Figure 1: Sunset over the bay, 1998.) Tj ET\n",
			),
			grey(300, 300),
			Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
		]);
		const result = text(await run({ path: name, ocr: "none", images: "none" }));
		expect(result).toContain("Figure 1: Sunset over the bay, 1998.");
		expect(result).not.toContain("an image of text with no text layer");
		expect(result).toContain("little or no text layer");
	});

	it("names a page with no text and no picture instead of an empty heading", async () => {
		const name = writePdf("blank.pdf", [
			CATALOG,
			PAGES,
			page(""),
			stream("", ""),
		]);
		const result = text(await run({ path: name, images: "none" }));
		expect(result).toContain(
			"have no text and no picture this reader found: blank, or drawn in a way it does not extract",
		);
	});

	it("says a range of nothing is a range of nothing", async () => {
		const result = text(await run({ path: place("probe.pdf"), range: "99" }));
		expect(result).toContain("the range selects nothing that exists");
		expect(result).toContain("(The selected range has no text.)");
	});
});

describe("Office units", () => {
	it("reads one sheet of an Excel 97-2003 workbook by range", async () => {
		const result = text(
			await run({
				path: place("SimpleWithImages.xls"),
				range: "1",
				images: "none",
			}),
		);
		expect(result).toMatch(/\d+ sheets; read sheet 1\./);
		expect(result).not.toContain("range was ignored");
	});

	it("reads one slide of a PowerPoint 97-2003 deck by range", async () => {
		const result = text(
			await run({ path: place("pictures.ppt"), range: "1", images: "none" }),
		);
		expect(result).toMatch(/\d+ slides?; read slide 1\./);
		expect(result).not.toContain("range was ignored");
	});
});

describe("ebook contents", () => {
	it("gives each contents entry the chapter a range reaches it by", async () => {
		const result = text(
			await run({ path: place("probe.epub"), range: "1", images: "none" }),
		);
		// Chapter 1 is the title page: the contents must not read as if the
		// first entry were it.
		expect(result).toContain("Probe document (chapter 2)");
		expect(result).toContain("read chapter 1.");
		expect(result).not.toContain("Second section (chapter");
	});
});

describe("encrypted Office files", () => {
	function encryptedDocx(): string {
		const container = CFB.utils.cfb_new();
		CFB.utils.cfb_add(
			container,
			"/EncryptionInfo",
			Buffer.concat([
				Buffer.from([4, 0, 4, 0, 0x40, 0, 0, 0]),
				Buffer.from(
					'<?xml version="1.0"?><encryption xmlns="http://schemas.microsoft.com/office/2006/encryption"><keyData saltSize="16" blockSize="16" keyBits="256" hashSize="64" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="SHA512" saltValue="AAAAAAAAAAAAAAAAAAAAAA=="/></encryption>',
				),
			]),
		);
		CFB.utils.cfb_add(container, "/EncryptedPackage", Buffer.alloc(4096, 7));
		writeFileSync(
			join(workspace, "secret.docx"),
			CFB.write(container, { type: "buffer" }) as Buffer,
		);
		return "secret.docx";
	}

	it("asks for the password of an encrypted DOCX, not for a WordDocument stream", async () => {
		await expect(run({ path: encryptedDocx() })).rejects.toThrow(
			/password-protected\. Ask the user for the password/,
		);
	});

	it("says a given password did not open it", async () => {
		await expect(
			run({ path: encryptedDocx(), password: "hunter2" }),
		).rejects.toThrow(/not the one given in `password`|cannot open/);
	});
});

describe("a path that is not a document", () => {
	it("calls a pipe a pipe, not a directory", async () => {
		const { spawnSync } = await import("node:child_process");
		const fifo = join(workspace, "pipe.pdf");
		if (spawnSync("mkfifo", [fifo]).status !== 0) return;
		await expect(run({ path: "pipe.pdf" })).rejects.toThrow(
			/not a regular file \(a pipe, socket or device\)/,
		);
	});

	it("calls a directory a directory", async () => {
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(workspace, "folder.pdf"));
		await expect(run({ path: "folder.pdf" })).rejects.toThrow(
			"is a directory, not a document",
		);
	});

	it("says a missing file is missing", async () => {
		await expect(run({ path: "nothing-here.pdf" })).rejects.toThrow(
			/^No file at nothing-here\.pdf/,
		);
	});
});

describe("pictures that cannot be viewed", () => {
	it("calls a JPEG 2000 what it is", () => {
		const collector = new ImageCollector();
		const image = collector.add({
			data: new Uint8Array([
				0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a, 1, 2, 3,
				4,
			]),
			stem: "image1.jp2",
		});
		expect(image?.file).toBe("image1.jp2");
		expect(image?.mediaType).toBe("image/jp2");
		expect(image?.notViewable).toBe(true);
		expect(formatName("image/jp2")).toBe("JP2");
		expect(formatName("application/x-unknown")).toBe("application/x-unknown");
	});
});

describe("a reader that ended without an answer", () => {
	const progress = { unit: "page", at: 3, total: 10, pictures: 0 } as never;

	it("does not call a kill out of memory when nothing says so", () => {
		const message = describeReaderExit(null, "SIGKILL", "", progress);
		expect(message).toContain("killed from outside");
		expect(message).not.toContain("it ran out of memory");
	});

	it("calls a failed assertion a decoder failure", () => {
		const message = describeReaderExit(
			null,
			"SIGABRT",
			"Assertion failed: idx < size",
			progress,
		);
		expect(message).toContain("failed an internal check");
		expect(message).not.toContain("memory");
	});

	it("says out of memory when the runtime says so", () => {
		const message = describeReaderExit(
			null,
			"SIGABRT",
			"FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
			progress,
		);
		expect(message).toContain("it ran out of memory");
	});
});

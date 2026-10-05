import { describe, expect, it } from "vitest";
import { asDirectoryUrl, pdfjsDocumentOptions } from "./pdfjs";

describe("pdf.js asset directories", () => {
	it("end in a forward slash whatever the platform's separator", () => {
		// pdf.js throws "must include trailing slash" on anything else, which
		// failed every PDF on Windows while the separator was the platform's.
		expect(asDirectoryUrl("C:\\ext\\dist\\pdfjs\\wasm")).toBe(
			"C:\\ext\\dist\\pdfjs\\wasm/",
		);
		expect(asDirectoryUrl("C:\\ext\\dist\\pdfjs\\wasm\\")).toBe(
			"C:\\ext\\dist\\pdfjs\\wasm/",
		);
		expect(asDirectoryUrl("/ext/dist/pdfjs/wasm/")).toBe(
			"/ext/dist/pdfjs/wasm/",
		);
		expect(asDirectoryUrl(undefined)).toBeUndefined();
	});

	it("are both found: the decoders and the character maps", () => {
		// The maps were probed for by a file pdf.js does not ship, so CJK
		// text was read without them everywhere.
		const options = pdfjsDocumentOptions();
		expect(options.wasmUrl).toBeDefined();
		expect(options.cMapUrl).toBeDefined();
		expect(options.cMapPacked).toBe(true);
	});

	it("are handed to pdf.js in that form", () => {
		const options = pdfjsDocumentOptions();
		for (const key of ["wasmUrl", "cMapUrl"]) {
			const value = options[key];
			if (value !== undefined) expect(String(value)).toMatch(/[^\\/]\/$/);
		}
	});
});

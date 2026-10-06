import { describe, expect, it } from "vitest";
import { chunkText, type TextChunk } from "./chunker";

const sentence = (n: number) => `Sentence number ${n} says a little something.`;
const paragraph = (from: number, count: number) =>
	Array.from({ length: count }, (_, i) => sentence(from + i)).join(" ");

function expectSlices(source: string, chunks: TextChunk[]) {
	chunks.forEach((chunk, index) => {
		expect(chunk.index).toBe(index);
		expect(source.slice(chunk.start, chunk.end)).toBe(chunk.text);
		expect(chunk.text).toBe(chunk.text.trim());
		expect(chunk.text.length).toBeGreaterThan(0);
	});
}

describe("chunkText", () => {
	it("returns a short text as one chunk, and nothing for blank text", () => {
		const chunks = chunkText("  Just this.  ");
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({ text: "Just this.", start: 2, end: 12 });
		expect(chunkText(" \n\n ")).toEqual([]);
	});

	it("keeps every chunk within the size, as a slice of the source", () => {
		const source = Array.from({ length: 12 }, (_, i) =>
			paragraph(i * 10, 6),
		).join("\n\n");
		const chunks = chunkText(source, { size: 400, overlap: 0 });
		expect(chunks.length).toBeGreaterThan(5);
		expectSlices(source, chunks);
		for (const chunk of chunks) {
			expect(chunk.text.length).toBeLessThanOrEqual(400);
		}
		// With no overlap nothing is repeated and nothing but whitespace is lost.
		expect(
			chunks
				.map((c) => c.text)
				.join("")
				.replace(/\s/g, ""),
		).toBe(source.replace(/\s/g, ""));
	});

	it("cuts at paragraphs before sentences, and at sentences before words", () => {
		const source = `${paragraph(0, 3)}\n\n${paragraph(10, 3)}`;
		const byParagraph = chunkText(source, { size: 150, overlap: 0 });
		expect(byParagraph.map((c) => c.text)).toEqual([
			paragraph(0, 3),
			paragraph(10, 3),
		]);
		const bySentence = chunkText(paragraph(0, 4), { size: 100, overlap: 0 });
		for (const chunk of bySentence) {
			expect(chunk.text.endsWith(".")).toBe(true);
			expect(chunk.text.startsWith("Sentence")).toBe(true);
		}
	});

	it("cuts mid-word only when a word is longer than the size", () => {
		const source = "x".repeat(250);
		const chunks = chunkText(source, { size: 100, overlap: 0 });
		expect(chunks.map((c) => c.text.length)).toEqual([100, 100, 50]);
		expectSlices(source, chunks);
	});

	it("starts each chunk inside the end of the one before, by at most the overlap", () => {
		const source = paragraph(0, 30);
		const chunks = chunkText(source, { size: 300, overlap: 100 });
		expectSlices(source, chunks);
		expect(chunks.length).toBeGreaterThan(3);
		for (let i = 1; i < chunks.length; i++) {
			const shared = chunks[i - 1].end - chunks[i].start;
			expect(shared).toBeGreaterThan(0);
			expect(shared).toBeLessThanOrEqual(100);
			expect(chunks[i].start).toBeGreaterThan(chunks[i - 1].start);
			expect(chunks[i].text.length).toBeLessThanOrEqual(300);
		}
	});

	it("splits at markdown headers and records the headers above each chunk", () => {
		const source = [
			"Intro before any header.",
			"# Guide",
			"About the guide.",
			"## Install",
			"Run the installer.",
			"```",
			"# not a header, a comment in code",
			"```",
			"### Windows",
			"Use the exe.",
			"## Usage",
			"Call it.",
		].join("\n");
		const chunks = chunkText(source);
		expectSlices(source, chunks);
		expect(chunks.map((c) => c.headings)).toEqual([
			[],
			["Guide"],
			["Guide", "Install"],
			["Guide", "Install", "Windows"],
			["Guide", "Usage"],
		]);
		expect(chunks[2].text).toContain("# not a header");
		expect(chunkText(source, { markdownHeaders: false })).toHaveLength(1);
	});

	it("merges chunks below the minimum into a neighbour when the result fits", () => {
		const source = [
			"# A",
			"Tiny.",
			"# B",
			paragraph(0, 4),
			"# C",
			"Also tiny.",
		].join("\n");
		const plain = chunkText(source, { size: 400 });
		expect(plain).toHaveLength(3);
		const merged = chunkText(source, { size: 400, minSize: 60 });
		expectSlices(source, merged);
		// "A" grows forward into "B"; "C" cannot grow forward and joins backward.
		expect(merged).toHaveLength(1);
		expect(merged[0].headings).toEqual(["A"]);
		// Nothing merges past the size.
		const tight = chunkText(source, { size: 200, minSize: 60 });
		for (const chunk of tight) {
			expect(chunk.text.length).toBeLessThanOrEqual(200);
		}
	});

	it("counts in estimated tokens, or with the counter it is given", () => {
		const source = paragraph(0, 40);
		const byTokens = chunkText(source, {
			size: 100,
			overlap: 0,
			unit: "tokens",
		});
		for (const chunk of byTokens) {
			expect(Math.ceil(chunk.text.length / 4)).toBeLessThanOrEqual(100);
		}
		expect(byTokens.length).toBeLessThan(
			chunkText(source, { size: 100, overlap: 0 }).length,
		);
		const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
		const byWords = chunkText(source, { size: 21, overlap: 0, measure: words });
		for (const chunk of byWords) {
			expect(words(chunk.text)).toBeLessThanOrEqual(21);
		}
	});

	it("ends on a huge input", () => {
		const source = Array.from({ length: 4000 }, (_, i) => paragraph(i, 3)).join(
			"\n\n",
		);
		const started = Date.now();
		const chunks = chunkText(source, { size: 1500, overlap: 100 });
		expect(chunks.length).toBeGreaterThan(300);
		expect(Date.now() - started).toBeLessThan(5000);
	});
});

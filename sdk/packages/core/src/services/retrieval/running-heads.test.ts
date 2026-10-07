import { describe, expect, it } from "vitest";
import {
	documentIdentity,
	namingHead,
	runningHeads,
	sameDocument,
} from "./running-heads";

/** A document as the reader writes a PDF: `## Page N`, a running head, a page number. */
function paged(
	head: string,
	pages = 10,
	body = (page: number) => `Register ${page} holds the state of the core.`,
) {
	return Array.from(
		{ length: pages },
		(_unused, at) =>
			`## Page ${at + 1}\n\n${head}\n${body(at)}\nBits Description\n${at + 1}\n`,
	).join("\n");
}

describe("running heads", () => {
	it("finds the line on most pages, and leaves out a page number and a short label", () => {
		const heads = runningHeads(
			paged(
				"55803 Rev 0.54 - Sep 12, 2019 PPR for AMD Family 17h Model 31h B0",
			),
		);
		expect(heads).toEqual([
			"55803 rev 0.54 - sep 12, 2019 ppr for amd family 17h model 31h b0",
		]);
	});

	it("finds none in a document without pages, or with too few", () => {
		expect(
			runningHeads("# Chapter 1\n\nA story about the sea and a boat."),
		).toEqual([]);
		expect(
			runningHeads(paged("56176 Rev 3.06 PPR for AMD Family 17h Model 71h", 3)),
		).toEqual([]);
	});

	it("reads the document's identity, without its revision and date", () => {
		expect(
			documentIdentity(
				runningHeads(
					paged(
						"55803 Rev 0.54 - Sep 12, 2019 PPR for AMD Family 17h Model 31h B0",
					),
				),
			),
		).toEqual(["17h", "31h", "55803", "b0"]);
		expect(
			documentIdentity(["24593—rev. 3.41—june 2023 amd64 technology"]),
		).toEqual(["24593", "64"]);
		expect(
			documentIdentity(["no fix planned", "potential effect on system"]),
		).toEqual([]);
	});

	it("tells revisions of one document from different documents that share their text", () => {
		const v104 = runningHeads(
			paged(
				"56683 Rev 1.04 - Nov 2021 Revision Guide for AMD Family 19h Models 00h-0Fh",
			),
		);
		const v107 = runningHeads(
			paged(
				"56683 Rev 1.07 - March 05, 2023 Revision Guide for AMD Family 19h Models 00h-0Fh",
			),
		);
		const other = runningHeads(
			paged(
				"57095 Rev 1.01 - Nov 2021 Revision Guide for AMD Family 19h Models 10h-1Fh",
			),
		);
		expect(sameDocument(v104, v107)).toBe(true);
		expect(sameDocument(v104, other)).toBe(false);
		// Volumes of one set differ by their volume number.
		expect(
			sameDocument(
				runningHeads(
					paged(
						"55901 Rev 0.25 - Oct 6, 2022 PPR Vol 1 for AMD Family 19h Model 11h B1",
					),
				),
				runningHeads(
					paged(
						"55901 Rev 0.25 - Oct 6, 2022 PPR Vol 2 for AMD Family 19h Model 11h B1",
					),
				),
			),
		).toBe(false);
	});

	it("says nothing when either has no identity, and names the document by the head that has one", () => {
		const heads = runningHeads(
			paged(
				"56683 Rev 1.04 - Nov 2021 Revision Guide for AMD Family 19h Models 00h-0Fh",
			),
		);
		expect(sameDocument(heads, [])).toBeUndefined();
		expect(sameDocument(heads, ["no fix planned"])).toBeUndefined();
		expect(namingHead(["no fix planned", ...heads])).toBe(heads[0]);
	});
});

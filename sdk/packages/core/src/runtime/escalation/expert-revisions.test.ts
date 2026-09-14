import { describe, expect, it } from "vitest";
import type { Snapshot } from "../atomic/snapshot";
import { createExpertRevisions } from "./expert-revisions";

function snapshotOf(files: Record<string, string>, root = "/ws"): Snapshot {
	return {
		root,
		skipped: [],
		files: new Map(
			Object.entries(files).map(([path, body]) => [
				path,
				{ hash: body, body: Buffer.from(body) },
			]),
		),
	};
}

describe("createExpertRevisions", () => {
	it("holds no claim on the workspace until an escalation opens one", () => {
		const revisions = createExpertRevisions();
		expect(revisions.source.pending).toBeUndefined();
		expect(revisions.revisions("/ws/a.html")).toEqual([]);
	});

	it("makes the file as the escalation opened revision #1", () => {
		const revisions = createExpertRevisions();
		revisions.open(snapshotOf({ "/ws/a.html": "one" }), 1);

		revisions.source.log.seed("/ws/a.html", Buffer.from("one"));
		revisions.source.log.record("/ws/a.html", Buffer.from("two"), "editor");

		const held = revisions.revisions("/ws/a.html");
		expect(held).toHaveLength(2);
		expect(held[0]?.index).toBe(1);
		expect(held[0]?.body?.toString()).toBe("one");
		expect(held[1]?.body?.toString()).toBe("two");
		expect(held[1]?.by).toBe("editor");
	});

	it("reports the escalation it is holding revisions for", () => {
		const revisions = createExpertRevisions();
		revisions.open(snapshotOf({ "/ws/a.html": "one" }), 2);
		expect(revisions.source.transaction).toBe(2);
	});

	// The base model reads these to check a claim the expert made about a file
	// that has since moved. Once the escalation is over there is no claim left
	// to check, and every revision is a copy of a file held in memory.
	it("purges everything when the escalation ends", () => {
		const revisions = createExpertRevisions();
		revisions.open(snapshotOf({ "/ws/a.html": "one" }), 1);
		revisions.source.log.seed("/ws/a.html", Buffer.from("one"));
		revisions.source.log.record("/ws/a.html", Buffer.from("two"), "editor");
		expect(revisions.revisions("/ws/a.html")).toHaveLength(2);

		revisions.purge();

		expect(revisions.revisions("/ws/a.html")).toEqual([]);
		expect(revisions.source.pending).toBeUndefined();
	});

	// A second escalation is a second question, asked against a workspace the
	// first one changed. Carrying #1 over would make "as the escalation opened"
	// name a state two escalations old.
	it("starts the numbering again when a second escalation opens", () => {
		const revisions = createExpertRevisions();
		revisions.open(snapshotOf({ "/ws/a.html": "one" }), 1);
		revisions.source.log.seed("/ws/a.html", Buffer.from("one"));
		revisions.source.log.record("/ws/a.html", Buffer.from("two"), "editor");

		revisions.open(snapshotOf({ "/ws/a.html": "two" }), 2);
		revisions.source.log.seed("/ws/a.html", Buffer.from("two"));
		revisions.source.log.record("/ws/a.html", Buffer.from("three"), "editor");

		const held = revisions.revisions("/ws/a.html");
		expect(held).toHaveLength(2);
		expect(held[0]?.body?.toString()).toBe("two");
		expect(revisions.source.transaction).toBe(2);
	});

	it("names the files it is holding anything for", () => {
		const revisions = createExpertRevisions();
		revisions.open(snapshotOf({ "/ws/a.html": "one" }), 1);
		revisions.source.log.seed("/ws/a.html", Buffer.from("one"));
		revisions.source.log.record("/ws/a.html", Buffer.from("two"), "editor");
		expect(revisions.tracked()).toEqual(["/ws/a.html"]);
	});
});

describe("what each file's latest revision is", () => {
	it("is empty before anything is written", () => {
		const revisions = createExpertRevisions();

		expect(revisions.heads().size).toBe(0);
	});

	it("names the highest revision held for each file", async () => {
		const revisions = createExpertRevisions();
		revisions.open(snapshotOf({}), 1);
		revisions.source.log.record("/w/a.html", Buffer.from("one"), "editor");
		revisions.source.log.record("/w/a.html", Buffer.from("two"), "editor");
		revisions.source.log.record("/w/b.html", Buffer.from("one"), "editor");

		const heads = revisions.heads();

		// An unseeded file gets "did not exist" as #1, so the first write is #2.
		expect(heads.get("/w/a.html")).toBe(3);
		expect(heads.get("/w/b.html")).toBe(2);
	});

	it("is empty again after a purge", () => {
		const revisions = createExpertRevisions();
		revisions.open(snapshotOf({}), 1);
		revisions.source.log.record("/w/a.html", Buffer.from("one"), "editor");

		revisions.purge();

		expect(revisions.heads().size).toBe(0);
	});
});

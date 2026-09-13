import { describe, expect, it } from "vitest";
import { createRevisionLog, describeRevisions } from "./file-revisions";

const body = (text: string) => Buffer.from(text, "utf8");
const FILE = "/w/manic_miner.html";

describe("createRevisionLog", () => {
	it("makes the transaction's base revision 1", () => {
		const log = createRevisionLog();
		log.seed(FILE, body("original\n"));
		const [first] = log.revisions(FILE);
		expect(first?.index).toBe(1);
		expect(first?.by).toBe("transaction open");
		expect(first?.body?.toString()).toBe("original\n");
	});

	it("appends a revision per change", () => {
		const log = createRevisionLog();
		log.seed(FILE, body("a\n"));
		expect(log.record(FILE, body("b\n"), "editor")?.index).toBe(2);
		expect(log.record(FILE, body("c\n"), "sed")?.index).toBe(3);
		expect(log.revisions(FILE).map((r) => r.by)).toEqual([
			"transaction open",
			"editor",
			"sed",
		]);
	});

	it("does not append when the content did not change", () => {
		const log = createRevisionLog();
		log.seed(FILE, body("a\n"));
		expect(log.record(FILE, body("a\n"), "editor")).toBeUndefined();
		expect(log.revisions(FILE)).toHaveLength(1);
	});

	// A file the transaction created has no base content, and "restoring to
	// original" has to mean deleting it -- so the absence must be a revision
	// rather than a missing one.
	it("records a file that did not exist as revision 1 with no body", () => {
		const log = createRevisionLog();
		log.seed(FILE, undefined);
		log.record(FILE, body("new\n"), "editor");
		const [first, second] = log.revisions(FILE);
		expect(first?.body).toBeUndefined();
		expect(first?.lines).toBe(0);
		expect(second?.body?.toString()).toBe("new\n");
	});

	it("records a deletion as a revision with no body", () => {
		const log = createRevisionLog();
		log.seed(FILE, body("a\n"));
		expect(log.record(FILE, undefined, "run_commands")?.index).toBe(2);
		expect(log.revisions(FILE)[1]?.body).toBeUndefined();
	});

	it("counts lines the way a reader counts them", () => {
		const log = createRevisionLog();
		log.seed(FILE, body("a\nb\n"));
		expect(log.revisions(FILE)[0]?.lines).toBe(2);
	});

	it("lists what it is tracking", () => {
		const log = createRevisionLog();
		log.seed(FILE, body("a\n"));
		log.seed("/w/other.js", body("x\n"));
		expect([...log.tracked()].sort()).toEqual([
			"/w/manic_miner.html",
			"/w/other.js",
		]);
	});

	it("forgets everything on reset, because a discard puts the tree back", () => {
		const log = createRevisionLog();
		log.seed(FILE, body("a\n"));
		log.record(FILE, body("b\n"), "editor");
		log.reset();
		expect(log.revisions(FILE)).toHaveLength(0);
		expect(log.tracked()).toHaveLength(0);
	});
});

describe("resolve", () => {
	const seeded = () => {
		const log = createRevisionLog();
		log.seed(FILE, body("one\n"));
		log.record(FILE, body("two\n"), "editor");
		log.record(FILE, body("three\n"), "editor");
		return log;
	};

	it("resolves `original` to revision 1", () => {
		const found = seeded().resolve(FILE, "original");
		expect(found.kind).toBe("found");
		expect(found.kind === "found" && found.revision.index).toBe(1);
	});

	it("resolves `base` as a synonym for `original`", () => {
		const found = seeded().resolve(FILE, "base");
		expect(found.kind === "found" && found.revision.index).toBe(1);
	});

	// `last` is the state BEFORE the most recent change, not the most recent
	// state -- otherwise restoring to it would be a no-op every time.
	it("resolves `last` to the revision before the newest", () => {
		const found = seeded().resolve(FILE, "last");
		expect(found.kind === "found" && found.revision.index).toBe(2);
		expect(found.kind === "found" && found.revision.body?.toString()).toBe(
			"two\n",
		);
	});

	it("resolves `last` to revision 1 when nothing has changed yet", () => {
		const log = createRevisionLog();
		log.seed(FILE, body("one\n"));
		const found = log.resolve(FILE, "last");
		expect(found.kind === "found" && found.revision.index).toBe(1);
	});

	it("accepts a number with or without the hash, and loose wording", () => {
		for (const spec of ["#2", "2", " #2 ", "rev 2", "revision 2", "v2"]) {
			const found = seeded().resolve(FILE, spec);
			expect(found.kind, spec).toBe("found");
			expect(found.kind === "found" && found.revision.index, spec).toBe(2);
		}
	});

	it("names what is available when the number is not", () => {
		const found = seeded().resolve(FILE, "#9");
		expect(found.kind).toBe("unknown");
		expect(found.kind === "unknown" && found.available).toEqual([1, 2, 3]);
	});

	it("says the file is untracked rather than inventing a revision", () => {
		const found = seeded().resolve("/w/never-touched.js", "original");
		expect(found.kind).toBe("untracked");
	});

	it("refuses a spec it cannot read rather than guessing", () => {
		const found = seeded().resolve(FILE, "yesterday");
		expect(found.kind).toBe("unknown");
	});
});

describe("the memory cap", () => {
	// A 4 MB file edited fifty times is 200 MB held for one transaction. The
	// cap drops content from the middle, and the two things a model actually
	// reaches for -- the original and the recent ones -- are never dropped.
	it("drops bodies from the middle and never the original or the newest", () => {
		const log = createRevisionLog(undefined, { maxBytesPerFile: 4_000 });
		log.seed(FILE, body("x".repeat(1_000)));
		for (let i = 0; i < 12; i += 1) {
			log.record(FILE, body(`${"y".repeat(1_000)}${i}`), "editor");
		}
		const revisions = log.revisions(FILE);
		expect(revisions[0]?.dropped).toBe(false);
		expect(revisions[revisions.length - 1]?.dropped).toBe(false);
		expect(revisions.some((r) => r.dropped)).toBe(true);
	});

	it("tells the caller a dropped revision is gone rather than returning nothing", () => {
		const log = createRevisionLog(undefined, { maxBytesPerFile: 4_000 });
		log.seed(FILE, body("x".repeat(1_000)));
		for (let i = 0; i < 12; i += 1) {
			log.record(FILE, body(`${"y".repeat(1_000)}${i}`), "editor");
		}
		const dropped = log.revisions(FILE).find((r) => r.dropped);
		const found = log.resolve(FILE, `#${dropped?.index}`);
		expect(found.kind).toBe("dropped");
	});
});

describe("describeRevisions", () => {
	it("lists every revision with what made it", () => {
		const log = createRevisionLog();
		log.seed(FILE, body("one\n"));
		log.record(FILE, body("two\n"), "editor");
		const text = describeRevisions("manic_miner.html", log.revisions(FILE));
		expect(text).toContain("#1");
		expect(text).toContain("#2");
		expect(text).toContain("original");
		expect(text).toContain("editor");
	});

	it("marks the newest as what is on disk now", () => {
		const log = createRevisionLog();
		log.seed(FILE, body("one\n"));
		log.record(FILE, body("two\n"), "editor");
		expect(
			describeRevisions("manic_miner.html", log.revisions(FILE)),
		).toContain("on disk now");
	});
});

describe("describeRevisions elision", () => {
	// A file edited forty times would otherwise put forty lines into every
	// receipt. The ends are what get asked for, so the middle goes.
	it("elides the middle of a long history and says so", () => {
		const log = createRevisionLog();
		log.seed(FILE, body("v0\n"));
		for (let i = 1; i <= 30; i += 1)
			log.record(FILE, body(`v${i}\n`), "editor");
		const text = describeRevisions("f.html", log.revisions(FILE), { limit: 6 });
		expect(text).toContain("#1");
		expect(text).toContain("#31");
		expect(text).toContain("not listed");
		expect(text).not.toContain("#15");
	});

	it("lists everything when the history is short enough", () => {
		const log = createRevisionLog();
		log.seed(FILE, body("a\n"));
		log.record(FILE, body("b\n"), "editor");
		const text = describeRevisions("f.html", log.revisions(FILE), { limit: 6 });
		expect(text).not.toContain("not listed");
	});
});

describe("de-duplication", () => {
	// These models oscillate: they edit, undo, and edit back to the same text,
	// and a restore writes a version that already exists. Holding each of those
	// again is the bulk of what a long transaction would keep.
	it("holds content once however many revisions have it", () => {
		const log = createRevisionLog();
		log.seed(FILE, body("a\n"));
		log.record(FILE, body("b\n"), "editor");
		const back = log.record(FILE, body("a\n"), "editor");
		expect(back?.index).toBe(3);
		expect(log.heldBytes(FILE)).toBe(
			Buffer.byteLength("a\n") + Buffer.byteLength("b\n"),
		);
	});

	it("names the earlier revision a repeat is identical to", () => {
		const log = createRevisionLog();
		log.seed(FILE, body("a\n"));
		log.record(FILE, body("b\n"), "editor");
		expect(log.record(FILE, body("a\n"), "editor")?.sameAs).toBe(1);
	});

	it("leaves sameAs unset for content seen for the first time", () => {
		const log = createRevisionLog();
		log.seed(FILE, body("a\n"));
		expect(log.record(FILE, body("b\n"), "editor")?.sameAs).toBeUndefined();
	});

	// The point of saying it: a model going back and forth between two versions
	// is in the loop this whole feature exists to break, and the history is the
	// one place that can show it the shape of what it is doing.
	it("says so in the listing, so a loop is visible to the model", () => {
		const log = createRevisionLog();
		log.seed(FILE, body("a\n"));
		log.record(FILE, body("b\n"), "editor");
		log.record(FILE, body("a\n"), "editor");
		expect(describeRevisions("f.html", log.revisions(FILE))).toContain(
			"identical to #1",
		);
	});

	it("can still resolve a revision whose content another one shares", () => {
		const log = createRevisionLog();
		log.seed(FILE, body("a\n"));
		log.record(FILE, body("b\n"), "editor");
		log.record(FILE, body("a\n"), "editor");
		const found = log.resolve(FILE, "#3");
		expect(found.kind === "found" && found.revision.body?.toString()).toBe(
			"a\n",
		);
	});

	// A revision cannot be released while another one still points at the same
	// bytes -- releasing it would reclaim nothing and lose a restore target for
	// no gain.
	it("does not release content that a surviving revision shares", () => {
		const log = createRevisionLog(undefined, { maxBytesPerFile: 1 });
		log.seed(FILE, body("a\n"));
		for (let i = 0; i < 20; i += 1) {
			log.record(FILE, body(i % 2 === 0 ? "b\n" : "a\n"), "editor");
		}
		expect(log.revisions(FILE).every((r) => !r.dropped)).toBe(true);
		expect(log.heldBytes(FILE)).toBe(
			Buffer.byteLength("a\n") + Buffer.byteLength("b\n"),
		);
	});
});

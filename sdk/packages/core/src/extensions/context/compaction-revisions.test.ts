import { describe, expect, it } from "vitest";
import {
	mentionedPaths,
	releaseUnreachableRevisions,
} from "./compaction-revisions";

const tracked = [
	"/w/src/runtime/session.ts",
	"/w/src/extensions/context/compaction.ts",
	"/w/README.md",
];

describe("which tracked files a compacted transcript still names", () => {
	it("keeps a file the summary names by its workspace-relative path", () => {
		// What the model actually writes. The log's key is absolute because the
		// tools resolve before they record; the summary is prose.
		const kept = mentionedPaths(
			"I edited src/runtime/session.ts to add the guard.",
			tracked,
		);

		expect([...kept]).toEqual(["/w/src/runtime/session.ts"]);
	});

	it("keeps a file named by bare basename, which is how prose refers to one", () => {
		const kept = mentionedPaths(
			"Then README.md needed the same note.",
			tracked,
		);

		expect([...kept]).toEqual(["/w/README.md"]);
	});

	it("keeps a file named by its absolute path", () => {
		const kept = mentionedPaths(
			"restore_file /w/src/extensions/context/compaction.ts #3",
			tracked,
		);

		expect([...kept]).toEqual(["/w/src/extensions/context/compaction.ts"]);
	});

	it("names nothing when the transcript names nothing", () => {
		expect([
			...mentionedPaths("I thought about it and stopped.", tracked),
		]).toEqual([]);
	});

	it("does not match a basename buried inside a longer word", () => {
		// `session.ts` inside `my-session.ts` is a different file, and keeping
		// the wrong one is how the byte cap stops meaning anything.
		expect([
			...mentionedPaths("I edited my-session.ts once.", tracked),
		]).toEqual([]);
	});

	it("keeps each file once however often it is named", () => {
		const kept = mentionedPaths(
			"README.md, then README.md again, and /w/README.md.",
			tracked,
		);

		expect([...kept]).toEqual(["/w/README.md"]);
	});

	it("finds a path through JSON escaping and Windows separators", () => {
		// The haystack is the compacted messages as JSON, so a Windows path
		// arrives as `src\\runtime\\session.ts`. Nothing normalises it: the
		// basename still stands alone behind a separator, which is why the
		// rule is stated in terms of the basename and not the path.
		const kept = mentionedPaths(
			JSON.stringify({ text: "edited src\\runtime\\session.ts" }),
			tracked,
		);

		expect([...kept]).toEqual(["/w/src/runtime/session.ts"]);
	});
});

describe("releasing what the compacted transcript cannot reach", () => {
	const stub = (paths: string[]) => {
		const calls: (readonly string[])[] = [];
		return {
			calls,
			port: {
				revisionsFor: () => undefined,
				tracked: () => paths,
				noteCompaction: (keep?: Iterable<string>) => {
					calls.push([...(keep ?? [])].sort());
					return paths.length - [...(keep ?? [])].length;
				},
			},
		};
	};

	it("keeps what the summary names and offers the rest for release", () => {
		const { calls, port } = stub(["/w/a/kept.ts", "/w/b/gone.ts"]);

		releaseUnreachableRevisions(port, [
			{
				role: "assistant",
				content: [{ type: "text", text: "I fixed kept.ts" }],
			},
		]);

		expect(calls).toEqual([["/w/a/kept.ts"]]);
	});

	it("sees a path named only inside a retained tool call", () => {
		// The tail is messages, not prose: a path can survive in a tool call's
		// input and nowhere else, and rendering only the text would miss it.
		const { calls, port } = stub(["/w/a/kept.ts"]);

		releaseUnreachableRevisions(port, [
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolName: "editor",
						input: { path: "a/kept.ts" },
					},
				],
			},
		]);

		expect(calls).toEqual([["/w/a/kept.ts"]]);
	});

	it("does nothing at all when the host keeps no revision log", () => {
		expect(releaseUnreachableRevisions(undefined, [])).toBe(0);
	});

	it("does not close a span when the log is holding nothing", () => {
		// A span closed over an empty log still advances the counter, which
		// would age out files written after it for no reason.
		const { calls, port } = stub([]);

		expect(releaseUnreachableRevisions(port, [{ role: "user" }])).toBe(0);
		expect(calls).toEqual([]);
	});
});

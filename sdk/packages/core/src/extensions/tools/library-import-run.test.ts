import type { AgentToolContext } from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	cancelLibraryImports,
	hasActiveLibraryImports,
	LibraryImportRun,
} from "./library-import-run";

function contextWith(
	updates: unknown[],
	signal?: AbortSignal,
): AgentToolContext {
	return {
		agentId: "a",
		iteration: 1,
		emitUpdate: (update: unknown) => updates.push(update),
		...(signal ? { signal } : {}),
	};
}

const lastStatus = (updates: unknown[]) =>
	(updates.at(-1) as { status: string }).status;

describe("LibraryImportRun", () => {
	afterEach(() => {
		vi.useRealTimers();
		cancelLibraryImports();
	});

	it("shows a line a file with where each one is", () => {
		const updates: unknown[] = [];
		const run = new LibraryImportRun(
			"Adding 3 files",
			["/b/one.pdf", "/b/two.epub", "/b/three.pdf"],
			contextWith(updates),
		);
		run.start("/b/one.pdf");
		run.done("/b/one.pdf", "12 pages, 3,000 words", [
			"page 4: a scan with no recognized text, nothing readable was found on it",
		]);
		run.start("/b/two.epub");
		run.fail("/b/two.epub", "This EPUB is damaged");
		run.start("/b/three.pdf");
		run.progress("/b/three.pdf", {
			unit: "page",
			at: 312,
			total: 769,
			pictures: 705,
			activity: "recognizing text",
		});
		run.stage("/b/three.pdf", undefined);
		const status = lastStatus(updates);
		expect(status).toContain("1 of 3 done, 1 in progress, 1 failed");
		expect(status).toContain("✓ one.pdf: 12 pages, 3,000 words");
		expect(status).toContain("1 left out");
		expect(status).toContain("✗ two.epub: This EPUB is damaged");
		expect(status).toContain(
			"▶ three.pdf: page 312 of 769, recognizing text, 705 pictures",
		);
		expect((updates.at(-1) as { cancellable: string }).cancellable).toBe(
			"library-import",
		);
		run.close();
	});

	it("says so when a file has stopped moving", () => {
		vi.useFakeTimers();
		const updates: unknown[] = [];
		const logged: string[] = [];
		const run = new LibraryImportRun(
			"Checking 1 file",
			["/b/big.pdf"],
			contextWith(updates),
			(line) => logged.push(line),
		);
		run.start("/b/big.pdf");
		run.progress("/b/big.pdf", {
			unit: "page",
			at: 29,
			total: 769,
			pictures: 0,
		});
		vi.advanceTimersByTime(125_000);
		expect(lastStatus(updates)).toMatch(
			/big\.pdf: page 29 of 769.*NOT MOVING for 2m 0\ds/,
		);
		expect(
			logged.some((line) =>
				/big\.pdf at page 29 of 769, last moved/.test(line),
			),
		).toBe(true);
		run.close();
	});

	it("ends a wait that would never end, and reports every file", async () => {
		const updates: unknown[] = [];
		const run = new LibraryImportRun(
			"Adding 3 files",
			["/b/one.pdf", "/b/stuck.pdf", "/b/later.pdf"],
			contextWith(updates),
		);
		run.start("/b/one.pdf");
		run.done("/b/one.pdf", "12 pages", [
			"page 3: a picture was left out, the PDF decoder could not decode it",
		]);
		run.start("/b/stuck.pdf");
		run.progress("/b/stuck.pdf", {
			unit: "page",
			at: 40,
			total: 769,
			pictures: 80,
		});
		const never = run.guard(new Promise<string>(() => {}));
		expect(hasActiveLibraryImports()).toBe(true);
		expect(cancelLibraryImports()).toBe(1);
		await expect(never).rejects.toThrow(/cancelled by the user/);
		expect(run.signal.aborted).toBe(true);
		const message = run.cancellation([
			"Nothing was added to the Library.",
		]).message;
		expect(message).toContain("was cancelled: cancelled by the user");
		expect(message).toContain("Nothing was added to the Library.");
		expect(message).toContain("- one.pdf: 12 pages");
		expect(message).toContain("left out: page 3: a picture was left out");
		expect(message).toMatch(
			/- stuck\.pdf: NOT FINISHED, it was at page 40 of 769, 80 pictures/,
		);
		expect(message).toContain("- later.pdf: NOT READ");
		run.close();
		expect(hasActiveLibraryImports()).toBe(false);
	});

	it("is cancelled when the run is stopped", () => {
		const outer = new AbortController();
		const run = new LibraryImportRun(
			"Checking 1 file",
			["/b/a.pdf"],
			contextWith([], outer.signal),
		);
		outer.abort();
		expect(run.isCancelled).toBe(true);
		run.close();
	});
});

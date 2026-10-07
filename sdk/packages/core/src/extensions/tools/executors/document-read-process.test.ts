import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReadProgress } from "./document/formats";
import {
	DOCUMENT_READER_CHILD_ENV,
	DOCUMENT_READER_IN_PROCESS_ENV,
	DOCUMENT_READER_PROCESSES_ENV,
	describeReaderExit,
	readDocumentJob,
	resetReaderProcessState,
	resolveReaderChild,
} from "./document/read-process";
import { readDocumentForBook, sweepAbandonedReads } from "./document-extract";

const FIXTURES = join(
	__dirname,
	"..",
	"..",
	"..",
	"..",
	"fixtures",
	"documents",
);
const CORE = join(__dirname, "..", "..", "..", "..");

/**
 * The real reader, bundled to JavaScript so the Node these tests run under
 * can start it: a Node session and a Bun reader do not share an IPC format.
 * Kept inside the package so the reader finds pdf.js where the tests do.
 */
const REAL_CHILD = (() => {
	const outfile = join(
		CORE,
		"node_modules",
		".cache",
		"reader-process-test",
		"document-reader-child.mjs",
	);
	try {
		execFileSync(
			"bun",
			[
				"build",
				join(__dirname, "document", "read-child.ts"),
				"--target=node",
				"--format=esm",
				"--packages=external",
				`--outfile=${outfile}`,
			],
			{ cwd: CORE, stdio: "pipe" },
		);
		return outfile;
	} catch {
		return undefined;
	}
})();
const built = REAL_CHILD !== undefined;

let dir: string;
const saved: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
	if (!(name in saved)) saved[name] = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** A reader process that does what the test says, in plain JavaScript. */
function fakeChild(body: string): string {
	const file = join(dir, `child-${Math.random().toString(36).slice(2)}.mjs`);
	writeFileSync(
		file,
		`process.on("disconnect", () => process.exit(0));
process.on("message", async (message) => { ${body} });
process.send({ type: "ready" });
`,
	);
	setEnv(DOCUMENT_READER_CHILD_ENV, file);
	setEnv("CLINE_JS_RUNTIME_PATH", process.execPath);
	return file;
}

const job = (name = "probe.pdf") => ({
	filePath: join(FIXTURES, name),
	wantImages: true,
	scratchDir: join(dir, `scratch-${Math.random().toString(36).slice(2)}`),
	recognition: {
		settings: { ocr: "off" as const },
		modelSupportsImages: false,
	},
});

const DONE = `{ type: "done", format: "pdf", result: { markdown: "read", reader: "fake" }, images: [], recognitionNotes: [], recognitionProblems: [], attachments: [], problems: [], usage: { ms: 1, peakRssMb: 1 } }`;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "reader-process-"));
});

afterEach(() => {
	resetReaderProcessState();
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
		delete saved[name];
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("the reader process", () => {
	it("is not looked for where the session is told to read itself", () => {
		const file = join(dir, "child.js");
		writeFileSync(file, "");
		expect(resolveReaderChild({ [DOCUMENT_READER_CHILD_ENV]: file })).toBe(
			file,
		);
		expect(
			resolveReaderChild({
				[DOCUMENT_READER_CHILD_ENV]: file,
				[DOCUMENT_READER_IN_PROCESS_ENV]: "1",
			}),
		).toBeUndefined();
		expect(
			resolveReaderChild({ [DOCUMENT_READER_CHILD_ENV]: join(dir, "gone.js") }),
		).toBeUndefined();
	});

	it.skipIf(!built)(
		"reads a book as the session's own process does, pictures included",
		async () => {
			const file = join(FIXTURES, "probe.pdf");
			setEnv(DOCUMENT_READER_IN_PROCESS_ENV, "1");
			const here = await readDocumentForBook(file, { scratchDir: dir });

			setEnv(DOCUMENT_READER_IN_PROCESS_ENV, undefined);
			setEnv(DOCUMENT_READER_CHILD_ENV, REAL_CHILD);
			setEnv("CLINE_JS_RUNTIME_PATH", process.execPath);
			const notes: string[] = [];
			const progress: ReadProgress[] = [];
			const there = await readDocumentForBook(file, {
				scratchDir: dir,
				onNote: (line) => notes.push(line),
				onProgress: (at) => progress.push(at),
			});

			expect(notes.join("\n")).toMatch(
				/read in a process of its own \(pid \d+\)/,
			);
			expect(there.markdown).toBe(here.markdown);
			expect(there.images.length).toBe(here.images.length);
			expect(there.images.length).toBeGreaterThan(0);
			expect(there.images.map((image) => readFileSync(image.path))).toEqual(
				here.images.map((image) => readFileSync(image.path)),
			);
			expect(there.units).toEqual(here.units);
			expect(progress.length).toBeGreaterThan(0);
			// The pictures are files until the book is filed, and then nothing
			// of the read is left behind.
			expect(there.images.every((image) => existsSync(image.path))).toBe(true);
			await Promise.all([here.release(), there.release()]);
			expect(there.images.some((image) => existsSync(image.path))).toBe(false);
			expect(
				readdirSync(dir).filter((name) => name.startsWith(".scratch")),
			).toEqual([]);
		},
		120_000,
	);

	it.skipIf(!built)(
		"says what the document reader says about a file it cannot read",
		async () => {
			setEnv(DOCUMENT_READER_CHILD_ENV, REAL_CHILD);
			setEnv("CLINE_JS_RUNTIME_PATH", process.execPath);
			const file = join(dir, "notes.xyz");
			writeFileSync(file, "plain words");
			await expect(
				readDocumentForBook(file, { scratchDir: dir }),
			).rejects.toThrow(/No reader for \.xyz/);
		},
		60_000,
	);

	it("turns a reader that dies into one file that was not read", async () => {
		fakeChild(`
			if (message.type !== "start") return;
			process.send({ type: "progress", progress: { unit: "page", at: 582, total: 769, pictures: 22 } }, () => {
				process.stderr.write("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\\n", () => process.exit(134));
			});`);
		const request = job();
		const seen: ReadProgress[] = [];
		const failure = await readDocumentJob(request, {
			onProgress: (at) => seen.push(at),
		}).catch((error: Error) => error);

		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).toContain("at page 582 of 769");
		expect(message).toContain("ran out of memory");
		expect(message).toContain(
			"The session and the rest of this call are unaffected",
		);
		expect(seen).toHaveLength(1);
		expect(existsSync(request.scratchDir)).toBe(false);
	});

	it("stops a reader that is asked to stop, and ends one that does not", async () => {
		const marker = join(dir, "pid");
		fakeChild(`
			if (message.type === "start") {
				(await import("node:fs")).writeFileSync(${JSON.stringify(marker)}, String(process.pid));
				process.send({ type: "note", line: "started" });
				setInterval(() => {}, 1000);
			}`);
		const controller = new AbortController();
		const reason = new Error("stopped by the user");
		const reading = readDocumentJob(job(), {
			signal: controller.signal,
			onNote: (line) => {
				if (line === "started") controller.abort(reason);
			},
		});
		await expect(reading).rejects.toBe(reason);
		const pid = Number(readFileSync(marker, "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
	}, 20_000);

	it("carries the vision model's answers to the reader and back", async () => {
		fakeChild(`
			if (message.type === "start") {
				process.send({ type: "describe", id: 7, images: [{ image: "AAAA", mediaType: "image/png", instruction: "transcribe" }] });
			} else if (message.type === "described") {
				const done = ${DONE};
				done.result.markdown = message.id + ":" + (message.error ?? message.descriptions.join("|")) + ":" + String(globalThis.hasVision);
				process.send(done);
			}
			if (message.type === "start") globalThis.hasVision = message.hasVision;`);
		const asked: string[] = [];
		const read = await readDocumentJob(job(), {
			describeImages: async (images) => {
				asked.push(...images.map((image) => image.instruction ?? ""));
				return ["what the page says"];
			},
		});
		expect(asked).toEqual(["transcribe"]);
		expect(read.result.markdown).toBe("7:what the page says:true");
	});

	it("tells the reader its answer arrived, however large, before it leaves", async () => {
		const marker = join(dir, "received");
		fakeChild(`
			if (message.type === "start") {
				const done = ${DONE};
				done.result.markdown = "x".repeat(24 * 1024 * 1024);
				process.send(done);
			} else if (message.type === "received") {
				(await import("node:fs")).writeFileSync(${JSON.stringify(marker)}, "yes");
				process.exit(0);
			}`);
		const read = await readDocumentJob(job());
		expect(read.result.markdown.length).toBe(24 * 1024 * 1024);
		await expect.poll(() => existsSync(marker), { timeout: 5_000 }).toBe(true);
	}, 30_000);

	it("runs no more readers at once than it is told", async () => {
		setEnv(DOCUMENT_READER_PROCESSES_ENV, "1");
		const log = join(dir, "log");
		writeFileSync(log, "");
		fakeChild(`
			if (message.type !== "start") return;
			const fs = await import("node:fs");
			fs.appendFileSync(${JSON.stringify(log)}, "start\\n");
			await new Promise((resolve) => setTimeout(resolve, 300));
			fs.appendFileSync(${JSON.stringify(log)}, "end\\n");
			process.send(${DONE});`);
		await Promise.all([readDocumentJob(job()), readDocumentJob(job())]);
		expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
			"start",
			"end",
			"start",
			"end",
		]);
	}, 20_000);

	it("reads here, and says so, when the reader cannot be started", async () => {
		fakeChild("");
		setEnv("CLINE_JS_RUNTIME_PATH", join(dir, "no-such-runtime"));
		const notes: string[] = [];
		const read = await readDocumentJob(job(), {
			onNote: (line) => notes.push(line),
		});
		expect(read.format).toBe("pdf");
		expect(read.result.markdown.length).toBeGreaterThan(0);
		expect(notes.join("\n")).toMatch(
			/the reader process could not be started .*read in the session's own process instead/,
		);
		// It is not tried again for every file after it.
		const later: string[] = [];
		setEnv("CLINE_JS_RUNTIME_PATH", process.execPath);
		await readDocumentJob(job(), { onNote: (line) => later.push(line) });
		expect(later).toEqual([]);
	}, 60_000);
});

describe("a book's pictures", () => {
	it("are held as files, not bytes, until release", async () => {
		setEnv(DOCUMENT_READER_IN_PROCESS_ENV, "1");
		const book = await readDocumentForBook(join(FIXTURES, "probe.pdf"), {
			scratchDir: dir,
		});
		expect(book.images.length).toBeGreaterThan(0);
		for (const image of book.images) {
			expect(image).not.toHaveProperty("data");
			expect(readFileSync(image.path).byteLength).toBeGreaterThan(0);
		}
		await book.release();
		expect(readdirSync(dir)).toEqual([]);
	});

	it("are not held at all when a read takes none", async () => {
		setEnv(DOCUMENT_READER_IN_PROCESS_ENV, "1");
		const book = await readDocumentForBook(join(FIXTURES, "probe.pdf"), {
			scratchDir: dir,
			pictures: false,
		});
		expect(book.images).toEqual([]);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("left behind by a session that died are swept, and no others", async () => {
		const old = join(dir, ".scratch-dead");
		const fresh = join(dir, ".scratch-live");
		const other = join(dir, "kept");
		for (const at of [old, fresh, other]) {
			mkdirSync(at);
			writeFileSync(join(at, "0"), "x");
		}
		const long = new Date(Date.now() - 7 * 60 * 60_000);
		utimesSync(old, long, long);
		utimesSync(other, long, long);
		await sweepAbandonedReads(dir);
		expect(readdirSync(dir).sort()).toEqual([".scratch-live", "kept"]);
	});
});

describe("describeReaderExit", () => {
	it("does not call an ordinary failure out of memory", () => {
		const message = describeReaderExit(
			1,
			null,
			"TypeError: x is not a function\n",
			undefined,
		);
		expect(message).toContain("exit code 1");
		expect(message).not.toContain("memory");
		expect(message).toContain("Its last words: TypeError: x is not a function");
	});
});

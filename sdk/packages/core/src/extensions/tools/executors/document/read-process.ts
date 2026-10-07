/**
 * Reading a document in a process of its own.
 *
 * A PDF is decoded page by page into pictures, and a scanned one is then read
 * by an OCR engine: hundreds of megabytes of work in whatever process does
 * it. In a VS Code window that process is the extension host, which every
 * extension shares and which has one fixed heap; measured on a 769-page
 * scanned book, the host ran out of memory and took the session, and every
 * other extension's state, with it.
 *
 * So each read gets a process, started for it and gone when it answers. What
 * the session keeps is the result. A reader that runs out of memory or stops
 * is one file that could not be read, said so with the page it stopped on.
 *
 * Where no reader process can be started (the file that runs in it was not
 * shipped beside this bundle, or no JavaScript runtime is found) the read
 * happens here, as it did before, and a note says so.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { basename, join } from "node:path";
import { CLINE_JS_RUNTIME_PATH_ENV } from "../../../../runtime/tools/subprocess-sandbox";
import { moduleDirectory } from "./assets";
import type { ReadProgress } from "./formats";
import {
	type ReadJob,
	type ReadJobHooks,
	type ReadJobResult,
	runReadJob,
} from "./read-job";
import type { ChildMessage, ParentMessage } from "./read-protocol";

/** Names the file that runs in the reader process, for a host that keeps it elsewhere. */
export const DOCUMENT_READER_CHILD_ENV = "CLINE_DOCUMENT_READER_CHILD";
/** `1` reads in this process, whatever is shipped. */
export const DOCUMENT_READER_IN_PROCESS_ENV =
	"CLINE_DOCUMENT_READER_IN_PROCESS";
/** How many reader processes run at once. */
export const DOCUMENT_READER_PROCESSES_ENV = "CLINE_DOCUMENT_READER_PROCESSES";

const CHILD_FILE_NAMES = [
	"document-reader-child.cjs",
	"document-reader-child.js",
];
/**
 * Two at a time: a model asks for five books in one turn, and five decoders
 * at once is the memory of five, whoever's process it is.
 */
const DEFAULT_PROCESSES = 2;
/** Starting a process and loading the reader is under a second; this is a machine in trouble. */
const READY_LIMIT_MS = 60_000;
/** How long a reader has to stop at its next page before it is ended. */
const ABORT_GRACE_MS = 3_000;
const STDERR_KEPT = 4_000;

/** The file the reader process runs, or undefined where none was shipped. */
export function resolveReaderChild(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (env[DOCUMENT_READER_IN_PROCESS_ENV]?.trim() === "1") return undefined;
	const named = env[DOCUMENT_READER_CHILD_ENV]?.trim();
	if (named) return existsSync(named) ? named : undefined;
	const here = moduleDirectory();
	// Beside the bundle, or beside the bundle this one was split from
	// (`dist/hub/daemon/entry.js` is two below `dist/`).
	for (const directory of [here, join(here, ".."), join(here, "..", "..")]) {
		for (const name of CHILD_FILE_NAMES) {
			const candidate = join(directory, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

/**
 * What runs the reader. In a VS Code window that is VS Code itself, told to
 * behave as the Node it is built on: there is no other runtime to count on.
 */
function readerRuntime():
	| { command: string; env: NodeJS.ProcessEnv }
	| undefined {
	const named = process.env[CLINE_JS_RUNTIME_PATH_ENV]?.trim();
	if (named) return { command: named, env: process.env };
	if (process.versions.electron) {
		return {
			command: process.execPath,
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		};
	}
	// The reader must be run by what runs this: Node and Bun do not share an
	// IPC format, so a Bun reader under a Node session never says it is ready.
	// A single-file executable is neither, and has no reader beside it anyway.
	return /^(node|bun)(\.exe)?$/i.test(basename(process.execPath))
		? { command: process.execPath, env: process.env }
		: undefined;
}

function processLimit(): number {
	const asked = Number(process.env[DOCUMENT_READER_PROCESSES_ENV]);
	return Number.isInteger(asked) && asked >= 1 ? asked : DEFAULT_PROCESSES;
}

let running = 0;
const waiting: (() => void)[] = [];

/** A turn at a reader process; resolves with the function that gives it back. */
async function takeTurn(signal: AbortSignal | undefined): Promise<() => void> {
	const release = () => {
		running--;
		waiting.shift()?.();
	};
	if (running < processLimit()) {
		running++;
		return release;
	}
	await new Promise<void>((resolve, reject) => {
		const proceed = () => {
			signal?.removeEventListener("abort", stop);
			resolve();
		};
		const stop = () => {
			const at = waiting.indexOf(proceed);
			if (at >= 0) waiting.splice(at, 1);
			reject(signal?.reason ?? new Error("The read was stopped."));
		};
		signal?.addEventListener("abort", stop, { once: true });
		waiting.push(proceed);
	});
	running++;
	return release;
}

/** The reader process could not be started: nothing was read, and nothing lost. */
class ReaderNotStarted extends Error {}

function where(progress: ReadProgress | undefined): string {
	return progress
		? ` at ${progress.unit} ${progress.at} of ${progress.total}`
		: "";
}

/** Why a reader process ended without an answer, in a sentence. */
export function describeReaderExit(
	code: number | null,
	signal: NodeJS.Signals | null,
	stderr: string,
	progress: ReadProgress | undefined,
): string {
	const outOfMemory =
		/out of memory|Allocation failed|Cannot allocate|std::bad_alloc/i.test(
			stderr,
		) ||
		code === 134 ||
		signal === "SIGABRT" ||
		signal === "SIGKILL";
	const how = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
	const last = stderr
		.trim()
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.slice(-2)
		.join(" | ")
		.slice(0, 400);
	return (
		`the reader process ended${where(progress)} without an answer (${how})` +
		(outOfMemory
			? ": it ran out of memory. The document is too large to decode here"
			: "") +
		`. The session and the rest of this call are unaffected.${last ? ` Its last words: ${last}` : ""}`
	);
}

async function readInReaderProcess(
	child: string,
	job: ReadJob,
	hooks: ReadJobHooks,
): Promise<ReadJobResult> {
	const runtime = readerRuntime();
	if (!runtime) {
		throw new ReaderNotStarted(
			`nothing here runs JavaScript files (${basename(process.execPath)})`,
		);
	}
	let proc: ChildProcess;
	try {
		proc = spawn(runtime.command, [child], {
			env: runtime.env,
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			serialization: "advanced",
			windowsHide: true,
		});
	} catch (error) {
		throw new ReaderNotStarted(
			error instanceof Error ? error.message : String(error),
		);
	}
	const send = (message: ParentMessage) => {
		if (proc.connected) proc.send(message, () => {});
	};

	return await new Promise<ReadJobResult>((resolve, reject) => {
		let ready = false;
		let answered = false;
		let settled = false;
		let stderr = "";
		let last: ReadProgress | undefined;
		let abortTimer: ReturnType<typeof setTimeout> | undefined;

		const readyTimer = setTimeout(() => {
			if (ready) return;
			finish(() =>
				reject(
					new ReaderNotStarted(
						`it gave no sign of life in ${READY_LIMIT_MS / 1000}s`,
					),
				),
			);
		}, READY_LIMIT_MS);

		const onAbort = () => {
			send({ type: "abort" });
			abortTimer ??= setTimeout(() => proc.kill(), ABORT_GRACE_MS);
		};

		function finish(settle: () => void): void {
			if (settled) return;
			settled = true;
			clearTimeout(readyTimer);
			clearTimeout(abortTimer);
			hooks.signal?.removeEventListener("abort", onAbort);
			settle();
			// It has answered, or it never will: either way it is done.
			if (proc.exitCode === null && proc.signalCode === null) {
				setTimeout(() => {
					if (proc.exitCode === null && proc.signalCode === null) proc.kill();
				}, 1_000).unref();
			}
		}

		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_KEPT);
		});
		proc.on("error", (error) => {
			finish(() =>
				reject(
					ready
						? new Error(`the reader process failed: ${error.message}`)
						: new ReaderNotStarted(error.message),
				),
			);
		});
		proc.on("exit", (code, signal) => {
			// It answered and left: the answer is being collected.
			if (answered) return;
			finish(() => {
				if (hooks.signal?.aborted) {
					reject(hooks.signal.reason ?? new Error("The read was stopped."));
				} else if (!ready) {
					reject(
						new ReaderNotStarted(
							`it ended before starting (${signal ?? `exit code ${code}`})${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""}`,
						),
					);
				} else {
					reject(new Error(describeReaderExit(code, signal, stderr, last)));
				}
			});
		});
		proc.on("message", (message: ChildMessage) => {
			switch (message.type) {
				case "ready":
					ready = true;
					clearTimeout(readyTimer);
					send({
						type: "start",
						job,
						hasVision: hooks.describeImages !== undefined,
					});
					if (hooks.signal?.aborted) onAbort();
					else hooks.signal?.addEventListener("abort", onAbort, { once: true });
					return;
				case "progress":
					last = message.progress;
					hooks.onProgress?.(message.progress);
					return;
				case "note":
					hooks.onNote?.(message.line);
					return;
				case "describe": {
					const { id } = message;
					const describe = hooks.describeImages;
					if (!describe) {
						send({ type: "described", id, error: "no vision model" });
						return;
					}
					describe(message.images).then(
						(descriptions) =>
							send({ type: "described", id, descriptions: [...descriptions] }),
						(error: unknown) =>
							send({
								type: "described",
								id,
								error: error instanceof Error ? error.message : String(error),
							}),
					);
					return;
				}
				case "failed":
					answered = true;
					send({ type: "received" });
					finish(() =>
						reject(
							message.aborted && hooks.signal?.aborted
								? (hooks.signal.reason ?? new Error(message.message))
								: new Error(message.message),
						),
					);
					return;
				case "done": {
					answered = true;
					send({ type: "received" });
					const { images, usage, type: _type, ...rest } = message;
					hooks.onNote?.(
						`read in a process of its own (pid ${proc.pid}): ${(usage.ms / 1000).toFixed(1)}s, ${usage.peakRssMb} MB at its peak`,
					);
					Promise.all(
						images.map(async ({ image, file }) => ({
							image,
							data: new Uint8Array(await fs.readFile(file)),
						})),
					).then(
						(read) => finish(() => resolve({ ...rest, images: read })),
						(error: unknown) =>
							finish(() =>
								reject(
									new Error(
										`the reader's pictures could not be collected: ${error instanceof Error ? error.message : String(error)}`,
									),
								),
							),
					);
					return;
				}
			}
		});
	});
}

let saidWhyInProcess = false;
/** Why no reader process starts here, once one has failed to: it is not tried again. */
let cannotStart: string | undefined;

/** Test seam. */
export function resetReaderProcessState(): void {
	saidWhyInProcess = false;
	cannotStart = undefined;
}

/**
 * Read one document. `job.scratchDir` is created here and removed afterwards,
 * whatever happens to the read.
 */
export async function readDocumentJob(
	job: ReadJob,
	hooks: ReadJobHooks = {},
): Promise<ReadJobResult> {
	await fs.mkdir(job.scratchDir, { recursive: true });
	try {
		const child = cannotStart ? undefined : resolveReaderChild();
		if (!child) {
			if (!saidWhyInProcess) {
				saidWhyInProcess = true;
				hooks.onNote?.(
					`read in the session's own process: ${cannotStart ? `the reader process could not be started (${cannotStart})` : "no reader process is shipped with this build"}`,
				);
			}
			return await runReadJob(job, hooks);
		}
		const release = await takeTurn(hooks.signal);
		try {
			return await readInReaderProcess(child, job, hooks);
		} catch (error) {
			if (!(error instanceof ReaderNotStarted)) throw error;
			cannotStart = error.message;
			saidWhyInProcess = true;
			hooks.onNote?.(
				`the reader process could not be started (${error.message}); read in the session's own process instead`,
			);
			return await runReadJob(job, hooks);
		} finally {
			release();
		}
	} finally {
		await fs
			.rm(job.scratchDir, { recursive: true, force: true })
			.catch(() => {});
	}
}

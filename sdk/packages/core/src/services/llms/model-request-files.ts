import { promises as fs } from "node:fs";
import path from "node:path";
import {
	type CapturedModelRequest,
	type CapturedModelResponse,
	type ModelResponseWriter,
	setModelRequestCapture,
} from "@cline/llms";
import type { BasicLogger } from "@cline/shared";
import { resolveClineDataDir } from "@cline/shared/storage";

/**
 * "Save model requests", as files: every generation request's exact body, and
 * the response it got, under `<dataDir>/logs/requests/<session>/`.
 *
 * One writer for every host. It was the VS Code extension's own until an SDK
 * host needed the same trace -- the request is what the model saw after every
 * reshaping of the history (reasoning scope, inlined reasoning, compaction),
 * and the response is what it generated, so the pair is a replayable turn and
 * a training example, where the session file is neither. Two hosts writing two
 * layouts could not share a reader.
 *
 * Per request, in send order:
 * - `<time>-<n>.json`: {@link CapturedModelRequest}
 * - `<time>-<n>.response.json`: {@link CapturedModelResponse}, written when the
 *   caller has read the response to its end, cancelled it, or it failed.
 *
 * Headers are not saved, so no key or token is written. Files are not pruned:
 * the switch is for the sessions being recorded, and turning it off stops it.
 */

export interface ModelRequestCaptureOptions {
	/** Where to write. Defaults to `<dataDir>/logs/requests`. */
	dir?: string;
	/** Save each request's response as well. On by default. */
	responses?: boolean;
	/** Told once if a file cannot be written. */
	logger?: Pick<BasicLogger, "log">;
}

export function modelRequestCaptureDir(): string {
	return path.join(resolveClineDataDir(), "logs", "requests");
}

/** A session id as a directory name. */
function folderFor(sessionId: string | undefined): string {
	return sessionId ? sessionId.replace(/[^A-Za-z0-9._-]/g, "_") : "no-session";
}

let sequence = 0;

function stemFor(request: CapturedModelRequest): string {
	sequence += 1;
	// Sorts in send order: the time, then a counter for requests in one millisecond.
	return `${request.at.replace(/[:.]/g, "-")}-${String(sequence).padStart(4, "0")}`;
}

export function createModelRequestWriter(
	options: ModelRequestCaptureOptions = {},
): (request: CapturedModelRequest) => ModelResponseWriter | undefined {
	const dir = options.dir ?? modelRequestCaptureDir();
	let warned = false;
	const warn = (error: unknown) => {
		// Said once: a full disk would otherwise log every request.
		if (!warned) {
			warned = true;
			options.logger?.log(
				`[request-capture] could not save a model request under ${dir}: ${String(error)}`,
			);
		}
	};
	const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
	return (request: CapturedModelRequest) => {
		const folder = path.join(dir, folderFor(request.sessionId));
		const stem = path.join(folder, stemFor(request));
		const written = fs
			.mkdir(folder, { recursive: true })
			.then(() => fs.writeFile(`${stem}.json`, json(request), "utf8"));
		written.catch(warn);
		if (options.responses === false) {
			return undefined;
		}
		// After the request's own file, so the folder exists and the pair is
		// never a response without its request.
		return (response: CapturedModelResponse) => {
			void written
				.then(() =>
					fs.writeFile(`${stem}.response.json`, json(response), "utf8"),
				)
				.catch(warn);
		};
	};
}

/**
 * Switch the capture on or off for this process. On Ollama and xOllama a
 * switch takes effect at the next request; on every other provider, with the
 * next session. Returns the directory written to, or `undefined` when off.
 */
export function applyModelRequestCapture(
	enabled: boolean | ModelRequestCaptureOptions,
	logger?: Pick<BasicLogger, "log">,
): string | undefined {
	if (enabled === false) {
		setModelRequestCapture(undefined);
		return undefined;
	}
	const options = enabled === true ? {} : enabled;
	const dir = options.dir ?? modelRequestCaptureDir();
	setModelRequestCapture(createModelRequestWriter({ logger, ...options, dir }));
	return dir;
}

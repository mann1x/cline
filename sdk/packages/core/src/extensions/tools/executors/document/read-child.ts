/**
 * The reader process: one document, read away from the session.
 *
 * Started by `read-process.ts` with an IPC channel, handed one `ReadJob`, and
 * gone when it has answered. A PDF decoder or an OCR engine that runs out of
 * memory, or stops answering, takes this process with it and nothing else.
 *
 * Pictures go back as files in the job's scratch directory, not over the
 * channel: a scanned book is a picture a page.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentImageToDescribe } from "@cline/shared";
import { type ReadJob, runReadJob } from "./read-job";
import {
	type ChildMessage,
	type ParentMessage,
	READ_OUTPUT_DIRECTORY,
} from "./read-protocol";

const channel = process as NodeJS.Process & {
	send?: (
		message: ChildMessage,
		callback?: (error: Error | null) => void,
	) => boolean;
};

/**
 * Resolves when the message has been written to the channel, not when it was
 * queued: an answer is megabytes, and a process that leaves while it is still
 * in the queue takes the rest of it along (measured on Windows: a 769-page
 * book read to the end, and no answer).
 */
function post(message: ChildMessage): Promise<void> {
	return new Promise((resolve) => {
		// A parent that is gone has no use for the answer.
		if (!process.connected || !channel.send) {
			resolve();
			return;
		}
		channel.send(message, () => resolve());
	});
}

const controller = new AbortController();
const describing = new Map<
	number,
	{
		resolve: (value: readonly (string | undefined)[]) => void;
		reject: (error: Error) => void;
	}
>();
let nextDescribe = 0;

function describeThroughParent(
	images: readonly AgentImageToDescribe[],
): Promise<readonly (string | undefined)[]> {
	const id = nextDescribe++;
	return new Promise((resolve, reject) => {
		describing.set(id, { resolve, reject });
		void post({ type: "describe", id, images: [...images] });
	});
}

async function run(job: ReadJob, hasVision: boolean): Promise<void> {
	const started = Date.now();
	try {
		const done = await runReadJob(job, {
			signal: controller.signal,
			onProgress: (progress) => void post({ type: "progress", progress }),
			onNote: (line) => void post({ type: "note", line }),
			...(hasVision ? { describeImages: describeThroughParent } : {}),
		});
		const outputDir = join(job.scratchDir, READ_OUTPUT_DIRECTORY);
		await mkdir(outputDir, { recursive: true });
		const images: Extract<ChildMessage, { type: "done" }>["images"] = [];
		for (const [index, { image, data }] of done.images.entries()) {
			const file = join(outputDir, String(index));
			await writeFile(file, data);
			images.push({ image, file });
		}
		await post({
			type: "done",
			format: done.format,
			result: done.result,
			images,
			recognitionNotes: done.recognitionNotes,
			recognitionProblems: done.recognitionProblems,
			attachments: done.attachments,
			problems: done.problems,
			usage: {
				ms: Date.now() - started,
				peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
			},
		});
	} catch (error) {
		await post({
			type: "failed",
			message: error instanceof Error ? error.message : String(error),
			aborted: controller.signal.aborted,
		});
	}
	// Leave when the session says the answer arrived whole, and not before: a
	// channel closed behind a large message can lose its tail. The limit is for
	// a session that is gone without the channel noticing.
	await Promise.race([
		received,
		new Promise((resolve) => setTimeout(resolve, ANSWER_LIMIT_MS).unref()),
	]);
	// Whatever a decoder or a worker thread left open does not keep this alive.
	process.exit(0);
}

const ANSWER_LIMIT_MS = 60_000;
let acknowledge: () => void = () => {};
const received = new Promise<void>((resolve) => {
	acknowledge = resolve;
});

let started = false;
process.on("message", (message: ParentMessage) => {
	if (message.type === "start" && !started) {
		started = true;
		void run(message.job, message.hasVision);
	} else if (message.type === "received") {
		acknowledge();
	} else if (message.type === "abort") {
		controller.abort();
	} else if (message.type === "described") {
		const waiting = describing.get(message.id);
		describing.delete(message.id);
		if (!waiting) return;
		if (message.error !== undefined) waiting.reject(new Error(message.error));
		else waiting.resolve(message.descriptions ?? []);
	}
});

// The session ended, or its process died: there is no one to read for.
process.on("disconnect", () => process.exit(0));

void post({ type: "ready" });

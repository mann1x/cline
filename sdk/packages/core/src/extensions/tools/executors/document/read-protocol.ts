/**
 * What the session and its reader process say to each other.
 *
 * Sent over Node's IPC channel with structured-clone serialization, so byte
 * arrays arrive as byte arrays.
 */

import type { AgentImageToDescribe } from "@cline/shared";
import type {
	DocumentFormat,
	DocumentReadResult,
	ReadProgress,
} from "./formats";
import type { ExtractedImage } from "./images";
import type { ReadJob } from "./read-job";

/** Where, inside the job's scratch directory, the pictures are handed back. */
export const READ_OUTPUT_DIRECTORY = ".out";

export type ParentMessage =
	| { type: "start"; job: ReadJob; hasVision: boolean }
	| { type: "abort" }
	/** The answer arrived whole: the reader may go. */
	| { type: "received" }
	| {
			type: "described";
			id: number;
			descriptions?: (string | undefined)[];
			error?: string;
	  };

export type ChildMessage =
	| { type: "ready" }
	| { type: "progress"; progress: ReadProgress }
	| { type: "note"; line: string }
	| { type: "describe"; id: number; images: AgentImageToDescribe[] }
	| {
			type: "done";
			format: DocumentFormat;
			result: DocumentReadResult;
			/** Each picture's bytes are in `file`. */
			images: { image: ExtractedImage; file: string }[];
			recognitionNotes: string[];
			recognitionProblems: string[];
			attachments: { page: number; png: Uint8Array }[];
			problems: string[];
			usage: { ms: number; peakRssMb: number };
	  }
	| { type: "failed"; message: string; aborted: boolean };

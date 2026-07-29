// LanguageModelV4 middleware that preserves media returned by tools for
// providers whose tool-message wire format only accepts text.
//
// AI SDK 7 represents tool media as `file` parts with tagged data
// (`data`, `url`, `reference`, or `text`). For each media-bearing tool result
// this middleware:
//
//   1. replaces the file in the tool result with a short text placeholder;
//   2. inserts a synthetic user message containing the typed file part.
//
// The downstream provider can then serialize a regular multimodal user
// message without stringifying image bytes into opaque tool-result text.

import type {
	LanguageModelV4CallOptions,
	LanguageModelV4FilePart,
	LanguageModelV4Message,
	LanguageModelV4Middleware,
	LanguageModelV4TextPart,
	LanguageModelV4ToolResultOutput,
	LanguageModelV4ToolResultPart,
} from "@ai-sdk/provider";
import {
	createMediaBudgetState,
	DEFAULT_MAX_IMAGE_DECODED_BYTES,
	DEFAULT_MAX_IMAGE_ENCODED_BYTES,
	IMAGE_OMITTED_PLACEHOLDER,
	type MediaBudgetState,
	reserveImageMediaBytes,
	validateAndReserveImageMedia,
} from "@cline/shared";

const IMAGE_PLACEHOLDER = "(see following user message for image)";

type ContentOutput = Extract<
	LanguageModelV4ToolResultOutput,
	{ type: "content" }
>;
type ContentPart = ContentOutput["value"][number];
type FileContentPart = Extract<ContentPart, { type: "file" }>;

interface SplitResult {
	stripped: ContentOutput;
	media: LanguageModelV4FilePart[];
}

function imageOmittedTextPart(): LanguageModelV4TextPart {
	return {
		type: "text",
		text: IMAGE_OMITTED_PLACEHOLDER,
	};
}

function isTransferableMediaPart(part: ContentPart): part is FileContentPart & {
	data: Extract<FileContentPart["data"], { type: "data" | "url" }>;
} {
	return (
		part.type === "file" &&
		(part.data.type === "data" || part.data.type === "url")
	);
}

function reserveRemoteMediaBudget(
	url: URL,
	mediaState: MediaBudgetState,
): boolean {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return false;
	}

	// The byte size is unknown until the provider downloads it, so charge the
	// conservative per-image cap instead of treating URL media as free.
	return (
		reserveImageMediaBytes(
			DEFAULT_MAX_IMAGE_ENCODED_BYTES,
			0,
			{
				maxImageEncodedBytes: DEFAULT_MAX_IMAGE_ENCODED_BYTES,
				maxImageDecodedBytes: DEFAULT_MAX_IMAGE_DECODED_BYTES,
			},
			mediaState,
		) === null
	);
}

function estimateMediaDataEncodedBytes(data: Uint8Array | string): number {
	return typeof data === "string" ? data.length : data.byteLength;
}

function reserveGenericMediaDataBudget(
	data: Uint8Array | string,
	mediaState: MediaBudgetState,
): boolean {
	return (
		reserveImageMediaBytes(
			estimateMediaDataEncodedBytes(data),
			0,
			{
				maxImageEncodedBytes: DEFAULT_MAX_IMAGE_ENCODED_BYTES,
				maxImageDecodedBytes: DEFAULT_MAX_IMAGE_DECODED_BYTES,
			},
			mediaState,
		) === null
	);
}

function normalizeTransferableMediaPart(
	part: FileContentPart & {
		data: Extract<FileContentPart["data"], { type: "data" | "url" }>;
	},
	mediaState: MediaBudgetState,
): LanguageModelV4FilePart | null {
	if (part.data.type === "url") {
		if (part.data.url.protocol === "data:") {
			const validation = validateAndReserveImageMedia(
				part.mediaType,
				part.data.url.href,
				{
					maxImageEncodedBytes: DEFAULT_MAX_IMAGE_ENCODED_BYTES,
					maxImageDecodedBytes: DEFAULT_MAX_IMAGE_DECODED_BYTES,
				},
				mediaState,
			);
			if (!validation.ok) {
				return null;
			}
			return {
				...part,
				data: { type: "data", data: validation.base64 },
				mediaType: validation.mediaType,
			};
		}
		return reserveRemoteMediaBudget(part.data.url, mediaState) ? part : null;
	}

	if (part.mediaType === "image" || part.mediaType.startsWith("image/")) {
		const encoded =
			typeof part.data.data === "string"
				? part.data.data
				: Buffer.from(part.data.data).toString("base64");
		const validation = validateAndReserveImageMedia(
			part.mediaType,
			encoded,
			{
				maxImageEncodedBytes: DEFAULT_MAX_IMAGE_ENCODED_BYTES,
				maxImageDecodedBytes: DEFAULT_MAX_IMAGE_DECODED_BYTES,
			},
			mediaState,
		);
		if (!validation.ok) {
			return null;
		}
		return {
			...part,
			data: { type: "data", data: validation.base64 },
			mediaType: validation.mediaType,
		};
	}

	return reserveGenericMediaDataBudget(part.data.data, mediaState)
		? part
		: null;
}

function splitContentOutputMedia(
	output: LanguageModelV4ToolResultOutput,
	mediaState: MediaBudgetState,
): SplitResult | null {
	if (output.type !== "content") {
		return null;
	}

	const media: LanguageModelV4FilePart[] = [];
	const value: ContentOutput["value"] = [];
	let mutated = false;
	for (const part of output.value) {
		if (!isTransferableMediaPart(part)) {
			value.push(part);
			continue;
		}

		const normalized = normalizeTransferableMediaPart(part, mediaState);
		value.push(
			normalized
				? { type: "text", text: IMAGE_PLACEHOLDER }
				: imageOmittedTextPart(),
		);
		if (normalized) {
			media.push(normalized);
		}
		mutated = true;
	}

	return mutated
		? {
				stripped: { type: "content", value },
				media,
			}
		: null;
}

export function rewritePromptToolImages(prompt: LanguageModelV4Message[]): {
	prompt: LanguageModelV4Message[];
	mutated: boolean;
} {
	const rewritten: LanguageModelV4Message[] = [];
	const mediaState = createMediaBudgetState();
	let mutated = false;

	for (const message of prompt) {
		if (message.role !== "tool") {
			rewritten.push(message);
			continue;
		}

		const collectedMedia: LanguageModelV4FilePart[] = [];
		const content: typeof message.content = message.content.map((part) => {
			if (part.type !== "tool-result") {
				return part;
			}
			const split = splitContentOutputMedia(part.output, mediaState);
			if (!split) {
				return part;
			}
			collectedMedia.push(...split.media);
			mutated = true;
			return {
				...part,
				output: split.stripped,
			} satisfies LanguageModelV4ToolResultPart;
		});

		rewritten.push({ ...message, content });
		if (collectedMedia.length > 0) {
			rewritten.push({ role: "user", content: collectedMedia });
		}
	}

	return { prompt: rewritten, mutated };
}

export const splitToolImagesMiddleware: LanguageModelV4Middleware = {
	specificationVersion: "v4",
	transformParams: async ({ params }) => {
		const { prompt, mutated } = rewritePromptToolImages(params.prompt);
		return mutated
			? ({
					...params,
					prompt,
				} satisfies LanguageModelV4CallOptions)
			: params;
	},
};

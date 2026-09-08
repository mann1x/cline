/**
 * Put tool-result images back on the tool message, on the way out.
 *
 * `splitToolImagesMiddleware` moves image bytes out of a `role:"tool"` message
 * and into a synthetic `role:"user"` message placed immediately after it. That
 * is the only shape chat-completions can carry, and for those wire formats it
 * is correct. Ollama's native `/api/chat` is not one of them: `images` is a
 * field on every message, tool messages included, and every renderer that
 * handles images at all routes tool responses through the same content path.
 *
 * Leaving the synthetic user message in place is not merely redundant there —
 * it is destructive. Chat templates decide how much of the assistant's own
 * reasoning to replay from the position of the last user turn:
 *
 *     if message.Role == "assistant" && message.Thinking != "" && i > lastUserIdx
 *         (ollama, model/renderers/gemma4.go)
 *
 * A user message injected after every screenshot moves `lastUserIdx` to the end
 * of the conversation, so *every* thinking block before it stops being
 * rendered. Measured on a live session: 209,028 characters of prompt became
 * 104,026 — the model's entire reasoning history, three blocks of it over
 * 20,000 characters each, gone from a request that otherwise looked fine. The
 * model then reads fourteen turns of assistants that did not think, and stops
 * thinking. It recovers only when compaction happens to drop the screenshots.
 *
 * So this runs at the wire layer rather than as another middleware: the
 * conversion that loses the images (`convertToOllamaChatMessages`, whose `tool`
 * branch writes `content` and nothing else) sits between the typed prompt and
 * here, and this is the first point where the images and the tool message they
 * belong to exist in the same object again.
 */

/** What the splitting middleware leaves behind in the tool result. */
export const OLLAMA_SPLIT_IMAGE_PLACEHOLDER =
	"(see following user message for image)";

/** What it should say once the image is back where it came from. */
const MERGED_IMAGE_NOTE = "(image attached to this tool result)";

interface WireMessage {
	role?: unknown;
	content?: unknown;
	images?: unknown;
	[key: string]: unknown;
}

function isWireMessage(value: unknown): value is WireMessage {
	return typeof value === "object" && value !== null;
}

function imagesOf(message: WireMessage): unknown[] {
	return Array.isArray(message.images) ? message.images : [];
}

/**
 * Whether this message is one the middleware created rather than one the user
 * wrote.
 *
 * The test is deliberately narrow — images, and no text beyond the placeholder
 * the middleware itself wrote. A user message that carries an image *and*
 * something to say is a real turn, and moving it would change what the model
 * was asked.
 */
function isSyntheticImageMessage(message: WireMessage): boolean {
	if (message.role !== "user" || imagesOf(message).length === 0) {
		return false;
	}
	const content = message.content;
	if (content === undefined || content === null) {
		return true;
	}
	if (typeof content !== "string") {
		return false;
	}
	return (
		content.split(OLLAMA_SPLIT_IMAGE_PLACEHOLDER).join("").trim().length === 0
	);
}

export interface MergeToolImagesResult {
	messages: unknown[];
	/** How many synthetic user messages were folded away. */
	merged: number;
}

/**
 * Fold each synthetic image message into the tool message it follows.
 *
 * A synthetic message that does not follow a tool message is left exactly
 * where it is: that is either a real user turn or a shape this function does
 * not recognise, and dropping an image is worse than the prompt cost of one
 * extra message.
 */
export function mergeOllamaToolImages(
	messages: unknown,
): MergeToolImagesResult {
	if (!Array.isArray(messages)) {
		return { messages: [], merged: 0 };
	}
	const out: unknown[] = [];
	let merged = 0;
	for (const entry of messages) {
		const previous = out.at(-1);
		if (
			isWireMessage(entry) &&
			isSyntheticImageMessage(entry) &&
			isWireMessage(previous) &&
			previous.role === "tool"
		) {
			const host: WireMessage = { ...previous };
			host.images = [...imagesOf(host), ...imagesOf(entry)];
			if (typeof host.content === "string") {
				host.content = host.content
					.split(OLLAMA_SPLIT_IMAGE_PLACEHOLDER)
					.join(MERGED_IMAGE_NOTE);
			}
			out[out.length - 1] = host;
			merged += 1;
			continue;
		}
		out.push(entry);
	}
	return { messages: out, merged };
}

export interface RewrittenOllamaBody {
	/** The body to send, unchanged when there was nothing to do. */
	body: string;
	/** The model this request is for, when the body names one. */
	model?: string;
	merged: number;
}

/**
 * Rewrite a serialized `/api/chat` body, and read the model name while it is
 * parsed.
 *
 * Both callers want something out of the same parse, and a request body at
 * these sizes is not something to parse twice: the transcripts that trigger
 * this are a quarter of a megabyte, most of it base64.
 *
 * Never throws. A body that is not JSON, or not a chat body, is something this
 * has no opinion about — it goes out as it came in.
 */
export function rewriteOllamaChatBody(
	body: unknown,
): RewrittenOllamaBody | undefined {
	if (typeof body !== "string" || body.length === 0) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (!isWireMessage(parsed) || !Array.isArray(parsed.messages)) {
		return undefined;
	}
	const model = typeof parsed.model === "string" ? parsed.model : undefined;
	const { messages, merged } = mergeOllamaToolImages(parsed.messages);
	if (merged === 0) {
		return { body, model, merged: 0 };
	}
	return {
		body: JSON.stringify({ ...parsed, messages }),
		model,
		merged,
	};
}

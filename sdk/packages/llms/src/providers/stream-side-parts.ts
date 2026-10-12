/**
 * Stream parts that reach a request by a second road.
 *
 * The AI SDK's provider packages decide what a response chunk becomes, and a
 * field they do not know becomes nothing. xOllama's `tool_call_progress` is
 * such a field: the text of a tool call while the model is still writing it,
 * which the ollama provider drops because upstream Ollama never sends it. The
 * vendor's fetch wrapper can read it off the wire, but a fetch wrapper has no
 * way to add to the stream the SDK builds from the response.
 *
 * So the two meet here. The vendor opens a queue when it builds the request's
 * settings and names it in a request header; its fetch wrapper finds the queue
 * by that header, strips the header, and pushes parts; the event loop in
 * `ai-sdk.ts` reads the same queue beside the SDK's own stream. The parts are
 * the SDK's own shapes (`tool-input-delta`), so nothing downstream knows they
 * came another way.
 */

/** Names the queue of a request. Never sent to a server. */
export const STREAM_SIDE_PARTS_HEADER = "x-cerebriline-stream-parts";

export type StreamSidePart = (
	| { type: "tool-input-delta"; id: string; delta: string }
	| { type: "tool-input-end"; id: string }
) & {
	/** Set on every part that came this way, never by a provider package. */
	outOfBand?: true;
};

export class StreamSideParts {
	private readonly parts: StreamSidePart[] = [];
	private wake: (() => void) | undefined;

	constructor(readonly id: string) {}

	/**
	 * Whether a call's text has come this way. The provider package then
	 * reports the same call a second time, whole, when it is complete -- under
	 * its own id and as JSON -- and a view of the stream showed both: the call
	 * as the model wrote it, then the call again (pandorum, 2026-10-12).
	 */
	wroteCallText = false;

	push(part: StreamSidePart): void {
		if (part.type === "tool-input-delta" && part.delta.length > 0) {
			this.wroteCallText = true;
		}
		this.parts.push({ ...part, outOfBand: true });
		const wake = this.wake;
		this.wake = undefined;
		wake?.();
	}

	take(): StreamSidePart[] {
		return this.parts.splice(0, this.parts.length);
	}

	/** Resolves when there is something to take. */
	arrived(): Promise<void> {
		if (this.parts.length > 0) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.wake = resolve;
		});
	}
}

/**
 * Whether a part of the provider's own stream repeats a call whose text the
 * side road already delivered, and so is not to be reported again.
 */
export function repeatsStreamSideParts(
	part: { type?: string; outOfBand?: boolean; [key: string]: unknown },
	side: StreamSideParts | undefined,
): boolean {
	return (
		side?.wroteCallText === true &&
		part.outOfBand !== true &&
		(part.type === "tool-input-start" ||
			part.type === "tool-input-delta" ||
			part.type === "tool-input-end")
	);
}

/** A request that never streamed must not keep its queue for ever. */
const MAX_OPEN_QUEUES = 256;
const queues = new Map<string, StreamSideParts>();
let opened = 0;

export function openStreamSideParts(): StreamSideParts {
	opened += 1;
	const queue = new StreamSideParts(`${Date.now().toString(36)}-${opened}`);
	queues.set(queue.id, queue);
	if (queues.size > MAX_OPEN_QUEUES) {
		const oldest = queues.keys().next().value;
		if (oldest !== undefined) {
			queues.delete(oldest);
		}
	}
	return queue;
}

export function streamSidePartsById(
	id: string | undefined,
): StreamSideParts | undefined {
	return id === undefined ? undefined : queues.get(id);
}

export function closeStreamSideParts(queue: StreamSideParts | undefined): void {
	if (queue) {
		queues.delete(queue.id);
	}
}

/** The queue a request's headers name, if any. */
export function streamSidePartsOf(
	headers: Record<string, string | undefined> | undefined,
): StreamSideParts | undefined {
	if (!headers) {
		return undefined;
	}
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === STREAM_SIDE_PARTS_HEADER) {
			return streamSidePartsById(value);
		}
	}
	return undefined;
}

/**
 * The SDK's stream with the side parts let in as they arrive.
 *
 * A side part is delivered at once, not at the next part of the main stream:
 * the case this exists for is a main stream that says nothing for minutes.
 */
export async function* withStreamSideParts<T>(
	main: AsyncIterable<T>,
	side: StreamSideParts | undefined,
): AsyncGenerator<T | StreamSidePart> {
	if (!side) {
		yield* main;
		return;
	}
	const iterator = main[Symbol.asyncIterator]();
	let next = iterator.next();
	let finished = false;
	try {
		while (true) {
			const winner = await Promise.race([
				next.then((result) => ({ result })),
				side.arrived().then(() => undefined),
			]);
			for (const part of side.take()) {
				yield part;
			}
			if (!winner) {
				continue;
			}
			if (winner.result.done) {
				finished = true;
				return;
			}
			yield winner.result.value;
			next = iterator.next();
		}
	} finally {
		if (!finished) {
			// Left early: the consumer cut the stream. Close the SDK's side so
			// the request is cancelled, without waiting on a part that may
			// never come.
			next.catch(() => undefined);
			void iterator.return?.(undefined);
		}
	}
}

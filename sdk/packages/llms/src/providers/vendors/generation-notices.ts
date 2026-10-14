// Generation notices: opencoti (c13) plants one short line into the model's
// own output at a prose boundary when its thinking or answer room is nearly
// used up, or when the client says a message is waiting. The owner's rulings
// (xollama #1305, opencoti #1310, 2026-10-14):
//
// - Opt-in per request, never on by default: a request without a `notices`
//   object gets none.
// - The line stays INLINE where it was planted -- in the thinking while the
//   model thinks, in the content after -- and is sent back in the history
//   byte for byte. Stripped from the history, the engine re-reads the answer
//   from that point every turn (~1000 tokens a turn measured on Qwen3.5/3.6
//   and LFM2.5, whose state restores only at the end of the prompt).
// - The client hides it from the user's display, and nowhere else.
//
// The request and the capability are opencoti's c13 design and were still
// PROPOSED when this was written (#1309, #1310, #1311): everything here is
// gated on the server saying it supports notices, and the marker that
// identifies a planted line is read from the server rather than written here.

/** What the profile asks for, from the provider panel's Notices section. */
export interface GenerationNoticeSettings {
	/** Off unless `true`. */
	enabled?: boolean;
	/** Percent of the thinking room at which a notice is planted. */
	thinkSteps?: number[];
	/** Percent of the answer room at which a notice is planted. */
	answerSteps?: number[];
}

/** The ladder the owner described: up to four per phase. */
export const DEFAULT_NOTICE_STEPS: readonly number[] = [60, 70, 80, 90];

/** At most this many steps per phase; the server refuses more (400). */
export const MAX_NOTICE_STEPS = 4;

/**
 * The feature name a server reports. opencoti proposed the first, xollama the
 * second (#1311 asks them to settle on one); either is read as support.
 */
export const GENERATION_NOTICE_FEATURES: readonly string[] = [
	"generation_notice_v1",
	"generation_notices_v1",
];

/** What a server says about notices. */
export interface GenerationNoticeCapability {
	supported: boolean;
	/**
	 * The prefix every planted line starts with, as the server publishes it
	 * (`generation_notice.marker`). Without it a line cannot be told from
	 * the model's own text, so nothing is hidden: shown is better than a
	 * guessed line of the model's answer gone missing.
	 */
	marker?: string;
}

/**
 * Every marker a server in this process has published. The display hides a
 * planted line by its marker, and it renders rows long after the request that
 * asked for them, without knowing which server wrote them.
 */
const KNOWN_MARKERS = new Set<string>();

/**
 * Read the capability from a server's own description of itself: opencoti's
 * `/props` or xOllama's `/api/xollama`. Both carry `features`; the marker is
 * the `generation_notice` object's `marker`.
 */
export function readGenerationNoticeCapability(body: {
	features?: unknown;
	generation_notice?: unknown;
}): GenerationNoticeCapability {
	const features = Array.isArray(body.features)
		? body.features.filter((f): f is string => typeof f === "string")
		: [];
	const block =
		body.generation_notice && typeof body.generation_notice === "object"
			? (body.generation_notice as { marker?: unknown })
			: undefined;
	const supported =
		features.some((f) => GENERATION_NOTICE_FEATURES.includes(f)) ||
		block !== undefined;
	const marker =
		typeof block?.marker === "string" && block.marker.trim() !== ""
			? block.marker
			: undefined;
	if (marker) {
		KNOWN_MARKERS.add(marker);
	}
	return { supported, ...(marker ? { marker } : {}) };
}

/**
 * `hideNoticeLines` for every marker a server has published here. For the
 * display only, like it: the stored text keeps every line.
 */
export function hideKnownNoticeLines(
	text: string,
	options?: { streaming?: boolean },
): string {
	let shown = text;
	for (const marker of KNOWN_MARKERS) {
		shown = hideNoticeLines(shown, marker, options);
	}
	return shown;
}

/** The steps to send for one phase: whole percents, 1-99, sorted, at most four. */
export function normalizeNoticeSteps(
	steps: readonly number[] | undefined,
): number[] {
	const source = steps ?? DEFAULT_NOTICE_STEPS;
	const clean = [
		...new Set(
			source
				.filter((step) => Number.isFinite(step))
				.map((step) => Math.round(step))
				.filter((step) => step >= 1 && step <= 99),
		),
	].sort((a, b) => a - b);
	return clean.slice(0, MAX_NOTICE_STEPS);
}

/** The request's `notices` object, or `undefined` when none is asked for. */
export function buildNoticesField(
	settings: GenerationNoticeSettings | undefined,
	key: string,
): Record<string, unknown> | undefined {
	if (settings?.enabled !== true) {
		return undefined;
	}
	const think = normalizeNoticeSteps(settings.thinkSteps);
	const answer = normalizeNoticeSteps(settings.answerSteps);
	if (think.length === 0 && answer.length === 0) {
		return undefined;
	}
	return {
		key,
		...(think.length > 0
			? { think: think.map((at) => ({ at_percent: at })) }
			: {}),
		...(answer.length > 0
			? { answer: answer.map((at) => ({ at_percent: at })) }
			: {}),
	};
}

/** Read the settings off a provider config's options bag. */
export function readGenerationNoticeSettings(
	options: Readonly<Record<string, unknown>> | undefined,
): GenerationNoticeSettings | undefined {
	const notices = options?.notices;
	if (!notices || typeof notices !== "object") {
		return undefined;
	}
	const value = notices as Record<string, unknown>;
	const steps = (raw: unknown) =>
		Array.isArray(raw)
			? raw.filter((n): n is number => typeof n === "number")
			: undefined;
	return {
		enabled: value.enabled === true,
		...(steps(value.thinkSteps) ? { thinkSteps: steps(value.thinkSteps) } : {}),
		...(steps(value.answerSteps)
			? { answerSteps: steps(value.answerSteps) }
			: {}),
	};
}

/**
 * A fresh key per request: the server answers a key already in flight with a
 * 409, so a retry must not reuse one. The session id makes it readable in the
 * server's log.
 */
export function newNoticeKey(sessionId: string | undefined): string {
	const random = Math.random().toString(36).slice(2, 10);
	return `${sessionId ?? "cerebriline"}:${Date.now().toString(36)}${random}`;
}

/** Where a waiting-message signal goes for the request in flight. */
interface InFlightNotice {
	key: string;
	/** The route that takes `{key, kind}` for this server. */
	url: string;
	fetch: typeof fetch;
	headers?: Record<string, string>;
}

const IN_FLIGHT = new Map<string, InFlightNotice>();

/**
 * Remember the request a session has in flight with notices on, so a message
 * the user queues during it can be signalled. Returns the release, called
 * when the response ends.
 */
export function trackNoticeRequest(
	sessionId: string,
	notice: InFlightNotice,
): () => void {
	IN_FLIGHT.set(sessionId, notice);
	return () => {
		if (IN_FLIGHT.get(sessionId) === notice) {
			IN_FLIGHT.delete(sessionId);
		}
	};
}

/**
 * Tell the engine a message is waiting for the session's running request.
 * The engine plants a line at its next boundary and the model decides what to
 * do; no content of the message is sent. Quiet when nothing is in flight, and
 * when the server answers 404 (the request ended first).
 */
export async function signalNoticeMessageWaiting(
	sessionId: string,
): Promise<boolean> {
	const notice = IN_FLIGHT.get(sessionId);
	if (!notice) {
		return false;
	}
	try {
		const response = await notice.fetch(notice.url, {
			method: "POST",
			headers: { "content-type": "application/json", ...notice.headers },
			body: JSON.stringify({ key: notice.key, kind: "message_waiting" }),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/** Test seam. */
export function resetNoticeRequests(): void {
	IN_FLIGHT.clear();
	KNOWN_MARKERS.clear();
}

/**
 * The text with every planted line removed, for display only.
 *
 * A planted line is always a whole line of its own, so a line whose text
 * starts with the marker goes, with its line break. While streaming, a last
 * line that could still become one (it is a prefix of the marker, or starts
 * with it and has not ended) is held back, so a notice never flashes up while
 * it arrives in pieces. The stored text is never passed through this.
 */
export function hideNoticeLines(
	text: string,
	marker: string | undefined,
	options?: { streaming?: boolean },
): string {
	if (!marker || text === "") {
		return text;
	}
	const lines = text.split("\n");
	const last = lines.length - 1;
	const kept: string[] = [];
	lines.forEach((line, index) => {
		const trimmed = line.trimStart();
		if (trimmed.startsWith(marker)) {
			return;
		}
		if (
			options?.streaming &&
			index === last &&
			trimmed !== "" &&
			marker.startsWith(trimmed)
		) {
			return;
		}
		kept.push(line);
	});
	return kept.join("\n");
}

/** Call `done` once the response body has been read to the end, or dropped. */
function whenNoticeBodyEnds(response: Response, done: () => void): Response {
	if (!response.body) {
		done();
		return response;
	}
	let finished = false;
	const finish = () => {
		if (!finished) {
			finished = true;
			done();
		}
	};
	const reader = response.body.getReader();
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done: ended, value } = await reader.read();
				if (ended) {
					finish();
					controller.close();
					return;
				}
				controller.enqueue(value);
			} catch (error) {
				finish();
				controller.error(error);
			}
		},
		cancel(reason) {
			finish();
			return reader.cancel(reason);
		},
	});
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

/**
 * Put the profile's `notices` on a conversation's chat requests, on a server
 * that says it supports them.
 *
 * Only a conversation turn asks for notices: a compaction or a call made for
 * another conversation (`sideCall`) does not -- a summary is new text, and a
 * line planted in it would be stored as the summary's own words.
 */
export function withGenerationNotices(
	baseFetch: typeof fetch,
	options: {
		settings: GenerationNoticeSettings | undefined;
		/** The engine session the request belongs to. */
		sessionId: string | undefined;
		/** A call outside the conversation; never given notices. */
		sideCall?: boolean;
		/** Whether this is the chat route: notices go on chat requests only. */
		isChat: (url: string) => boolean;
		/** The server's capability, read once and cached by the caller. */
		capability: () => Promise<GenerationNoticeCapability | undefined>;
		/** The route that takes the waiting-message signal. */
		signalUrl: string;
		headers?: Record<string, string>;
	},
): typeof fetch {
	if (options.settings?.enabled !== true || options.sideCall) {
		return baseFetch;
	}
	return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (typeof init?.body !== "string" || !options.isChat(url)) {
			return baseFetch(input, init);
		}
		const capability = await options.capability().catch(() => undefined);
		if (!capability?.supported) {
			return baseFetch(input, init);
		}
		let body: Record<string, unknown>;
		try {
			body = JSON.parse(init.body) as Record<string, unknown>;
		} catch {
			return baseFetch(input, init);
		}
		const key = newNoticeKey(options.sessionId);
		const notices = buildNoticesField(options.settings, key);
		if (!notices) {
			return baseFetch(input, init);
		}
		body.notices = notices;
		const release = options.sessionId
			? trackNoticeRequest(options.sessionId, {
					key,
					url: options.signalUrl,
					fetch: baseFetch,
					...(options.headers ? { headers: options.headers } : {}),
				})
			: () => {};
		try {
			const response = await baseFetch(input, {
				...init,
				body: JSON.stringify(body),
			});
			return whenNoticeBodyEnds(response, release);
		} catch (error) {
			release();
			throw error;
		}
	}) as typeof fetch;
}

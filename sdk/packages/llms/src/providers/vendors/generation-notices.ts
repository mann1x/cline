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
//
// Three contracts are read, newest first (opencoti #1577, owner 2026-10-17):
//
// - v3 (`generation_notice_v3`): a notice is a plain sentence, planted as its
//   own paragraph. The engine names each one as it plants it -- a top-level
//   `notice: {index, phase, text}` on a stream chunk, and `timings.notices` at
//   the end -- so the display hides that exact text, not a form. The wording
//   of each step can be set in Settings > Features (`setNoticeTemplates`).
//   A conversation shown again has no stream to name its notices: there a
//   whole line equal to a known form (the server's built-in v3 forms, or our
//   own templates) with each wildcard a whole number is hidden.
// - v2 (`generation_notice_v2`): `<engine_status>...</engine_status>`, hidden
//   by the spans the server publishes in `generation_notice.hide`.
// - v1: a line that starts with the server's `marker`.

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
	"generation_notice_v2",
	"generation_notice_v3",
];

/** The v3 contract: exact lines in the stream, templates in plain text. */
export const GENERATION_NOTICE_V3_FEATURE = "generation_notice_v3";

/** A v2 notice runs from `open` at a line start through `close`, or to its line's end. */
export interface NoticeSpan {
	open: string;
	close: string | null;
}

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
	/** v3: the request may say `version: 3`, and the engine names its lines. */
	v3?: boolean;
	/** v2: the spans a planted notice occupies. */
	hide?: NoticeSpan[];
}

/**
 * Every marker a server in this process has published. The display hides a
 * planted line by its marker, and it renders rows long after the request that
 * asked for them, without knowing which server wrote them.
 */
const KNOWN_MARKERS = new Set<string>();

/** Every v2 span a server in this process has published, keyed by its open. */
const KNOWN_SPANS = new Map<string, NoticeSpan>();

/**
 * v3 forms a whole line is matched against when no stream named it: the
 * server's built-in forms, and the templates set here.
 */
const SERVER_FORMS = new Set<string>();

/** Which display channel a notice is in: thinking, or the reply. */
export type NoticeChannel = "reasoning" | "text";

/**
 * The exact v3 lines engines have named in this process, newest last. A few
 * per channel: the display is asked on every delta, and a notice is hidden
 * within the turn that planted it.
 */
const ANNOUNCED: Record<NoticeChannel, string[]> = { reasoning: [], text: [] };
const MAX_ANNOUNCED = 32;

/** Remember a line an engine says it planted. */
export function noteAnnouncedNotice(phase: unknown, text: unknown): void {
	if (typeof text !== "string" || text.trim() === "") {
		return;
	}
	const channel: NoticeChannel = phase === "thinking" ? "reasoning" : "text";
	const list = ANNOUNCED[channel];
	const line = text.trim();
	const at = list.indexOf(line);
	if (at !== -1) {
		list.splice(at, 1);
	}
	list.push(line);
	if (list.length > MAX_ANNOUNCED) {
		list.shift();
	}
}

/** The wording of each step, from Settings > Features. v3 only. */
export interface NoticeTemplates {
	/** One per thinking step, in order; blank takes the engine's line. */
	think?: readonly string[];
	/** One per answer step, in order; blank takes the engine's line. */
	answer?: readonly string[];
}

/** A v3 template is one line of at most 4096 bytes (opencoti refuses more). */
const MAX_TEMPLATE_BYTES = 4096;

function cleanTemplates(lines: readonly string[] | undefined): string[] {
	const clean = (lines ?? [])
		.slice(0, MAX_NOTICE_STEPS)
		.map((line) =>
			typeof line === "string" ? line.replace(/\s+/g, " ").trim() : "",
		)
		.map((line) =>
			new TextEncoder().encode(line).length > MAX_TEMPLATE_BYTES ? "" : line,
		);
	while (clean.length > 0 && clean[clean.length - 1] === "") {
		clean.pop();
	}
	return clean;
}

let templates: { think: string[]; answer: string[] } = {
	think: [],
	answer: [],
};

/**
 * Set the wording sent with each step, for every request after this one.
 * Step i takes line i; a blank line, or none, takes the engine's own.
 */
export function setNoticeTemplates(next: NoticeTemplates | undefined): void {
	templates = {
		think: cleanTemplates(next?.think),
		answer: cleanTemplates(next?.answer),
	};
}

export function getNoticeTemplates(): {
	think: readonly string[];
	answer: readonly string[];
} {
	return templates;
}

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
			? (body.generation_notice as {
					marker?: unknown;
					hide?: unknown;
					v3?: unknown;
				})
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
	const hide = readNoticeSpans(block?.hide);
	for (const span of hide) {
		KNOWN_SPANS.set(span.open, span);
	}
	const v3Block =
		block?.v3 && typeof block.v3 === "object"
			? (block.v3 as { think?: unknown; answer?: unknown; message?: unknown })
			: undefined;
	for (const form of readV3Forms(v3Block)) {
		SERVER_FORMS.add(form);
	}
	const v3 =
		features.includes(GENERATION_NOTICE_V3_FEATURE) || v3Block !== undefined;
	return {
		supported,
		...(marker ? { marker } : {}),
		...(v3 ? { v3: true } : {}),
		...(hide.length > 0 ? { hide } : {}),
	};
}

/** `hide` spans as published: a literal open with no '{', and a close or null. */
function readNoticeSpans(raw: unknown): NoticeSpan[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.flatMap((entry) => {
		const span = entry as { open?: unknown; close?: unknown } | null;
		if (
			typeof span?.open !== "string" ||
			span.open.trim() === "" ||
			span.open.includes("{")
		) {
			return [];
		}
		const close =
			typeof span.close === "string" && span.close !== "" ? span.close : null;
		return [{ open: span.open, close }];
	});
}

/** The built-in v3 forms: each step's `template`, and the waiting message. */
function readV3Forms(
	block: { think?: unknown; answer?: unknown; message?: unknown } | undefined,
): string[] {
	if (!block) {
		return [];
	}
	const steps = (raw: unknown) =>
		Array.isArray(raw)
			? raw.flatMap((step) => {
					const template = (step as { template?: unknown } | null)?.template;
					return typeof template === "string" ? [template] : [];
				})
			: [];
	return [
		...steps(block.think),
		...steps(block.answer),
		...(typeof block.message === "string" ? [block.message] : []),
	]
		.map((form) => form.trim())
		.filter((form) => form !== "");
}

/**
 * Every notice this process knows of, hidden from `text`: the lines engines
 * named (v3), the published spans (v2) and markers (v1), and whole lines equal
 * to a known form. For the display only: the stored text keeps every line.
 *
 * @param options.channel Where the text is shown: a v3 thinking notice is in
 *   the reasoning, every other one in the reply. Unset, both are looked for.
 */
export function hideKnownNoticeLines(
	text: string,
	options?: { streaming?: boolean; channel?: NoticeChannel },
): string {
	if (text === "") {
		return text;
	}
	let shown = text;
	for (const marker of KNOWN_MARKERS) {
		shown = hideNoticeLines(shown, marker, options);
	}
	if (KNOWN_SPANS.size > 0) {
		shown = hideNoticeSpans(shown, [...KNOWN_SPANS.values()], options);
	}
	const announced = options?.channel
		? ANNOUNCED[options.channel]
		: [...ANNOUNCED.reasoning, ...ANNOUNCED.text];
	if (announced.length > 0) {
		shown = hideAnnouncedNotices(shown, announced, options);
	}
	const forms = [
		...SERVER_FORMS,
		...templates.think,
		...templates.answer,
	].filter((form) => form !== "");
	if (forms.length > 0) {
		shown = hideNoticeForms(shown, forms);
	}
	return shown;
}

/**
 * v3: each named line removed where it stands as a line of its own, with the
 * line break after it. While streaming, a last line that is the start of a
 * named one is held back: the engine names a line before its first character
 * arrives, so it never shows while it arrives in pieces.
 */
export function hideAnnouncedNotices(
	text: string,
	notices: readonly string[],
	options?: { streaming?: boolean },
): string {
	let shown = text;
	for (const notice of notices) {
		let from = 0;
		for (;;) {
			const at = shown.indexOf(notice, from);
			if (at === -1) {
				break;
			}
			const end = at + notice.length;
			const atLineStart = at === 0 || shown[at - 1] === "\n";
			const atLineEnd =
				end === shown.length || shown[end] === "\n" || shown[end] === "\r";
			if (!atLineStart || !atLineEnd) {
				from = end;
				continue;
			}
			let cut = end;
			if (shown[cut] === "\r") {
				cut += 1;
			}
			if (shown[cut] === "\n") {
				cut += 1;
			}
			shown = shown.slice(0, at) + shown.slice(cut);
			from = at;
		}
	}
	if (options?.streaming) {
		const lineStart = shown.lastIndexOf("\n") + 1;
		const last = shown.slice(lineStart);
		if (
			last.trim() !== "" &&
			notices.some(
				(notice) => notice.length > last.length && notice.startsWith(last),
			)
		) {
			return shown.slice(0, lineStart);
		}
	}
	return shown;
}

/**
 * v2: a notice opens with a published `open` at a line start and runs through
 * its `close` -- over several lines when it must -- or to the end of the line
 * when there is none. While streaming, a last line that could still become an
 * open, and a notice whose close has not arrived, are held back.
 */
export function hideNoticeSpans(
	text: string,
	spans: readonly NoticeSpan[],
	options?: { streaming?: boolean },
): string {
	const lines = text.split("\n");
	const last = lines.length - 1;
	const kept: string[] = [];
	let open: NoticeSpan | undefined;
	lines.forEach((line, index) => {
		if (open) {
			if (open.close !== null && line.includes(open.close)) {
				open = undefined;
			}
			return;
		}
		const trimmed = line.trimStart();
		const span = spans.find((candidate) => trimmed.startsWith(candidate.open));
		if (span) {
			if (span.close !== null && !trimmed.includes(span.close)) {
				open = span;
			}
			return;
		}
		if (
			options?.streaming &&
			index === last &&
			trimmed !== "" &&
			spans.some((candidate) => candidate.open.startsWith(trimmed))
		) {
			return;
		}
		kept.push(line);
	});
	return kept.join("\n");
}

const WILDCARD = /\\\{(?:left|total|words|n)\\\}/g;

function formPattern(form: string): RegExp {
	const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped.replace(WILDCARD, "\\d+")}$`);
}

/**
 * A whole line equal to a form, with each wildcard a whole number, removed
 * with its line break. Never inside a line: that could be the model's own
 * sentence.
 */
export function hideNoticeForms(
	text: string,
	forms: readonly string[],
): string {
	const patterns = forms.map(formPattern);
	const lines = text.split("\n");
	const kept = lines.filter((line) => {
		const trimmed = line.trim();
		return trimmed === "" || !patterns.some((pattern) => pattern.test(trimmed));
	});
	return kept.length === lines.length ? text : kept.join("\n");
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
	options?: { v3?: boolean },
): Record<string, unknown> | undefined {
	if (settings?.enabled !== true) {
		return undefined;
	}
	const think = normalizeNoticeSteps(settings.thinkSteps);
	const answer = normalizeNoticeSteps(settings.answerSteps);
	if (think.length === 0 && answer.length === 0) {
		return undefined;
	}
	// Templates are v3 plain text; a v2 engine would refuse them (its templates
	// must open with a published tag), so a v2 request carries none.
	const v3 = options?.v3 === true;
	const steps = (at: number[], wording: readonly string[]) =>
		at.map((percent, index) => ({
			at_percent: percent,
			...(v3 && wording[index] ? { template: wording[index] } : {}),
		}));
	return {
		...(v3 ? { version: 3 } : {}),
		key,
		...(think.length > 0 ? { think: steps(think, templates.think) } : {}),
		...(answer.length > 0 ? { answer: steps(answer, templates.answer) } : {}),
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
	KNOWN_SPANS.clear();
	SERVER_FORMS.clear();
	ANNOUNCED.reasoning.length = 0;
	ANNOUNCED.text.length = 0;
	templates = { think: [], answer: [] };
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

/**
 * Note every notice a v3 response names, as its bytes pass to the parser: a
 * top-level `notice` on an SSE `data:` line (opencoti) or an NDJSON line
 * (xOllama), and the end-of-response list in `timings.notices` or `notices`.
 * Read before the parser emits the text, so the display knows the line first.
 */
export function readNoticeFields(line: string): void {
	if (!line.includes('"notice')) {
		return;
	}
	const json = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
	let chunk: {
		notice?: { phase?: unknown; text?: unknown };
		notices?: unknown;
		timings?: { notices?: unknown };
	};
	try {
		chunk = JSON.parse(json);
	} catch {
		return;
	}
	if (chunk?.notice && typeof chunk.notice === "object") {
		noteAnnouncedNotice(chunk.notice.phase, chunk.notice.text);
	}
	for (const list of [chunk?.timings?.notices, chunk?.notices]) {
		if (Array.isArray(list)) {
			for (const entry of list) {
				const notice = entry as { phase?: unknown; text?: unknown } | null;
				noteAnnouncedNotice(notice?.phase, notice?.text);
			}
		}
	}
}

/** Call `done` once the response body has been read to the end, or dropped. */
function whenNoticeBodyEnds(
	response: Response,
	done: () => void,
	onLine?: (line: string) => void,
): Response {
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
	const decoder = onLine ? new TextDecoder() : undefined;
	let pending = "";
	const scan = (bytes: Uint8Array | undefined) => {
		if (!decoder || !onLine) {
			return;
		}
		pending += bytes
			? decoder.decode(bytes, { stream: true })
			: decoder.decode();
		const lines = pending.split("\n");
		pending = bytes ? (lines.pop() ?? "") : "";
		for (const line of lines) {
			onLine(line);
		}
	};
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done: ended, value } = await reader.read();
				if (ended) {
					scan(undefined);
					finish();
					controller.close();
					return;
				}
				scan(value);
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
		const v3 = capability.v3 === true;
		const notices = buildNoticesField(options.settings, key, { v3 });
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
			return whenNoticeBodyEnds(
				response,
				release,
				v3 ? readNoticeFields : undefined,
			);
		} catch (error) {
			release();
			throw error;
		}
	}) as typeof fetch;
}

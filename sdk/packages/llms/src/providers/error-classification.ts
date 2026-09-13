import { type ProviderErrorClass, safeJsonParse } from "@cline/shared";
import { AISDKError, APICallError, RetryError, TypeValidationError } from "ai";

/**
 * Provider codes that unambiguously identify a context-window overflow
 * (OpenAI-family `error.code`).
 */
const CONTEXT_WINDOW_CODES = new Set(["context_length_exceeded"]);

/**
 * Message shapes providers use for context-window overflow. Sourced from the
 * legacy extension's per-provider detectors (OpenAI, OpenRouter, Anthropic,
 * Cerebras, Bedrock, Vercel gateway / Alibaba Qwen) — the wire messages are
 * provider-authored and identical on the SDK arch; only the surrounding
 * error-object structure changed (handled by the signal walk below).
 */
const CONTEXT_WINDOW_PATTERNS = [
	/\bcontext\s*(?:length|window|limit)\b/i,
	/\bmaximum\s*context\b/i,
	/\b(?:input\s*)?tokens?\s+exceeds?\b/i,
	/\btoo\s*many\s*tokens?\b/i,
	/\binput\s+is\s+too\s+long\b/i,
	/\bprompt\s+is\s+too\s+long\b/i,
	/reduce\s+the\s+length\s+of\s+the\s+messages\s+or\s+completion/i,
	/requested\s+input\s+length\s+.*exceeds\s+.*maximum/i,
];

/**
 * Signals that the request failed for throughput/quota reasons rather than
 * size. Token-per-minute limit messages also talk about tokens being
 * "exceeded", so these veto a context-window match.
 */
const RATE_LIMIT_PATTERNS = [/rate[\s_-]?limit/i, /per[\s_-]?minute\b/i];

/** Overflow rejections arrive as invalid-request-family statuses. */
const CONTEXT_WINDOW_STATUSES = new Set([400, 413, 422]);
const RATE_LIMIT_STATUS = 429;

const MAX_WALK_DEPTH = 8;

/**
 * Object keys whose values carry further error detail — human-readable text
 * (message/detail/error_message; strings are recorded by the string branch)
 * or nested error structures the providers and gateways wrap around them.
 */
const DETAIL_KEYS = [
	"message",
	"detail",
	"error_message",
	"error",
	"errors",
	"cause",
	"responseBody",
	"data",
	"value",
	"param",
] as const;

/** Object keys that may carry an HTTP status. */
const STATUS_KEYS = ["status", "statusCode", "code"] as const;

interface ErrorSignals {
	messages: string[];
	statuses: Set<number>;
	codes: Set<string>;
}

function recordStatus(signals: ErrorSignals, value: unknown): void {
	const numeric =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\d{3}$/.test(value.trim())
				? Number(value.trim())
				: undefined;
	if (numeric !== undefined && numeric >= 100 && numeric <= 599) {
		signals.statuses.add(numeric);
	}
}

function collectSignals(
	value: unknown,
	signals: ErrorSignals,
	visited: Set<unknown>,
	depth: number,
): void {
	if (value == null || depth > MAX_WALK_DEPTH) {
		return;
	}
	if (typeof value === "string") {
		const text = value.trim();
		if (!text) {
			return;
		}
		signals.messages.push(text);
		// Providers and gateways JSON-encode upstream rejections into message
		// strings (OpenRouter mid-stream errors, Vercel `value.error_message`);
		// parse so embedded status/code fields become structured signals.
		const parsed = safeJsonParse<unknown>(text);
		if (parsed !== undefined && typeof parsed === "object") {
			collectSignals(parsed, signals, visited, depth + 1);
		} else {
			// Not full JSON — still mine embedded `"code": 400` / `"status": 400`.
			const embedded = text.match(/"(?:code|status)"\s*:\s*"?(\d{3})"?/);
			if (embedded) {
				recordStatus(signals, embedded[1]);
			}
		}
		return;
	}
	if (typeof value !== "object") {
		return;
	}
	if (visited.has(value)) {
		return;
	}
	visited.add(value);

	if (Array.isArray(value)) {
		for (const item of value) {
			collectSignals(item, signals, visited, depth + 1);
		}
		return;
	}

	const record = value as Record<string, unknown>;
	for (const key of STATUS_KEYS) {
		recordStatus(signals, record[key]);
	}
	for (const key of ["code", "type", "name"]) {
		const candidate = record[key];
		if (typeof candidate === "string" && candidate.trim()) {
			signals.codes.add(candidate.trim());
		}
	}
	for (const key of DETAIL_KEYS) {
		const nested = record[key];
		if (
			nested !== undefined &&
			nested !== value &&
			typeof nested !== "number"
		) {
			collectSignals(nested, signals, visited, depth + 1);
		}
	}
}

/**
 * Apply the detection rules to collected signals. Shared between the typed
 * AI SDK pre-pass and the structural walk so both paths classify identically:
 * a context-window verdict requires an overflow message pattern (or explicit
 * provider code), no rate-limit signal, and — when any HTTP status is
 * visible — an invalid-request-family status.
 */
/**
 * Message shapes providers use when a request carried an image the model
 * cannot accept.
 *
 * Measured: a tester ran DeepSeek on Ollama Cloud, the `browser` tool attached
 * a screenshot, and the session ended on "this model does not support image
 * input". The tool guards on `modelSupportsImages`, but that flag defaults to
 * true when a model carries no declared capabilities — which is every model
 * outside the shipped catalog, including the local ones this fork is used
 * with. Tightening the default would fix the cloud model and silently disable
 * screenshots for the local ones, so the provider's own refusal is the signal
 * to act on.
 *
 * Deliberately narrow: these must never swallow a generic 400. Each names both
 * an image noun and a refusal, so an error merely mentioning an image cannot
 * match.
 */
const IMAGE_UNSUPPORTED_PATTERNS = [
	/\b(?:does\s*not|doesn'?t|cannot|can'?t)\s+support\s+(?:image|vision|multimodal)/i,
	/\b(?:image|vision)\s+(?:input|content)?\s*(?:is\s+)?not\s+supported\b/i,
	/\bmodel\s+(?:is\s+)?not\s+(?:a\s+)?(?:vision|multimodal)\b/i,
	/\bno\s+support\s+for\s+(?:image|vision)/i,
	/\bunsupported\s+(?:content\s+)?type\b.*\bimage\b/i,
];

/**
 * Message shapes providers use when a tool call the model emitted would not
 * parse.
 *
 * Measured: a transaction that had already got a broken file past its syntax
 * error died at 3,449 seconds of a 7,200-second budget on
 *
 *     XML syntax error on line 12: element <parameter> closed by </function>
 *
 * — Go's `encoding/xml`, refusing a call inside Ollama's Qwen tool-call
 * parser. It classified as `unknown`, nothing recovered it, and an hour of
 * clock went unused on a run that was winning. The model had just written out
 * in prose the edit it meant to make; only the call around it was malformed.
 *
 * Narrow on purpose, and narrower than the error text alone would need to be.
 * Each pattern has to name a parse failure *and* something from the tool-call
 * vocabulary — `function`, `tool_call`, `parameter`, `arguments` — so a
 * provider's generic complaint about the request body can never be read as
 * the model's own output being malformed.
 */
const TOOL_CALL_UNPARSABLE_PATTERNS = [
	/\bXML syntax error\b[\s\S]*<\/?(?:function|tool_call|parameter|invoke)\b/i,
	/\b(?:failed to|could not|cannot|unable to)\s+parse\b[\s\S]{0,80}\b(?:tool[_\s-]?call|function[_\s-]?call|tool arguments|function arguments)\b/i,
	/\b(?:invalid|malformed)\s+(?:tool[_\s-]?call|function[_\s-]?call|tool arguments|function arguments)\b/i,
];

function verdictFromSignals(signals: ErrorSignals): ProviderErrorClass {
	// First, and for the same reason as the image check that follows it: this
	// is a property of what the model emitted, not of the request's HTTP shape,
	// and providers return it under assorted codes or none at all.
	if (
		signals.messages.some((message) =>
			TOOL_CALL_UNPARSABLE_PATTERNS.some((pattern) => pattern.test(message)),
		)
	) {
		return "tool_call_unparsable";
	}

	// Checked before the rate-limit and status gates below: a refusal to accept
	// an image is a property of the request's content, not of its HTTP shape,
	// and providers return it under assorted 4xx codes.
	if (
		signals.messages.some((message) =>
			IMAGE_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(message)),
		)
	) {
		return "image_input_unsupported";
	}

	if ([...signals.codes].some((code) => CONTEXT_WINDOW_CODES.has(code))) {
		return "context_window_exceeded";
	}

	if (signals.statuses.has(RATE_LIMIT_STATUS)) {
		return "unknown";
	}
	if (
		signals.messages.some((message) =>
			RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message)),
		)
	) {
		return "unknown";
	}
	if (
		signals.statuses.size > 0 &&
		![...signals.statuses].some((status) => CONTEXT_WINDOW_STATUSES.has(status))
	) {
		return "unknown";
	}
	if (
		signals.messages.some((message) =>
			CONTEXT_WINDOW_PATTERNS.some((pattern) => pattern.test(message)),
		)
	) {
		return "context_window_exceeded";
	}
	return "unknown";
}

function collectSignalsFrom(values: readonly unknown[]): ErrorSignals {
	const signals: ErrorSignals = {
		messages: [],
		statuses: new Set(),
		codes: new Set(),
	};
	const visited = new Set<unknown>();
	for (const value of values) {
		collectSignals(value, signals, visited, 0);
	}
	return signals;
}

/**
 * Classify errors that are real AI SDK error instances, using their typed
 * fields instead of guessing at shape. Returns `undefined` when the error is
 * not a recognized instance (or a typed wrapper leads nowhere), so the caller
 * falls back to the structural walk.
 *
 * `isInstance()` is the AI SDK's symbol-based guard, so it holds across
 * duplicated package copies — but it can never match gateway-forwarded plain
 * JSON payloads that merely *name* an AI SDK error (ENG-2394); those stay the
 * structural walk's job.
 */
function classifyTypedError(
	error: unknown,
	depth: number,
): ProviderErrorClass | undefined {
	if (depth > MAX_WALK_DEPTH) {
		return undefined;
	}
	// Specific classes before the generic guard — every AI SDK error
	// subclasses AISDKError, so the generic check would swallow them.
	if (RetryError.isInstance(error)) {
		// Only the final attempt decides the verdict: earlier attempts were
		// retried away (typically rate limits) and must neither veto nor fake
		// its classification — so an untyped final error is walked alone
		// rather than falling back to the whole wrapper's `errors` array.
		const last = error.lastError ?? error.errors[error.errors.length - 1];
		if (last == null) {
			return undefined;
		}
		return (
			classifyTypedError(last, depth + 1) ??
			verdictFromSignals(collectSignalsFrom([last]))
		);
	}
	if (APICallError.isInstance(error)) {
		// The typed statusCode is the sole authoritative status and gates the
		// whole verdict: nothing in the payload — not even an explicit
		// overflow code echoed inside a rate-limit or server-failure body —
		// out-votes the HTTP layer. Absent a statusCode, the payload decides.
		const status =
			typeof error.statusCode === "number" ? error.statusCode : undefined;
		if (status !== undefined && !CONTEXT_WINDOW_STATUSES.has(status)) {
			return "unknown";
		}
		const signals = collectSignalsFrom([
			error.message,
			error.responseBody,
			error.data,
		]);
		signals.statuses = new Set(status !== undefined ? [status] : []);
		return verdictFromSignals(signals);
	}
	if (TypeValidationError.isInstance(error)) {
		// `value` holds the payload that failed validation — for gateway
		// streams, the upstream provider rejection.
		const verdict = verdictFromSignals(collectSignalsFrom([error.value]));
		return verdict === "context_window_exceeded" ? verdict : undefined;
	}
	if (AISDKError.isInstance(error)) {
		const verdict = classifyTypedError(error.cause, depth + 1);
		return verdict === "context_window_exceeded" ? verdict : undefined;
	}
	return undefined;
}

/**
 * Classify a raw provider error (or an already-flattened error message) into
 * a {@link ProviderErrorClass}. Call this where the structured error object
 * is still available — `extractErrorMessage` discards the structure this
 * classification relies on.
 *
 * Typed AI SDK error instances are classified first via their typed fields;
 * everything else — including plain JSON payloads that only *look* like AI
 * SDK errors — goes through the conservative structural walk.
 */
export function classifyProviderError(error: unknown): ProviderErrorClass {
	try {
		const typed = classifyTypedError(error, 0);
		if (typed !== undefined) {
			return typed;
		}
	} catch {
		// Fall through to the structural walk.
	}

	const signals: ErrorSignals = {
		messages: [],
		statuses: new Set(),
		codes: new Set(),
	};
	try {
		collectSignals(error, signals, new Set(), 0);
	} catch {
		return "unknown";
	}
	return verdictFromSignals(signals);
}

import {
	KV_EVICTED_ERROR_KIND,
	type ProviderErrorClass,
	safeJsonParse,
	type ToolCallRejection,
} from "@cline/shared";
import { AISDKError, APICallError, RetryError, TypeValidationError } from "ai";
import { isOpencotiWindowUnavailableError } from "./vendors/opencoti-window";

/**
 * Provider codes that unambiguously identify a context-window overflow
 * (OpenAI-family `error.code`).
 */
const CONTEXT_WINDOW_CODES = new Set([
	"context_length_exceeded",
	// opencoti/llama.cpp name it in the error `type` rather than a `code`, and
	// its message says "context size", which none of the patterns below match.
	"exceed_context_size_error",
]);

/**
 * A pool fork whose declared prefix does not line up with its parent.
 *
 * Arrives as a `400 invalid_request_error`, which is indistinguishable by
 * status from a malformed request, so the message is what separates them.
 *
 * All six of the engine's fork rejections, and only two of them name the
 * contract -- the rest describe the same broken relationship in their own
 * words. Keying on the phrase alone missed four, including the one a
 * suffix-shaped fork actually produces, measured against the c7 binary:
 * `child prefix shorter than branch_pos`. Every one of them means "re-create
 * the pool and carry on", never "fail the turn", so missing one costs a turn
 * for a condition that is recoverable.
 */
const POOL_CONTRACT_PATTERNS: readonly RegExp[] = [
	/contiguous-prefix contract violation/i,
	/branch_pos exceeds parent prefix_len/i,
	/(?:child prefix|session context) shorter than branch_pos/i,
	/fork must extend at branch_pos/i,
];

function isPoolContractMessage(message: string): boolean {
	return POOL_CONTRACT_PATTERNS.some((pattern) => pattern.test(message));
}

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
	// opencoti / llama.cpp, verbatim from `server-context.cpp:9184-9200`. Both
	// say "context size", which the first pattern above does not cover, and the
	// token counts sit in parentheses so `tokens exceeds` does not match either.
	/\bmax(?:imum)?\s+context\s+size\b/i,
	/\bexceeds?\s+the\s+available\s+context\s+size\b/i,
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
/**
 * Credential rejections. Status-only on purpose: matching message text
 * ("unauthorized", "forbidden") would misfire on provider bodies that merely
 * quote such words, and every provider that rejects credentials does say so
 * in the HTTP layer.
 */
const AUTH_STATUSES = new Set([401, 403]);

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
	// `error_kind` is opencoti's machine-readable kind, beside `message` in
	// the error object (`kv_observable_v1`): the eviction names itself there.
	for (const key of ["code", "type", "name", "error_kind"]) {
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
	// llama.cpp's streaming tool-call parser (common/chat.cpp) throws this when
	// a partial re-parse finds fewer calls than the last one did, and the server
	// ends the stream on it. Measured on the 75-agent swarm on pandorum: 16
	// workers lost to it, every one mid-way through a long `editor` payload of
	// minified JS. The call was never delivered, so asking for it again is the
	// same recovery as any other call the parser could not read.
	/\bInvalid diff:\s*now finding less tool calls\b/i,
];

/**
 * The error `type` opencoti gives a tool call it rejected (bug-3601). It comes
 * with the same message as before, so older builds are still caught by the
 * `Invalid diff` pattern above. Newer ones also carry a `reason`, read by
 * {@link extractToolCallRejection}.
 */
const TOOL_CALL_REJECTED_TYPE = "tool_call_rejected";

function isToolCallUnparsable(signals: ErrorSignals): boolean {
	return (
		signals.codes.has(TOOL_CALL_REJECTED_TYPE) ||
		signals.messages.some((message) =>
			TOOL_CALL_UNPARSABLE_PATTERNS.some((pattern) => pattern.test(message)),
		)
	);
}

/**
 * The engine evicted the request's sequence to keep its batch alive. Named by
 * `error_kind` alone: the message says "Context size has been exceeded",
 * which is not this request's window, and the status is a bare 500.
 */
function isKvEvicted(signals: ErrorSignals): boolean {
	return signals.codes.has(KV_EVICTED_ERROR_KIND);
}

function verdictFromSignals(signals: ErrorSignals): ProviderErrorClass {
	// Ahead of everything: the eviction's text talks about a context size, and
	// it must never read as this request's own overflow (opencoti mail #311).
	if (isKvEvicted(signals)) {
		return "kv_evicted";
	}
	// First, and for the same reason as the image check that follows it: this
	// is a property of what the model emitted, not of the request's HTTP shape,
	// and providers return it under assorted codes or none at all.
	if (isToolCallUnparsable(signals)) {
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

	// Before the status gates: a pool-contract refusal is a 400, the same status
	// a malformed request carries, and only the message tells them apart.
	if (signals.messages.some((message) => isPoolContractMessage(message))) {
		return "pool_contract_violation";
	}

	if ([...signals.statuses].some((status) => AUTH_STATUSES.has(status))) {
		return "auth";
	}

	// The status, never the body. On opencoti c7 -- the published release -- an
	// admission refusal is a 429 whose body says `503`/`unavailable_error`, so a
	// classifier that reads the body mis-reads every refusal on the binary that
	// is actually deployed. c8 makes the two agree; this stays correct on both.
	if (signals.statuses.has(RATE_LIMIT_STATUS)) {
		return "rate_limited";
	}
	if (
		signals.messages.some((message) =>
			RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message)),
		)
	) {
		return "rate_limited";
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
	// opencoti could not give the conversation a window it can use. Neither
	// retryable (it has had its one wait, or is a resume that never waits) nor
	// an overflow (compacting cannot conjure cells on the server), so it must
	// not reach a verdict that does either. A delegated agent's turn-fault
	// recovery still waits it out as a refusal (`classifyTurnFault` in
	// @cline/shared reads its tail code): an agent retries infra, never fails.
	if (depth === 0 && isOpencotiWindowUnavailableError(error)) {
		return "unknown";
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
		if (status !== undefined && AUTH_STATUSES.has(status)) {
			return "auth";
		}
		const signals = collectSignalsFrom([
			error.message,
			error.responseBody,
			error.data,
		]);
		// Ahead of the status gate: opencoti rejects a tool call with a 500,
		// and a 500 is otherwise "unknown". What the model emitted is the
		// fault whatever the status says -- see `verdictFromSignals`.
		if (isToolCallUnparsable(signals)) {
			return "tool_call_unparsable";
		}
		// The eviction is a 500 too, and only its `error_kind` says so.
		if (isKvEvicted(signals)) {
			return "kv_evicted";
		}
		if (status !== undefined && !CONTEXT_WINDOW_STATUSES.has(status)) {
			return "unknown";
		}
		signals.statuses = new Set(status !== undefined ? [status] : []);
		return verdictFromSignals(signals);
	}
	if (TypeValidationError.isInstance(error)) {
		// `value` holds the payload that failed validation — for gateway
		// streams, the upstream provider rejection. Only a definitive verdict
		// counts; "unknown" defers to the caller's structural walk.
		const verdict = verdictFromSignals(collectSignalsFrom([error.value]));
		return verdict !== "unknown" ? verdict : undefined;
	}
	if (AISDKError.isInstance(error)) {
		const verdict = classifyTypedError(error.cause, depth + 1);
		return verdict !== undefined && verdict !== "unknown" ? verdict : undefined;
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

/**
 * The engine's account of a tool call it rejected, if the error carries one.
 *
 * Looks for opencoti's `{type: "tool_call_rejected", reason, key?, tool?}`
 * anywhere in the error: on the object itself, under `error`, in an HTTP
 * response body, or JSON-encoded in a message string (a streamed SSE `error`
 * event arrives that way). `undefined` when there is none. The rejection is
 * still classified from its message; only the specific wording is lost.
 */
export function extractToolCallRejection(
	error: unknown,
): ToolCallRejection | undefined {
	return findToolCallRejection(error, new Set(), 0);
}

function findToolCallRejection(
	value: unknown,
	visited: Set<unknown>,
	depth: number,
): ToolCallRejection | undefined {
	if (value == null || depth > MAX_WALK_DEPTH) {
		return undefined;
	}
	if (typeof value === "string") {
		const parsed = safeJsonParse<unknown>(value.trim());
		return parsed !== undefined && typeof parsed === "object"
			? findToolCallRejection(parsed, visited, depth + 1)
			: undefined;
	}
	if (typeof value !== "object" || visited.has(value)) {
		return undefined;
	}
	visited.add(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findToolCallRejection(item, visited, depth + 1);
			if (found) {
				return found;
			}
		}
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (
		record.type === TOOL_CALL_REJECTED_TYPE &&
		typeof record.reason === "string" &&
		record.reason.trim()
	) {
		return {
			reason: record.reason.trim(),
			...(typeof record.key === "string" && record.key.trim()
				? { key: record.key.trim() }
				: {}),
			...(typeof record.tool === "string" && record.tool.trim()
				? { tool: record.tool.trim() }
				: {}),
		};
	}
	for (const key of [
		"error",
		"data",
		"responseBody",
		"cause",
		"lastError",
		"value",
		"message",
	]) {
		const found = findToolCallRejection(record[key], visited, depth + 1);
		if (found) {
			return found;
		}
	}
	return undefined;
}

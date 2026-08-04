export type TelemetryPrimitive = string | number | boolean | null | undefined;

export type TelemetryValue =
	| TelemetryPrimitive
	| TelemetryObject
	| TelemetryArray;

export type TelemetryObject = { [key: string]: TelemetryValue };

export type TelemetryArray = Array<TelemetryValue>;

export type TelemetryProperties = TelemetryObject;

const DEFAULT_ERROR_MESSAGE_LIMIT = 500;

export type SdkTelemetryErrorComponent =
	| "shared"
	| "llms"
	| "agents"
	| "core"
	| "cli"
	| "vscode"
	| "desktop"
	| (string & {});

export type SdkTelemetryErrorSeverity =
	| "debug"
	| "info"
	| "warn"
	| "error"
	| "fatal";

export interface CaptureSdkErrorInput {
	component: SdkTelemetryErrorComponent;
	operation: string;
	error: unknown;
	/**
	 * A useful message derived while the caller still has domain-specific error
	 * context. The raw error remains the source of type, code, and status.
	 */
	errorMessage?: string;
	severity?: SdkTelemetryErrorSeverity;
	handled?: boolean;
	context?: TelemetryProperties;
	event?: string;
	messageLimit?: number;
}

export const AGENT_UNEXPECTED_REASONING_TOKENS_EVENT =
	"agent.reasoning.unexpected_tokens";

export interface CaptureAgentUnexpectedReasoningTokensInput {
	sessionId?: string;
	agentId: string;
	runId?: string;
	iteration: number;
	providerId?: string;
	modelId?: string;
	requestedThinking: false;
	reasoningTokenCount: number;
}

export const TASK_PROVIDER_REQUEST_STARTED_EVENT =
	"task.provider_request_started";
export const TASK_PROVIDER_STREAM_STARTED_EVENT =
	"task.provider_stream_started";
export const TASK_FIRST_CHUNK_RECEIVED_EVENT = "task.first_chunk_received";
export const TASK_PROVIDER_STREAM_FAILED_EVENT = "task.provider_stream_failed";
export const TASK_CANCELLED_EVENT = "task.cancelled";

export interface CaptureTaskLifecycleEventInput {
	event: string;
	sessionId?: string;
	ulid?: string;
	agentId?: string;
	conversationId?: string;
	runId?: string;
	iteration?: number;
	providerId?: string;
	modelId?: string;
	phase?: string;
	durationMs?: number;
	eventType?: string;
	error?: unknown;
	/**
	 * Classification of `error` (e.g. context_window_exceeded), emitted as
	 * `error_class` alongside the normalized error fields.
	 */
	errorClass?: string;
	messageLimit?: number;
}

export interface TelemetryMetadata {
	extension_version: string;
	/**
	 * The version of the host-side Cline distribution package: the JetBrains plugin version
	 * (e.g. 1.1.61) on JetBrains, the extension version on VSCode (where it matches
	 * `extension_version`). Absent when the host does not report one.
	 */
	host_plugin_version?: string;
	cline_type: string;
	platform: string;
	platform_version: string;
	os_type: string;
	os_version: string;
	is_dev?: string;
	is_remote_workspace?: boolean;
}

export interface ITelemetryService {
	setDistinctId(distinctId?: string): void;
	setMetadata(metadata: Partial<TelemetryMetadata>): void;
	updateMetadata(metadata: Partial<TelemetryMetadata>): void;
	setCommonProperties(properties: TelemetryProperties): void;
	updateCommonProperties(properties: TelemetryProperties): void;
	isEnabled(): boolean;
	capture(input: { event: string; properties?: TelemetryProperties }): void;
	captureRequired(event: string, properties?: TelemetryProperties): void;
	recordCounter(
		name: string,
		value: number,
		attributes?: TelemetryProperties,
		description?: string,
		required?: boolean,
	): void;
	recordHistogram(
		name: string,
		value: number,
		attributes?: TelemetryProperties,
		description?: string,
		required?: boolean,
	): void;
	recordGauge(
		name: string,
		value: number | null,
		attributes?: TelemetryProperties,
		description?: string,
		required?: boolean,
	): void;
	flush(): Promise<void>;
	dispose(): Promise<void>;
}

export const SDK_ERROR_TELEMETRY_EVENT = "sdk.error";

// =============================================================================
// Cross-layer de-duplication for `sdk.error`
// =============================================================================
//
// One underlying failure must produce (at most) one `sdk.error` event. The
// canonical reporter is the INNERMOST layer — the first `captureSdkError`
// call that sees the failure, because it still holds the richest context
// (provider id, model id, raw error structure). Outer layers that catch the
// same error as it propagates (agents `agent.run`, core `session.turn`, ...)
// must skip it instead of re-reporting it verbatim.
//
// Mechanism: `captureSdkError` tags the error object with a non-enumerable
// symbol once it takes ownership of reporting it. Errors are often wrapped
// or rethrown as new instances between layers, so the reported check walks
// the `cause` chain. Where a boundary flattens the error to a plain string
// (e.g. the model stream's `finish` event), the boundary carries an explicit
// "already reported" bit instead and the outer layer re-tags its
// reconstructed `Error` (see `errorReported` on the model `finish` event).

/**
 * Non-enumerable marker set on error objects whose failure has already been
 * recorded by {@link captureSdkError}. Registered via `Symbol.for` so the tag
 * survives multiple bundled copies of `@cline/shared` in one process.
 */
export const SDK_ERROR_REPORTED = Symbol.for("cline.sdkErrorReported");

/** Fallback for error objects that cannot accept new properties (frozen). */
const reportedSdkErrors = new WeakSet<object>();

const SDK_ERROR_CAUSE_CHAIN_LIMIT = 16;

/**
 * Tag an error as already reported to `sdk.error` telemetry so outer layers
 * skip it. Safe on any value; non-object errors cannot be tagged and are
 * ignored. Never throws.
 */
export function markSdkErrorReported(error: unknown): void {
	if (typeof error !== "object" || error === null) {
		return;
	}
	try {
		Object.defineProperty(error, SDK_ERROR_REPORTED, {
			value: true,
			enumerable: false,
			configurable: true,
			writable: false,
		});
	} catch {
		try {
			reportedSdkErrors.add(error);
		} catch {
			// Non-taggable value; dedup falls back to rate limiting only.
		}
	}
}

/**
 * Whether this error — or any error in its `cause` chain — was already
 * reported to `sdk.error` telemetry. Cycle-safe and never throws.
 */
export function isSdkErrorReported(error: unknown): boolean {
	try {
		let current: unknown = error;
		const seen = new Set<unknown>();
		for (let depth = 0; depth < SDK_ERROR_CAUSE_CHAIN_LIMIT; depth++) {
			if (typeof current !== "object" || current === null) {
				return false;
			}
			if (seen.has(current)) {
				return false;
			}
			seen.add(current);
			if (
				(current as Record<PropertyKey, unknown>)[SDK_ERROR_REPORTED] ===
					true ||
				reportedSdkErrors.has(current)
			) {
				return true;
			}
			current = (current as { cause?: unknown }).cause;
		}
	} catch {
		// Exotic error objects (throwing getters/proxies) are treated as
		// unreported; the rate limiter still bounds their volume.
	}
	return false;
}

// =============================================================================
// Per-process rate limiting for `sdk.error`
// =============================================================================

/** Identical errors allowed per key per window before suppression starts. */
export const SDK_ERROR_RATE_LIMIT_MAX_PER_WINDOW = 5;
/** Fixed suppression window. */
export const SDK_ERROR_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
/** Bound on distinct error keys tracked in memory (oldest evicted first). */
const SDK_ERROR_RATE_LIMIT_MAX_TRACKED_KEYS = 512;

interface SdkErrorRateLimitEntry {
	windowStartMs: number;
	emittedInWindow: number;
	suppressedInWindow: number;
}

export interface SdkErrorRateLimitDecision {
	/** Whether the event may be emitted. */
	allowed: boolean;
	/**
	 * When `allowed`, the number of identical events suppressed since the
	 * previous allowed emission (attached to the event as
	 * `suppressed_count`). Zero when nothing was suppressed.
	 */
	suppressedCount: number;
}

/**
 * In-memory, per-process cap on identical `sdk.error` events. Keys on
 * `(event, component, operation, error_type, normalized message)` and allows
 * {@link SDK_ERROR_RATE_LIMIT_MAX_PER_WINDOW} events per key per
 * {@link SDK_ERROR_RATE_LIMIT_WINDOW_MS}. Once a key's window resets, the
 * next allowed emission carries a `suppressed_count` summarizing what was
 * dropped, so a hot retry loop stays visible (dozens of events per day)
 * without flooding (thousands). No disk state; `admit` never throws.
 */
export class SdkErrorRateLimiter {
	private readonly entries = new Map<string, SdkErrorRateLimitEntry>();

	constructor(
		private readonly options: {
			maxPerWindow?: number;
			windowMs?: number;
			maxTrackedKeys?: number;
			now?: () => number;
		} = {},
	) {}

	admit(key: string): SdkErrorRateLimitDecision {
		try {
			const now = (this.options.now ?? Date.now)();
			const windowMs = this.options.windowMs ?? SDK_ERROR_RATE_LIMIT_WINDOW_MS;
			const maxPerWindow =
				this.options.maxPerWindow ?? SDK_ERROR_RATE_LIMIT_MAX_PER_WINDOW;
			const entry = this.entries.get(key);
			if (entry && now - entry.windowStartMs < windowMs) {
				if (entry.emittedInWindow < maxPerWindow) {
					entry.emittedInWindow += 1;
					return { allowed: true, suppressedCount: 0 };
				}
				entry.suppressedInWindow += 1;
				return { allowed: false, suppressedCount: entry.suppressedInWindow };
			}
			// New key, or the window elapsed: emit, carrying forward the count
			// of events suppressed in the previous window.
			const carriedSuppressed = entry?.suppressedInWindow ?? 0;
			this.entries.delete(key);
			this.evictOldestBeyond(
				(this.options.maxTrackedKeys ?? SDK_ERROR_RATE_LIMIT_MAX_TRACKED_KEYS) -
					1,
			);
			this.entries.set(key, {
				windowStartMs: now,
				emittedInWindow: 1,
				suppressedInWindow: 0,
			});
			return { allowed: true, suppressedCount: carriedSuppressed };
		} catch {
			return { allowed: true, suppressedCount: 0 };
		}
	}

	reset(): void {
		this.entries.clear();
	}

	private evictOldestBeyond(maxKeys: number): void {
		while (this.entries.size > Math.max(0, maxKeys)) {
			const oldest = this.entries.keys().next();
			if (oldest.done) {
				return;
			}
			this.entries.delete(oldest.value);
		}
	}
}

const defaultSdkErrorRateLimiter = new SdkErrorRateLimiter();

/** Clear the process-wide `sdk.error` rate-limiter state (test isolation). */
export function resetSdkErrorRateLimiterForTests(): void {
	defaultSdkErrorRateLimiter.reset();
}

/**
 * Build the rate-limit key for an `sdk.error` emission. The message is
 * normalized (digit runs collapsed, whitespace folded, case-insensitive,
 * bounded) so retry loops whose messages differ only by counters or ids
 * still coalesce into one key.
 */
export function sdkErrorRateLimitKey(
	event: string,
	properties: TelemetryProperties,
): string {
	const message =
		typeof properties.error_message === "string"
			? properties.error_message
			: "";
	return [
		event,
		String(properties.component ?? ""),
		String(properties.operation ?? ""),
		String(properties.error_type ?? ""),
		normalizeSdkErrorMessageForRateLimitKey(message),
	].join("\u0000");
}

function normalizeSdkErrorMessageForRateLimitKey(message: string): string {
	return message
		.replace(/\d+/g, "#")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase()
		.slice(0, 256);
}

export function captureAgentUnexpectedReasoningTokens(
	telemetry: ITelemetryService | undefined,
	input: CaptureAgentUnexpectedReasoningTokensInput,
): void {
	telemetry?.capture({
		event: AGENT_UNEXPECTED_REASONING_TOKENS_EVENT,
		properties: stripUndefinedTelemetryProperties({
			sessionId: input.sessionId,
			agentId: input.agentId,
			runId: input.runId,
			iteration: input.iteration,
			providerId: input.providerId,
			modelId: input.modelId,
			requestedThinking: input.requestedThinking,
			reasoningTokenCount: input.reasoningTokenCount,
		}),
	});
}

export function captureTaskLifecycleEvent(
	telemetry: ITelemetryService | undefined,
	input: CaptureTaskLifecycleEventInput,
): void {
	if (!telemetry) {
		return;
	}
	telemetry.capture({
		event: input.event,
		properties: stripUndefinedTelemetryProperties({
			sessionId: input.sessionId,
			ulid: input.ulid ?? input.sessionId,
			agentId: input.agentId,
			conversationId: input.conversationId,
			runId: input.runId,
			iteration: input.iteration,
			provider: input.providerId,
			providerId: input.providerId,
			model: input.modelId,
			modelId: input.modelId,
			phase: input.phase,
			durationMs: input.durationMs,
			eventType: input.eventType,
			...(input.error === undefined
				? {}
				: normalizeSdkError(input.error, input.messageLimit)),
			error_class: input.errorClass,
		}),
	});
}

/**
 * Report an SDK error, at most once per underlying failure and with a
 * per-process cap on identical failures.
 *
 * - Cross-layer dedup: if `input.error` (or anything in its `cause` chain)
 *   was already reported, the call is a no-op — the innermost reporter is
 *   canonical (see the {@link SDK_ERROR_REPORTED} policy note). Otherwise
 *   the error object is tagged so outer layers skip it.
 * - Rate limiting: identical failures (same event/component/operation/
 *   error type/normalized message) are capped per process per hour; the
 *   first allowed emission after suppression carries `suppressed_count`.
 *
 * Returns `true` when the failure is recorded in `sdk.error` telemetry —
 * by this call (even if rate-limit-suppressed) or a previous one — and
 * `false` when telemetry is unavailable. Never throws.
 */
export function captureSdkError(
	telemetry: ITelemetryService | undefined,
	input: CaptureSdkErrorInput,
): boolean {
	if (!telemetry) {
		return false;
	}
	if (isSdkErrorReported(input.error)) {
		return true;
	}
	markSdkErrorReported(input.error);
	const event = input.event ?? SDK_ERROR_TELEMETRY_EVENT;
	const properties = buildSdkErrorProperties(input);
	const decision = defaultSdkErrorRateLimiter.admit(
		sdkErrorRateLimitKey(event, properties),
	);
	if (!decision.allowed) {
		return true;
	}
	telemetry.capture({
		event,
		properties:
			decision.suppressedCount > 0
				? { ...properties, suppressed_count: decision.suppressedCount }
				: properties,
	});
	return true;
}

export function buildSdkErrorProperties(
	input: CaptureSdkErrorInput,
): TelemetryProperties {
	return {
		...(input.context ?? {}),
		component: input.component,
		operation: input.operation,
		severity: input.severity ?? "error",
		handled: input.handled ?? true,
		...normalizeSdkError(input.error, input.messageLimit, input.errorMessage),
	};
}

function stripUndefinedTelemetryProperties(
	properties: TelemetryProperties,
): TelemetryProperties {
	const result: TelemetryProperties = {};
	for (const [key, value] of Object.entries(properties)) {
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}

export function normalizeSdkError(
	error: unknown,
	messageLimit = DEFAULT_ERROR_MESSAGE_LIMIT,
	errorMessage?: string,
): TelemetryProperties {
	const record = isRecord(error) ? error : undefined;
	const errorObject = error instanceof Error ? error : undefined;
	const message =
		stringValue(errorMessage) ??
		stringValue(errorObject?.message) ??
		stringValue(record?.message) ??
		fallbackErrorString(error) ??
		"Unknown error";
	const code = stringOrNumberValue(record?.code);
	const status =
		numberValue(record?.status) ??
		numberValue(record?.statusCode) ??
		numberValue(record?.responseStatus);

	return {
		error_type:
			errorObject?.name?.trim() ||
			stringValue(record?.name) ||
			errorObject?.constructor?.name ||
			"Error",
		error_message: truncateTelemetryString(
			sanitizeTelemetryErrorMessage(message),
			messageLimit,
		),
		...(code !== undefined ? { error_code: code } : {}),
		...(status !== undefined ? { error_status: status } : {}),
	};
}

function sanitizeTelemetryErrorMessage(message: string): string {
	return message
		.replace(/(authorization=Bearer\s+)[^&\s]+/gi, "$1[redacted]")
		.replace(
			/(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)=([^&\s]+)/gi,
			"$1=[redacted]",
		)
		.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]")
		.replace(/\/Users\/[^/\s]+/g, "/Users/[redacted]")
		.replace(/\/home\/[^/\s]+/g, "/home/[redacted]")
		.replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s]+/g, "$1[redacted]");
}

function truncateTelemetryString(value: string, limit: number): string {
	const normalizedLimit = Math.max(1, Math.floor(limit));
	return value.length > normalizedLimit
		? value.substring(0, normalizedLimit)
		: value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

function fallbackErrorString(error: unknown): string | undefined {
	if (error instanceof Error) {
		return undefined;
	}
	const value = typeof error === "string" ? error : String(error);
	return value === "[object Object]" ? undefined : stringValue(value);
}

function stringOrNumberValue(value: unknown): string | number | undefined {
	if (typeof value === "string" && value.trim().length > 0) {
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	return undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

export interface OpenTelemetryClientConfig {
	/**
	 * Whether telemetry is enabled via OTEL_TELEMETRY_ENABLED
	 */
	enabled: boolean;

	/**
	 * Metrics exporter type(s) - can be comma-separated for multiple exporters
	 * Examples: "console", "otlp", "console,otlp"
	 */
	metricsExporter?: string;

	/**
	 * Logs/events exporter type(s) - can be comma-separated for multiple exporters
	 * Examples: "console", "otlp"
	 */
	logsExporter?: string;

	/**
	 * Distributed tracing exporter type(s) - comma-separated for multiple exporters.
	 * Examples: "console", "otlp". When unset, no `TracerProvider` is registered.
	 */
	tracesExporter?: string;

	/**
	 * Protocol for OTLP exporters. SDK support is currently limited to "http/json".
	 */
	otlpProtocol?: string;

	/**
	 * General OTLP endpoint (used if specific endpoints not set)
	 */
	otlpEndpoint?: string;

	/**
	 * General OTLP headers
	 */
	otlpHeaders?: Record<string, string>;

	/**
	 * Metrics-specific OTLP protocol
	 */
	otlpMetricsProtocol?: string;

	/**
	 * Metrics-specific OTLP endpoint
	 */
	otlpMetricsEndpoint?: string;

	otlpMetricsHeaders?: Record<string, string>;

	/**
	 * Logs-specific OTLP protocol
	 */
	otlpLogsProtocol?: string;

	/**
	 * Logs-specific OTLP endpoint
	 */
	otlpLogsEndpoint?: string;

	otlpLogsHeaders?: Record<string, string>;

	/**
	 * Traces-specific OTLP protocol (SDK support is currently limited to "http/json")
	 */
	otlpTracesProtocol?: string;

	/**
	 * Traces-specific OTLP endpoint (defaults to {@link otlpEndpoint} when exporting OTLP traces)
	 */
	otlpTracesEndpoint?: string;

	otlpTracesHeaders?: Record<string, string>;

	/**
	 * Metric export interval in milliseconds (for console exporter)
	 */
	metricExportInterval?: number;

	/**
	 * Whether to use insecure (non-TLS) connections for gRPC OTLP exporters
	 * Set to "true" for local development without TLS
	 * Default: false (uses TLS)
	 */
	otlpInsecure?: boolean;

	/**
	 * Maximum batch size for log records (default: 512)
	 */
	logBatchSize?: number;

	/**
	 * Maximum time to wait before exporting logs in milliseconds (default: 5000)
	 */
	logBatchTimeout?: number;

	/**
	 * Maximum queue size for log records (default: 2048)
	 */
	logMaxQueueSize?: number;
}

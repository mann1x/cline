/**
 * Compaction as a continuation of the session.
 *
 * The summarizer used to be a stranger to the conversation it summarised: its
 * own system prompt, no tools, and the transcript pasted in as text. Every
 * compaction call therefore prefilled the whole transcript again -- the writer,
 * each critic, the synthesizer -- on the server whose cells had just run out.
 * On opencoti each of those calls also booked a window of its own.
 *
 * Here the writer is the conversation's next turn: the agent's own system
 * prompt, tools and messages, and one more user message asking for the
 * replay. A server with a prompt cache prefills that message and nothing
 * else. On opencoti with pools the rest of the user's design follows
 * (mail #320):
 *
 * 1. **Freeze** the session's resident stream as pool P (`from_session`,
 *    pinned).
 * 2. The **writer** continues the session in its own slot.
 * 3. **P'** = P + the writer's instruction and summary (`fork from_session`).
 * 4. The **critics** attach P' concurrently, each paying for its instruction
 *    and its answer only.
 * 5. **Release**, leaves first: the critics' sessions, P', P, then the
 *    session's own cells.
 * 6. The **synthesizer** joins the halves on an exact-size booking of its own,
 *    which is closed as soon as it answers.
 *
 * The session then continues as P0 (the shared system+tools prefix it was
 * already attached to) plus the replay: nothing is re-rooted, because the
 * prefix pools never held the transcript.
 *
 * Without pools -- Ollama, llama.cpp, an opencoti that does not advertise
 * them, or one that is refusing bookings right now -- steps 2 and 4 still run
 * as plain continuations in the session's own slot, one critic after the
 * other so the second finds the first's prefix still resident.
 *
 * Two rules hold throughout. **Nothing books more than it needs**: a critic on
 * an owned pool is a worker charged its instruction and answer, a critic on an
 * unowned pool and the synthesizer book exactly their request and output, and
 * a session with no booking of its own gives its writer an exact one. **Every
 * failure releases what was created** ({@link CompactionContinuation.dispose}),
 * and a continuation that cannot write a summary hands the compaction back to
 * the transcript-as-text path it replaced.
 */

import {
	clearPolykvSession,
	createPolykvClient,
	engineSessionId,
	getPolykvSession,
	hasOpencotiFeature,
	normalizeProviderId,
	OPENCOTI_FEATURES,
	type OpencotiAllocation,
	type PolykvClient,
	type PolykvPool,
	probeOpencotiProps,
	readOpencotiKv,
	setPolykvSession,
} from "@cline/llms";
import {
	type AgentConfig,
	type BasicLogger,
	classifyTurnFault,
	classifyTurnFaultError,
	hasPromptEnvironment,
	type MessageWithMetadata,
	type ProviderErrorClass,
	type RequestTimings,
} from "@cline/shared";
import { messagesToAgentMessages } from "../../runtime/config/agent-message-codec";
import { createAgentModelFromConfig } from "../../services/llms/handler-factory";
import type { ProviderConfig } from "../../types/provider-settings";

/** Which of the two shapes a compaction ran as. */
export type ContinuationPath = "pooled" | "continuation";

/**
 * Providers whose server keeps the previous request's prefix, so a request
 * that repeats it pays only for what it adds. Everything else -- the hosted
 * APIs -- keeps the transcript-as-text path: nothing there shares a prefix
 * this client can see, and the instruction would move out of the system
 * prompt for no measured gain.
 */
const CONTINUATION_PROVIDERS = new Set([
	"opencoti",
	"ollama",
	"xollama",
	"lmstudio",
	"openai-compatible",
]);

/**
 * What a writer needs on top of the session's own prompt, before its output
 * budget is known: the instruction. Used only to decide whether a
 * continuation can start at all.
 */
const WRITER_INSTRUCTION_ROOM_TOKENS = 3_072;

/** Bookings are aligned the way the engine aligns a negotiated window. */
const BOOKING_ALIGN = 256;

/**
 * Tokens per character for sizing a booking: deliberately more than the
 * estimator's ratio, because a booking that is short fails the call with a
 * 400, and one a few hundred cells long costs nothing anyone else needed.
 */
const BOOKING_CHARS_PER_TOKEN = 3;

/** Headroom on every exact booking, for the chat template's own tokens. */
const BOOKING_SLACK_TOKENS = 512;

/**
 * Waits a critic, the retrospective or the synthesizer takes on a refusal
 * before it declines. The writer waits as long as it takes.
 *
 * Bounded for these because they are optional -- the council and the
 * retrospective degrade to the writer's summary alone, which is what shipped
 * before either existed -- and because under a full server the cells they
 * wait for are the ones this compaction is about to give back. Waiting on
 * them without a bound can wait on itself.
 */
const OPTIONAL_CALL_REFUSAL_WAITS = 3;

const REFUSAL_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

function alignUp(value: number): number {
	return Math.ceil(value / BOOKING_ALIGN) * BOOKING_ALIGN;
}

function tokensForChars(chars: number): number {
	return Math.ceil(Math.max(0, chars) / BOOKING_CHARS_PER_TOKEN);
}

/** An exact booking for a request of `chars` characters and `output` tokens. */
export function exactBooking(chars: number, output: number): number {
	return alignUp(
		tokensForChars(chars) + Math.max(0, output) + BOOKING_SLACK_TOKENS,
	);
}

/** One model call, as a continuation or as a request of its own. */
export interface ContinuationCall {
	purpose: "writer" | "critic" | "retrospective" | "synthesizer";
	providerConfig: ProviderConfig;
	/** The host session id the model is built for (telemetry, affinity). */
	sessionId?: string;
	systemPrompt: string;
	messages: readonly MessageWithMetadata[];
	tools: readonly unknown[];
	maxTokens: number;
	/** `none` keeps the tools in the prompt and asks for prose. */
	toolChoice?: "none";
	reasoning?: ContinuationReasoning;
	abortSignal?: AbortSignal;
}

export interface ContinuationReasoning {
	thinking?: boolean;
	reasoningEffort?: string;
	thinkingBudgetTokens?: number;
	temperature?: number;
}

export interface ContinuationCallResult {
	text: string;
	reasoningChars: number;
	incompleteReason?: string;
	timings?: RequestTimings;
}

/** The one seam every call goes through; tests replace it. */
export type ContinuationModel = (
	call: ContinuationCall,
	logger?: BasicLogger,
) => Promise<ContinuationCallResult>;

/** A turn that failed at the model, with what the provider said about it. */
export class ContinuationCallError extends Error {
	constructor(
		message: string,
		readonly errorClass?: ProviderErrorClass,
	) {
		super(message);
		this.name = "ContinuationCallError";
	}
}

function toolDefinitions(
	tools: readonly unknown[],
): Array<{ name: string; description: string; inputSchema: unknown }> {
	const out: Array<{
		name: string;
		description: string;
		inputSchema: unknown;
	}> = [];
	for (const entry of tools) {
		const tool = (entry ?? {}) as {
			name?: unknown;
			description?: unknown;
			inputSchema?: unknown;
		};
		if (typeof tool.name !== "string" || tool.name === "") {
			continue;
		}
		out.push({
			name: tool.name,
			description: typeof tool.description === "string" ? tool.description : "",
			inputSchema: tool.inputSchema ?? { type: "object" },
		});
	}
	return out;
}

/**
 * The call, through the same model path the agent's own turns take.
 *
 * `createAgentModelFromConfig` and `messagesToAgentMessages` are what the
 * session runtime uses for the conversation, so the request this builds is
 * rendered by the same conversion, the same environment hoisting and the same
 * vendor fetch as the turn before it. The handler path the summarizer used
 * converts messages with a different function, and a prefix is only shared if
 * the two renderings agree byte for byte.
 */
export const defaultContinuationModel: ContinuationModel = async (
	call,
	logger,
) => {
	const config = call.providerConfig;
	const model = createAgentModelFromConfig(
		{
			providerId: config.providerId,
			modelId: config.modelId,
			providerConfig: config,
			...(call.sessionId ? { sessionId: call.sessionId } : {}),
			...(config.engineSessionId
				? { engineSessionId: config.engineSessionId }
				: {}),
			...(config.polykvWorker ? { polykvWorker: config.polykvWorker } : {}),
		} as unknown as AgentConfig,
		logger,
		undefined,
		{ auxiliary: false },
	);
	const reasoning = call.reasoning ?? {};
	const stream = await model.stream({
		systemPrompt: call.systemPrompt,
		messages: messagesToAgentMessages(call.messages),
		tools: toolDefinitions(call.tools) as never,
		...(call.abortSignal ? { signal: call.abortSignal } : {}),
		options: {
			maxTokens: call.maxTokens,
			...(call.toolChoice ? { toolChoice: call.toolChoice } : {}),
			...(reasoning.thinking !== undefined
				? { thinking: reasoning.thinking }
				: {}),
			...(reasoning.reasoningEffort !== undefined
				? { reasoningEffort: reasoning.reasoningEffort }
				: {}),
			...(reasoning.thinkingBudgetTokens !== undefined
				? { thinkingBudgetTokens: reasoning.thinkingBudgetTokens }
				: {}),
			...(reasoning.temperature !== undefined
				? { temperature: reasoning.temperature }
				: {}),
		},
	});
	let text = "";
	let reasoningChars = 0;
	let incompleteReason: string | undefined;
	let timings: RequestTimings | undefined;
	for await (const event of stream) {
		switch (event.type) {
			case "text-delta":
				text += event.text;
				break;
			case "reasoning-delta":
				reasoningChars += event.text.length;
				break;
			case "usage":
				if (event.timings) {
					timings = event.timings;
				}
				break;
			case "finish":
				if (event.reason === "error") {
					throw new ContinuationCallError(
						event.error ?? "the model call failed",
						event.errorClass,
					);
				}
				if (event.reason === "max-tokens") {
					incompleteReason = "max_tokens";
				}
				break;
			default:
				break;
		}
	}
	return { text: text.trim(), reasoningChars, incompleteReason, timings };
};

/** Prompt tokens the engine actually evaluated for one call. */
export function evaluatedPromptTokens(
	timings: RequestTimings | undefined,
): number | undefined {
	if (!timings || timings.promptTokens === undefined) {
		return undefined;
	}
	// llama.cpp's `prompt_n` is the evaluated part already; Ollama's
	// `prompt_eval_count` is the whole prompt, cached prefix included.
	return timings.engine === "ollama"
		? Math.max(0, timings.promptTokens - (timings.cachedTokens ?? 0))
		: timings.promptTokens;
}

/**
 * What one compaction cost, for the line it logs and the numbers a gate
 * compares. Filled by both paths: the continuation from the engine's own
 * timings, the transcript-as-text path from the usage it reports.
 */
export interface CompactionMeter {
	/** Prompt tokens evaluated across every call of the compaction. */
	prefillTokens: number;
	/** Calls that reported nothing to count. */
	unmeasuredCalls: number;
	calls: number;
	/** Extra cells booked at the compaction's peak, beyond the session's own. */
	peakBookedCells: number;
	/** The writer's `cache_n`, and what it was expected to reach. */
	writerCacheN?: number;
	writerExpectedCacheN?: number;
	/** Each critic's `cache_n`, and what P' made possible. */
	criticCacheN: number[];
	criticExpectedCacheN?: number;
	/** `cache_n` of the retrospective and synthesizer when they continued P'. */
	siblingCacheN: number[];
	/** Engine objects released, and those a release failed for. */
	released: string[];
	leaked: string[];
	/** Decisions taken on the way, for the log line. */
	notes: string[];
}

export function createCompactionMeter(): CompactionMeter {
	return {
		prefillTokens: 0,
		unmeasuredCalls: 0,
		calls: 0,
		peakBookedCells: 0,
		criticCacheN: [],
		siblingCacheN: [],
		released: [],
		leaked: [],
		notes: [],
	};
}

export function meterCall(
	meter: CompactionMeter | undefined,
	timings: RequestTimings | undefined,
	fallbackPromptTokens?: number,
): void {
	if (!meter) {
		return;
	}
	meter.calls += 1;
	const evaluated = evaluatedPromptTokens(timings) ?? fallbackPromptTokens;
	if (evaluated === undefined) {
		meter.unmeasuredCalls += 1;
		return;
	}
	meter.prefillTokens += evaluated;
}

/** The half-plan for the council, decided once the writer's summary exists. */
export interface CriticPlan {
	critics: "concurrent" | "serial" | "skip";
	reason: string;
}

/**
 * One compaction's continuation: the session it continues, the pools it
 * made, and every session it opened -- so all of it can be released on any
 * path out.
 */
export interface CompactionContinuation {
	readonly path: ContinuationPath;
	readonly reason: string;
	readonly meter: CompactionMeter;
	/**
	 * The writer: the session's next turn, with `instruction` as the user
	 * message. Called again for a retry; the last call is the one the critics
	 * continue from.
	 */
	write(
		instruction: string,
		maxTokens: number,
	): Promise<ContinuationCallResult>;
	/** Freeze P' after the last writer attempt, and plan the critics. */
	afterWriter(
		summaryChars: number,
		criticMaxTokens: number,
	): Promise<CriticPlan>;
	/** One critic, as a continuation of P' (or of the session, unpooled). */
	critic(
		half: "first" | "second",
		systemPrompt: string,
		request: string,
		maxTokens: number,
	): Promise<string>;
	/**
	 * Room on P' for the retrospective or the synthesizer, reserved now; or
	 * `undefined` when the call does not fit there, and must wait for the
	 * release and run on a booking of its own. Only on an engine that
	 * continues a pool token-exact (`pool_continue_v1`): anywhere else the
	 * call's own reasoning fields would render the prefix differently and it
	 * would share nothing.
	 */
	reservePPrime(
		purpose: "retrospective" | "synthesizer",
		chars: number,
		maxTokens: number,
	): PPrimeReservation | undefined;
	/**
	 * The retrospective or the synthesizer: as a continuation of P' with a
	 * reservation that still holds, otherwise on an exact booking of its own
	 * where the engine books.
	 */
	fresh(
		purpose: "retrospective" | "synthesizer",
		systemPrompt: string,
		request: string,
		maxTokens: number,
		providerConfig: ProviderConfig,
		reservation?: PPrimeReservation,
	): Promise<ContinuationCallResult>;
	/**
	 * Give the session's cells back: the critics, P', P, then the session's
	 * own slot. Idempotent; run before the synthesizer, and again by
	 * {@link dispose} on any path out.
	 */
	release(): Promise<void>;
	/** Release everything this continuation created. Idempotent. */
	dispose(): Promise<void>;
}

/** Room on P' held for one call (`reservePPrime`). */
export interface PPrimeReservation {
	readonly purpose: "retrospective" | "synthesizer";
	/** Cells charged against the owner's room while the call runs. */
	readonly cells: number;
}

export interface PrepareContinuationInput {
	/** The session's provider config: the connection its turns go out on. */
	providerConfig: ProviderConfig;
	/** The host's session id: the key of the pool registry and the wire id. */
	sessionId: string | undefined;
	systemPrompt: string;
	tools: readonly unknown[];
	/** The messages the agent's next request would carry. */
	apiMessages: readonly MessageWithMetadata[];
	/** The window the session holds (the granted one where it is smaller). */
	contextWindow: number | undefined;
	/** The provider's count of the last request, or the estimate. */
	requestTokens: number;
	/** The last request's own prompt count, when one was measured. */
	observedRequestTokens?: number;
	reasoning: ContinuationReasoning;
	/** A summarizer model of its own is configured: it cannot continue this one. */
	separateSummarizer: boolean;
	/** The server is refusing bookings: no new ones, no pools. */
	kvPressureActive: boolean;
	overflowRecovery: boolean;
	abortSignal?: AbortSignal;
	logger?: BasicLogger;
	/** Test seam for the model calls. */
	model?: ContinuationModel;
	/** Test seam for the waits between refusals. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** A number unique within the process, for the compaction's session ids. */
	serial?: number;
	/**
	 * The compaction's meter: shared with a transcript-as-text fallback, so
	 * the one line it logs counts both.
	 */
	meter?: CompactionMeter;
}

let CONTINUATION_SERIAL = 0;

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Whether a failed call is the server saying "not now". */
export function isInfraFault(error: unknown): boolean {
	if (error instanceof ContinuationCallError) {
		return classifyTurnFault(error.message, error.errorClass) !== undefined;
	}
	return classifyTurnFaultError(error) !== undefined;
}

/**
 * Whether compaction on this connection can run as a continuation, and in
 * which shape. `undefined` continuation with the reason when it cannot.
 */
export async function prepareCompactionContinuation(
	input: PrepareContinuationInput,
): Promise<{ continuation?: CompactionContinuation; reason: string }> {
	const config = input.providerConfig;
	const providerId = normalizeProviderId(config.providerId ?? "");
	if (config.polykv?.continuationCompaction === false) {
		return { reason: "switched off (polykv.continuationCompaction: false)" };
	}
	if (input.separateSummarizer) {
		return {
			reason:
				"a summarizer model of its own is configured; it cannot continue this session",
		};
	}
	if (!CONTINUATION_PROVIDERS.has(providerId)) {
		return {
			reason: `${providerId || "this provider"} keeps no prefix a continuation could share`,
		};
	}
	if (input.overflowRecovery) {
		return {
			reason:
				"overflow recovery: the session's own prompt no longer fits its window",
		};
	}
	const window = input.contextWindow;
	if (
		typeof window === "number" &&
		window > 0 &&
		input.requestTokens + WRITER_INSTRUCTION_ROOM_TOKENS > window
	) {
		return {
			reason: `no room in the window for the writer (${input.requestTokens} + ${WRITER_INSTRUCTION_ROOM_TOKENS} > ${window})`,
		};
	}

	let path: ContinuationPath = "continuation";
	let reason = "prompt-cache continuation";
	let client: PolykvClient | undefined;
	let features: readonly string[] = [];
	let poolsEnabled = false;
	let held: OpencotiAllocation | undefined;
	const opencoti = providerId === "opencoti" && Boolean(config.baseUrl);
	const wireId = engineSessionId(
		config.engineSessionId || input.sessionId || "",
	);
	if (opencoti && wireId) {
		const props = await probeOpencotiProps(config.baseUrl, config.fetch).catch(
			() => undefined,
		);
		features = props?.features ?? [];
		poolsEnabled = props?.poolsEnabled === true;
		client = createPolykvClient({
			baseUrl: config.baseUrl as string,
			...(config.fetch ? { fetch: config.fetch } : {}),
			...(config.headers ? { headers: config.headers } : {}),
		});
		const snapshot = hasOpencotiFeature(features, OPENCOTI_FEATURES.kvStatus)
			? await readOpencotiKv(config.baseUrl, config.fetch).catch(
					() => undefined,
				)
			: undefined;
		held = snapshot?.allocations.find((row) => row.sessionId === wireId);
		const pooledReady =
			config.polykv?.enabled !== false &&
			poolsEnabled &&
			hasOpencotiFeature(features, OPENCOTI_FEATURES.subpools) &&
			hasOpencotiFeature(features, OPENCOTI_FEATURES.sessionClose) &&
			hasOpencotiFeature(features, OPENCOTI_FEATURES.kvStatus);
		if (!pooledReady) {
			reason =
				"the engine does not advertise pools, sub-pools, session close and /kv";
		} else if (input.kvPressureActive) {
			reason = "the server is refusing bookings: no pools, no new bookings";
		} else {
			path = "pooled";
			reason = held
				? "pooled on the session's own booking"
				: config.polykvWorker
					? "pooled from a swarm worker (unowned)"
					: "pooled on an exact writer booking";
		}
	}
	const continuation = new Continuation({
		input,
		path,
		reason,
		wireId,
		opencoti,
		features,
		held,
		prefixPooled:
			opencoti &&
			poolsEnabled &&
			config.polykv?.enabled !== false &&
			(Boolean(config.polykvWorker) ||
				getPolykvSession(input.sessionId) !== undefined ||
				hasPromptEnvironment(input.systemPrompt)),
		...(client ? { client } : {}),
	});
	await continuation.start();
	return { continuation, reason: continuation.reason };
}

interface ContinuationState {
	input: PrepareContinuationInput;
	path: ContinuationPath;
	reason: string;
	wireId: string;
	opencoti: boolean;
	features: readonly string[];
	held?: OpencotiAllocation;
	/**
	 * The next request's head is covered by a pool (the lead tree, the
	 * session's own root, a swarm tree), so dropping the slot's cells costs no
	 * re-prefill of the system prompt and tools.
	 */
	prefixPooled: boolean;
	client?: PolykvClient;
}

class Continuation implements CompactionContinuation {
	readonly meter: CompactionMeter;
	path: ContinuationPath;
	reason: string;
	private readonly serial: number;
	private p?: PolykvPool;
	private pPrime?: PolykvPool;
	private pPrimeOwned = false;
	private lastWriter?: { instruction: string; text: string; cacheN?: number };
	/** The writer booked a window for this compaction under the session's id. */
	private writerBooking?: number;
	/** Critic and fresh sessions still open, by wire id. */
	private readonly openSessions = new Set<string>();
	private released = false;
	private disposed = false;
	/** Extra cells booked right now, and at the peak. */
	private bookedNow = 0;
	/**
	 * The owner's free cells when P' was frozen, and what this compaction's
	 * calls on P' have claimed of them since. `undefined` room: not measured.
	 */
	private ownerRoom?: number;
	private claimed = 0;
	/**
	 * The critics' share of {@link claimed}: held from the plan until the
	 * synthesizer reserves, which the council only asks for once both critics
	 * have answered.
	 */
	private criticClaim = 0;

	constructor(private readonly state: ContinuationState) {
		this.meter = state.input.meter ?? createCompactionMeter();
		this.path = state.path;
		this.reason = state.reason;
		this.serial = state.input.serial ?? ++CONTINUATION_SERIAL;
	}

	private get input(): PrepareContinuationInput {
		return this.state.input;
	}

	private get logger(): BasicLogger | undefined {
		return this.input.logger;
	}

	private note(line: string): void {
		this.meter.notes.push(line);
		this.logger?.debug?.(`[compaction] ${line}`);
	}

	private book(cells: number): void {
		this.bookedNow += cells;
		this.meter.peakBookedCells = Math.max(
			this.meter.peakBookedCells,
			this.bookedNow,
		);
	}

	private unbook(cells: number): void {
		this.bookedNow = Math.max(0, this.bookedNow - cells);
	}

	private idFor(role: string): string {
		return `${this.state.wireId}~cc${this.serial}-${role}`;
	}

	/** Step 1: freeze the session's resident stream as P. */
	async start(): Promise<void> {
		if (this.path !== "pooled" || !this.state.client) {
			return;
		}
		try {
			this.p = await this.state.client.createPool({
				from_session: this.state.wireId,
				pin: true,
			});
			this.note(
				`froze the session as pool ${this.p.pool_id} (${this.p.prefix_len} tokens, owner ${this.p.owner === undefined ? "?" : this.p.owner || "none"})`,
			);
		} catch (error) {
			// The slot is someone else's now, or the engine refused: the
			// session's cells are not resident to freeze. The writer still
			// continues the session; the critics run in its slot.
			this.path = "continuation";
			this.reason = `freeze refused (${describe(error)}); prompt-cache continuation`;
			this.note(this.reason);
		}
	}

	private async call(
		call: ContinuationCall,
		options: { boundedWaits: boolean },
	): Promise<ContinuationCallResult> {
		const model = this.input.model ?? defaultContinuationModel;
		const sleep = this.input.sleep ?? abortableSleep;
		for (let waits = 0; ; waits += 1) {
			try {
				const result = await model(call, this.logger);
				meterCall(this.meter, result.timings);
				return result;
			} catch (error) {
				if (this.input.abortSignal?.aborted) {
					throw error;
				}
				if (!isInfraFault(error)) {
					throw error;
				}
				if (options.boundedWaits && waits >= OPTIONAL_CALL_REFUSAL_WAITS) {
					throw error;
				}
				const wait =
					REFUSAL_BACKOFF_MS[Math.min(waits, REFUSAL_BACKOFF_MS.length - 1)];
				// A refusal is the server's to have, and never the agent's
				// failure: info, and wait.
				this.logger?.log(
					`[compaction] ${call.purpose} refused by the server; waiting ${wait}ms (${describe(error)})`,
					{ severity: "info" },
				);
				await sleep(wait, this.input.abortSignal);
			}
		}
	}

	private writerMessages(instruction: string): MessageWithMetadata[] {
		return [
			...this.input.apiMessages,
			{ role: "user", content: [{ type: "text", text: instruction }] },
		];
	}

	/** Step 2: the writer continues the session. */
	async write(
		instruction: string,
		maxTokens: number,
	): Promise<ContinuationCallResult> {
		const config = this.input.providerConfig;
		let providerConfig = config;
		// A session that holds no booking between its turns would have its
		// writer admitted as a per-request allocation, which asks for the
		// server's whole per-session maximum. It gets one exact booking under
		// its own id instead -- its own slot, its own resident prefix -- and
		// that booking is closed with the session's cells at the release.
		if (
			this.state.opencoti &&
			!this.state.held &&
			!config.polykvWorker &&
			hasOpencotiFeature(this.state.features, OPENCOTI_FEATURES.guaranteedAlloc)
		) {
			const booking = alignUp(
				Math.ceil(this.input.requestTokens * 1.1) +
					tokensForChars(instruction.length) +
					maxTokens +
					BOOKING_SLACK_TOKENS,
			);
			if (this.writerBooking === undefined) {
				this.book(booking);
			} else if (booking > this.writerBooking) {
				this.book(booking - this.writerBooking);
			}
			this.writerBooking = Math.max(this.writerBooking ?? 0, booking);
			providerConfig = {
				...config,
				polykvBooking: { numCtx: this.writerBooking },
				// Its own booking, not the lead's window: the lead tree would
				// fork a sub-pool into a window that is about to be closed.
				polykvLeadPool: false,
			};
		}
		const result = await this.call(
			{
				purpose: "writer",
				providerConfig,
				...(this.input.sessionId ? { sessionId: this.input.sessionId } : {}),
				systemPrompt: this.input.systemPrompt,
				messages: this.writerMessages(instruction),
				tools: this.input.tools,
				maxTokens,
				toolChoice: "none",
				reasoning: this.input.reasoning,
				...(this.input.abortSignal
					? { abortSignal: this.input.abortSignal }
					: {}),
			},
			{ boundedWaits: false },
		);
		this.lastWriter = {
			instruction,
			text: result.text,
			...(result.timings?.cachedTokens !== undefined
				? { cacheN: result.timings.cachedTokens }
				: {}),
		};
		this.meter.writerCacheN = result.timings?.cachedTokens;
		this.meter.writerExpectedCacheN =
			this.p?.prefix_len ?? this.input.observedRequestTokens;
		return result;
	}

	/**
	 * Step 3: freeze P' = the session after the writer, then decide how the
	 * critics run. Called once, after the last writer attempt.
	 */
	async afterWriter(
		summaryChars: number,
		criticMaxTokens: number,
	): Promise<CriticPlan> {
		const client = this.state.client;
		const criticChars = summaryChars * 2 + 6_000;
		const criticNeed = tokensForChars(criticChars) + criticMaxTokens;
		if (this.path === "pooled" && client && this.p) {
			const branch = Math.min(this.lastWriter?.cacheN ?? 0, this.p.prefix_len);
			try {
				this.pPrime =
					branch > 0
						? await client.forkPool(this.p.pool_id, {
								from_session: this.state.wireId,
								branch_pos: branch,
								pin: true,
							})
						: await client.createPool({
								from_session: this.state.wireId,
								pin: true,
							});
			} catch (error) {
				// The contiguous-prefix check disagreed with the writer's
				// `cache_n`, or the parent is gone: a root of its own still
				// shares the whole stream with the critics.
				this.note(
					`fork of P refused (${describe(error)}); freezing P' as a root`,
				);
				try {
					this.pPrime = await client.createPool({
						from_session: this.state.wireId,
						pin: true,
					});
				} catch (again) {
					this.note(`P' could not be frozen (${describe(again)})`);
				}
			}
		}
		if (this.pPrime && client) {
			this.meter.criticExpectedCacheN = this.pPrime.prefix_len;
			const owner =
				this.pPrime.owner ??
				(this.state.held || this.writerBooking !== undefined
					? this.state.wireId
					: "");
			this.pPrimeOwned = owner !== "";
			this.note(
				`froze P' as pool ${this.pPrime.pool_id} (${this.pPrime.prefix_len} tokens, ${this.pPrimeOwned ? `owned by ${owner}` : "unowned"})`,
			);
			if (!this.pPrimeOwned) {
				// Each critic books its own exact window above the shared
				// prefix; nothing is charged to anyone else's room.
				if (
					hasOpencotiFeature(
						this.state.features,
						OPENCOTI_FEATURES.privateWindow,
					)
				) {
					return {
						critics: "concurrent",
						reason: "critics attach the unowned P' on exact bookings",
					};
				}
				this.note(
					"no private windows on this engine: critics run in the session",
				);
				this.releasePPrimeLater = true;
			} else {
				// Workers of the owner: charged instruction + answer against its
				// room. No growth -- a compaction never books past the window.
				const room = await this.readOwnerRoom(owner);
				this.ownerRoom = room;
				if (room === undefined || room >= criticNeed * 2) {
					this.criticClaim = criticNeed * 2;
					this.claimed += this.criticClaim;
					return {
						critics: "concurrent",
						reason: `critics are workers of ${owner}${room === undefined ? "" : ` (${room} cells free)`}`,
					};
				}
				if (room >= criticNeed) {
					this.criticClaim = criticNeed;
					this.claimed += this.criticClaim;
					return {
						critics: "serial",
						reason: `room for one critic at a time in ${owner} (${room} of ${criticNeed * 2} cells)`,
					};
				}
				return {
					critics: "skip",
					reason: `no room in ${owner}'s window for a critic (${room} free, ${criticNeed} needed)`,
				};
			}
		}
		// In the session's own slot, one after the other.
		const window = this.input.contextWindow;
		if (typeof window === "number" && window > 0) {
			const peak =
				this.input.requestTokens +
				tokensForChars(
					(this.lastWriter?.instruction.length ?? 0) + summaryChars,
				) +
				criticNeed;
			if (peak > window) {
				return {
					critics: "skip",
					reason: `no room in the window for a critic (${peak} > ${window})`,
				};
			}
		}
		return {
			critics: "serial",
			reason: "critics continue the session, one at a time",
		};
	}

	/** P' was frozen but the critics cannot use it: release it with the rest. */
	private releasePPrimeLater = false;

	private async readOwnerRoom(owner: string): Promise<number | undefined> {
		const config = this.input.providerConfig;
		const snapshot = await readOpencotiKv(config.baseUrl, config.fetch).catch(
			() => undefined,
		);
		const row = snapshot?.allocations.find(
			(entry) => entry.sessionId === owner,
		);
		return row ? Math.max(0, row.window - row.used) : undefined;
	}

	/** Step 4: one critic, continuing P' (or the session). */
	async critic(
		half: "first" | "second",
		systemPrompt: string,
		request: string,
		maxTokens: number,
	): Promise<string> {
		const writer = this.lastWriter;
		if (!writer) {
			throw new Error("no writer turn to continue");
		}
		const messages: MessageWithMetadata[] = [
			...this.writerMessages(writer.instruction),
			{ role: "assistant", content: [{ type: "text", text: writer.text }] },
			{
				role: "user",
				content: [{ type: "text", text: `${systemPrompt}\n\n${request}` }],
			},
		];
		const config = this.input.providerConfig;
		const pooled =
			this.path === "pooled" && this.pPrime && !this.releasePPrimeLater;
		let providerConfig: ProviderConfig;
		let criticId: string | undefined;
		let booking = 0;
		if (pooled && this.pPrime) {
			criticId = this.idFor(`critic-${half}`);
			if (!this.pPrimeOwned) {
				booking = exactBooking(
					writer.text.length + request.length + systemPrompt.length,
					maxTokens,
				);
			}
			const {
				polykvWorker: _worker,
				polykvBooking: _booking,
				...rest
			} = config;
			providerConfig = {
				...rest,
				engineSessionId: criticId,
				polykvLeadPool: false,
				...(booking > 0 ? { polykvBooking: { numCtx: booking } } : {}),
			};
			setPolykvSession(criticId, {
				poolId: this.pPrime.pool_id,
				prefixTokens: this.pPrime.prefix_len,
				layout: "borrowed",
				...(this.continuesPools ? { continueTail: 1 } : {}),
			});
			this.openSessions.add(criticId);
			if (booking > 0) {
				this.book(booking);
			}
		} else {
			providerConfig = this.writerBooking
				? {
						...config,
						polykvBooking: { numCtx: this.writerBooking },
						polykvLeadPool: false,
					}
				: config;
		}
		try {
			const result = await this.call(
				{
					purpose: "critic",
					providerConfig,
					...(criticId
						? { sessionId: criticId }
						: this.input.sessionId
							? { sessionId: this.input.sessionId }
							: {}),
					systemPrompt: this.input.systemPrompt,
					messages,
					tools: this.input.tools,
					maxTokens,
					toolChoice: "none",
					reasoning: this.input.reasoning,
					...(this.input.abortSignal
						? { abortSignal: this.input.abortSignal }
						: {}),
				},
				{ boundedWaits: true },
			);
			if (result.timings?.cachedTokens !== undefined) {
				this.meter.criticCacheN.push(result.timings.cachedTokens);
			}
			return result.text;
		} finally {
			// A leaf, released the moment it has answered (Q4 step 1).
			if (criticId) {
				await this.closeSession(criticId);
				clearPolykvSession(criticId);
				if (booking > 0) {
					this.unbook(booking);
				}
			}
		}
	}

	/** The engine continues a pool token-exact (`pool_continue_v1`). */
	private get continuesPools(): boolean {
		return hasOpencotiFeature(
			this.state.features,
			OPENCOTI_FEATURES.poolContinue,
		);
	}

	reservePPrime(
		purpose: "retrospective" | "synthesizer",
		chars: number,
		maxTokens: number,
	): PPrimeReservation | undefined {
		if (
			this.path !== "pooled" ||
			!this.pPrime ||
			this.releasePPrimeLater ||
			this.released ||
			!this.continuesPools
		) {
			return undefined;
		}
		const cells = tokensForChars(chars) + maxTokens + BOOKING_SLACK_TOKENS;
		if (purpose === "synthesizer" && this.criticClaim > 0) {
			this.claimed = Math.max(0, this.claimed - this.criticClaim);
			this.criticClaim = 0;
		}
		if (this.pPrimeOwned) {
			// A worker of the owner, charged its request and its answer against
			// room the owner already holds: no new cells anywhere.
			if (
				this.ownerRoom !== undefined &&
				this.claimed + cells > this.ownerRoom
			) {
				return undefined;
			}
		} else if (
			purpose === "synthesizer" ||
			!hasOpencotiFeature(this.state.features, OPENCOTI_FEATURES.privateWindow)
		) {
			// On an unowned P' every attacher books its own window. The
			// retrospective's is small and runs beside the critics; the
			// synthesizer's would be booked while P and P' are still held, which
			// is what running it after the release exists to avoid.
			return undefined;
		}
		this.claimed += cells;
		this.note(
			`${purpose} continues P' (${cells} cells${this.pPrimeOwned ? ` of ${this.ownerRoom ?? "unmeasured"} free in the owner` : ", booked"})`,
		);
		return { purpose, cells };
	}

	/** One call as a continuation of P', in its own session. */
	private async onPPrime(
		reservation: PPrimeReservation,
		systemPrompt: string,
		request: string,
		maxTokens: number,
		summarizerConfig: ProviderConfig,
	): Promise<ContinuationCallResult> {
		const writer = this.lastWriter;
		const pPrime = this.pPrime;
		if (!writer || !pPrime) {
			throw new Error("no P' to continue");
		}
		const id = this.idFor(reservation.purpose);
		const booking = this.pPrimeOwned
			? 0
			: exactBooking(systemPrompt.length + request.length, maxTokens);
		const {
			polykvWorker: _worker,
			polykvBooking: _booking,
			...rest
		} = this.input.providerConfig;
		setPolykvSession(id, {
			poolId: pPrime.pool_id,
			prefixTokens: pPrime.prefix_len,
			layout: "borrowed",
			continueTail: 1,
		});
		this.openSessions.add(id);
		if (booking > 0) {
			this.book(booking);
		}
		try {
			const result = await this.call(
				{
					purpose: reservation.purpose,
					providerConfig: {
						...rest,
						engineSessionId: id,
						polykvLeadPool: false,
						...(booking > 0 ? { polykvBooking: { numCtx: booking } } : {}),
					},
					sessionId: id,
					systemPrompt: this.input.systemPrompt,
					messages: [
						...this.writerMessages(writer.instruction),
						{
							role: "assistant",
							content: [{ type: "text", text: writer.text }],
						},
						{
							role: "user",
							content: [
								{ type: "text", text: `${systemPrompt}\n\n${request}` },
							],
						},
					],
					tools: this.input.tools,
					maxTokens,
					toolChoice: "none",
					// The pool is continued token-exact, so the reasoning fields
					// no longer have to match the session's to share its prefix:
					// the summarizer's own, as on a booking of its own.
					reasoning: summarizerReasoning(summarizerConfig),
					...(this.input.abortSignal
						? { abortSignal: this.input.abortSignal }
						: {}),
				},
				{ boundedWaits: true },
			);
			if (result.timings?.cachedTokens !== undefined) {
				this.meter.siblingCacheN.push(result.timings.cachedTokens);
			}
			return result;
		} finally {
			await this.closeSession(id);
			clearPolykvSession(id);
			if (booking > 0) {
				this.unbook(booking);
			}
			this.claimed = Math.max(0, this.claimed - reservation.cells);
		}
	}

	async fresh(
		purpose: "retrospective" | "synthesizer",
		systemPrompt: string,
		request: string,
		maxTokens: number,
		summarizerConfig: ProviderConfig,
		reservation?: PPrimeReservation,
	): Promise<ContinuationCallResult> {
		if (reservation) {
			if (this.pPrime && !this.released) {
				return this.onPPrime(
					reservation,
					systemPrompt,
					request,
					maxTokens,
					summarizerConfig,
				);
			}
			this.claimed = Math.max(0, this.claimed - reservation.cells);
		}
		let providerConfig = summarizerConfig;
		let id: string | undefined;
		let booking = 0;
		if (
			this.state.opencoti &&
			hasOpencotiFeature(this.state.features, OPENCOTI_FEATURES.guaranteedAlloc)
		) {
			id = this.idFor(purpose);
			booking = exactBooking(systemPrompt.length + request.length, maxTokens);
			const { polykvWorker: _worker, ...rest } = summarizerConfig;
			providerConfig = {
				...rest,
				engineSessionId: id,
				polykvLeadPool: false,
				polykvBooking: { numCtx: booking },
			};
			this.openSessions.add(id);
			this.book(booking);
		}
		try {
			return await this.call(
				{
					purpose,
					providerConfig,
					...(id ? { sessionId: id } : {}),
					systemPrompt,
					messages: [
						{ role: "user", content: [{ type: "text", text: request }] },
					],
					tools: [],
					maxTokens,
					// Not a continuation, so not the session's reasoning: the
					// summarizer config's own, which is how the text path sent
					// it. Left to the model's default, a thinking model spent the
					// synthesizer's whole budget reasoning (8244, 2026-09-26).
					reasoning: summarizerReasoning(summarizerConfig),
					...(this.input.abortSignal
						? { abortSignal: this.input.abortSignal }
						: {}),
				},
				{ boundedWaits: true },
			);
		} finally {
			if (id) {
				await this.closeSession(id);
				this.unbook(booking);
			}
		}
	}

	private async closeSession(id: string): Promise<void> {
		const client = this.state.client;
		this.openSessions.delete(id);
		if (!client) {
			return;
		}
		try {
			const report = await client.closeSessionReport(id);
			this.meter.released.push(
				`session ${id}${report.found ? " (booking)" : ""}${report.kvDropped ? " (kv)" : ""}`,
			);
		} catch (error) {
			this.meter.leaked.push(`session ${id}: ${describe(error)}`);
		}
	}

	private async releasePool(pool: PolykvPool | undefined): Promise<void> {
		const client = this.state.client;
		if (!pool || !client) {
			return;
		}
		// Unpin first: the engine will not reclaim a pinned pool.
		await client.unpin(pool.pool_id).catch(() => undefined);
		try {
			await client.releasePool(pool.pool_id);
			this.meter.released.push(`pool ${pool.pool_id}`);
		} catch (error) {
			this.meter.leaked.push(`pool ${pool.pool_id}: ${describe(error)}`);
		}
	}

	/** Step 5: leaves first, then the session's own cells. */
	async release(): Promise<void> {
		if (this.released) {
			return;
		}
		this.released = true;
		for (const id of [...this.openSessions]) {
			await this.closeSession(id);
			clearPolykvSession(id);
		}
		await this.releasePool(this.pPrime);
		this.pPrime = undefined;
		await this.releasePool(this.p);
		this.p = undefined;
		await this.releaseSessionCells();
	}

	/**
	 * The session's own slot, which holds the transcript the replay is about
	 * to replace. Only where a pool covers the next request's head: a session
	 * whose system prompt and tools live only in its slot would pay for them
	 * again on its next turn.
	 */
	private async releaseSessionCells(): Promise<void> {
		const client = this.state.client;
		if (!client || !this.state.wireId) {
			return;
		}
		if (this.writerBooking !== undefined) {
			// The writer's booking is this compaction's: closing it gives back
			// the booking and the slot's cells together.
			await this.closeSession(this.state.wireId);
			this.unbook(this.writerBooking);
			return;
		}
		if (!this.state.prefixPooled) {
			this.note("no pool covers the session's head; its slot is left resident");
			return;
		}
		if (this.state.held) {
			// Keep the booking -- the conversation goes on in it, and a closed
			// one would have to be won back on the next turn -- and drop what
			// the slot holds.
			try {
				const erased = await client.eraseSessionSlot(this.state.wireId);
				this.meter.released.push(
					erased === undefined
						? `slot of ${this.state.wireId} (not resident)`
						: `slot of ${this.state.wireId} (${erased} cells)`,
				);
			} catch (error) {
				this.meter.leaked.push(
					`slot of ${this.state.wireId}: ${describe(error)}`,
				);
			}
			return;
		}
		// No booking: a close drops the slot's cells and books nothing.
		await this.closeSession(this.state.wireId);
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		await this.release();
	}
}

/** The summarizer config's own reasoning settings, as a call's. */
function summarizerReasoning(config: ProviderConfig): ContinuationReasoning {
	return {
		...(config.thinking !== undefined ? { thinking: config.thinking } : {}),
		...(config.reasoningEffort !== undefined
			? { reasoningEffort: config.reasoningEffort }
			: {}),
		...(config.thinkingBudgetTokens !== undefined
			? { thinkingBudgetTokens: config.thinkingBudgetTokens }
			: {}),
	};
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The line every compaction logs: which path it took and why, what it
 * prefilled, how much of the session's cache it reused, what it booked, how
 * long it took.
 */
export function describeCompactionRun(input: {
	path: ContinuationPath | "fallback";
	reason: string;
	meter: CompactionMeter;
	durationMs: number;
	sessionWindow?: number;
}): string {
	const m = input.meter;
	const writer =
		m.writerCacheN === undefined
			? "n/a"
			: `${m.writerCacheN}/${m.writerExpectedCacheN ?? "?"}`;
	const critics =
		m.criticCacheN.length === 0
			? "n/a"
			: `${m.criticCacheN.join(",")}/${m.criticExpectedCacheN ?? "?"}`;
	const siblings =
		m.siblingCacheN.length === 0
			? ""
			: ` on-P'=${m.siblingCacheN.join(",")}/${m.criticExpectedCacheN ?? "?"}`;
	return [
		`[compaction] path=${input.path} (${input.reason})`,
		`prefill=${m.prefillTokens}${m.unmeasuredCalls > 0 ? ` (+${m.unmeasuredCalls} unmeasured)` : ""} over ${m.calls} calls`,
		`cache_n writer=${writer} critics=${critics}${siblings}`,
		`peak booked=${m.peakBookedCells}${input.sessionWindow ? ` of window ${input.sessionWindow}` : ""}`,
		`wall=${input.durationMs}ms`,
		...(m.released.length > 0 ? [`released=${m.released.length}`] : []),
		...(m.leaked.length > 0 ? [`LEAKED=${m.leaked.join("; ")}`] : []),
	].join(" ");
}

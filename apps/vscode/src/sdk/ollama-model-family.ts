import { MODEL_COLLECTIONS_BY_PROVIDER_ID } from "@cline/llms"
import { HostProvider } from "@/hosts/host-provider"
import { fetch } from "@/shared/net"
import { ShowMessageType } from "@/shared/proto/index.host"
import { Logger } from "@/shared/services/Logger"

/**
 * Ask Ollama which architecture a model actually is.
 *
 * A prompt template matches on model family, and for a local model the name is
 * not evidence of one. `v7-coder_tb:Q4_K_M` is a Gemma 4; `ornith:latest` is a
 * Qwen 3.5. Nothing in either string says so, and asking a user to tag their
 * own models by hand would be asking them to repeat what the GGUF already
 * records.
 *
 * Ollama reports it: `/api/show` returns `details.family`, taken from the
 * file's `general.architecture`. That is the same string across every quant and
 * every rename of a model, which is exactly the stable key a template wants to
 * match on.
 *
 * This sits on the path that builds a session, so it fails soft and fast: an
 * Ollama that is not running, or a model that was deleted, resolves to no
 * family, and the session falls back to the provider or default template.
 */

/** Short by design — this delays the first request of a session. */

/**
 * How hard to press Ollama for `/api/show` before giving up on a session.
 *
 * A single 2-second attempt is what a busy Ollama loses: measured live, the
 * lookup for the model the session was about to use timed out at start-up while
 * the server was mid-load, and the session carried on without it. Everything
 * that call answers -- context window, image support, think budget -- then falls
 * back to a guess, and a guessed context window is the failure this fork has
 * already had to fix twice.
 *
 * Ollama is local and it recovers, so the answer is to wait for it rather than
 * to invent one. Ten quick attempts cover a server that is briefly busy without
 * making anyone watch a progress bar; past that the wait is real, so it is
 * declared on screen and the attempts slow down instead of hammering. Nothing
 * that gets here is allowed to start a session on a guess.
 */
const SHOW_FAST_ATTEMPTS = 10
const SHOW_MAX_ATTEMPTS = 30
const SHOW_FAST_TIMEOUT_MS = 2_000
const SHOW_SLOW_TIMEOUT_MS = 10_000
const SHOW_FAST_RETRY_DELAY_MS = 250
const SHOW_SLOW_RETRY_DELAY_MS = 1_000

/** Attempt timeout, flat while fast then ramping to the ceiling. */
function showAttemptTimeoutMs(attempt: number): number {
	if (attempt <= SHOW_FAST_ATTEMPTS) {
		return SHOW_FAST_TIMEOUT_MS
	}
	const span = SHOW_MAX_ATTEMPTS - SHOW_FAST_ATTEMPTS
	const step = Math.min(attempt - SHOW_FAST_ATTEMPTS, span)
	return Math.round(SHOW_FAST_TIMEOUT_MS + ((SHOW_SLOW_TIMEOUT_MS - SHOW_FAST_TIMEOUT_MS) * step) / span)
}

function showRetryDelayMs(attempt: number): number {
	return attempt <= SHOW_FAST_ATTEMPTS ? SHOW_FAST_RETRY_DELAY_MS : SHOW_SLOW_RETRY_DELAY_MS
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Raised when `/api/show` never answered. Callers on the session path must not swallow it. */
export class OllamaModelInfoUnavailableError extends Error {
	constructor(
		readonly modelId: string,
		readonly attempts: number,
		readonly lastError: string,
	) {
		super(
			`Ollama did not answer /api/show for "${modelId}" after ${attempts} attempts (last error: ${lastError}). ` +
				`Cerebriline needs the model's own context window, image support and think budget before it can start a session; ` +
				`starting without them would mean running on guessed values. Check that Ollama is running and the model is available, then try again.`,
		)
		this.name = "OllamaModelInfoUnavailableError"
	}
}

/**
 * Where Ollama is when the settings field is blank.
 *
 * Blank is the normal state for anyone running Ollama where Ollama installs
 * itself, and it does not mean "no endpoint" — the request path falls back to
 * the provider's own default and talks to it happily. This lookup has to fall
 * back to the same one, or it answers about a server the session never uses:
 * a blank field would mean the family is never read, and every local model
 * would land on `default.md` however plainly the GGUF said `qwen35moe`.
 *
 * Read from the provider registry rather than written out, so the two cannot
 * drift into pointing at different hosts.
 */
export const DEFAULT_OLLAMA_BASE_URL: string = MODEL_COLLECTIONS_BY_PROVIDER_ID.ollama?.provider.baseUrl ?? ""

/**
 * Families are a property of the model file, so they never change for a given
 * name. The cache exists to keep a per-session HTTP call from becoming a
 * per-session HTTP wait, and is keyed by endpoint as well as model because two
 * hosts can serve different models under the same name.
 */
/** Successful and in-flight lookups, shared by every reader. */
const showCache = new Map<string, Promise<unknown | undefined>>()

/**
 * When a demanded lookup last exhausted its retries.
 *
 * Several resolvers read the same `/api/show` during one session start --
 * context window, image support, think budget -- and they do not all run at
 * once. Without this, each would climb the whole ladder again, turning one
 * three-minute wait into three. The window is longer than a full ladder for
 * that reason, and short enough that the next session tries an Ollama that has
 * since come back.
 */
const showFailedAt = new Map<string, number>()
const SHOW_FAILURE_COOLDOWN_MS = 300_000

function cacheKey(baseUrl: string, modelId: string): string {
	return `${baseUrl}\u0000${modelId}`
}

/** Test seam: the cache outlives a session and would leak between cases. */
/**
 * Forget the `/api/show` answers, keeping the failure cool-down. Called at
 * each session start: the cache is shared by the resolvers of one start, and a
 * model rebuilt under the same name since the last one must be read again.
 */
export function forgetOllamaShowAnswers(): void {
	showCache.clear()
}

export function clearOllamaModelFamilyCache(): void {
	showCache.clear()
	showFailedAt.clear()
}

/** One attempt, with the timeout this rung of the ladder allows. */
async function attemptShow(endpoint: string, modelId: string, timeoutMs: number): Promise<unknown> {
	// `fetch` rather than axios, which every other caller here uses for its
	// GETs: axios is configured with the fetch adapter, and that adapter hands
	// undici a stream body, which undici refuses without `duplex: "half"` —
	// `RequestInit: duplex option is required when sending a body`. This is the
	// only POST on that path, so it was the only one to hit it. A string body
	// has no such problem.
	const response = await fetch(`${endpoint.replace(/\/+$/, "")}/api/show`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: modelId }),
		signal: AbortSignal.timeout(timeoutMs),
	})
	if (!response.ok) {
		throw new Error(`/api/show returned ${response.status}`)
	}
	return await response.json()
}

/** Remember a success so the rest of the session reads it for free. */
function cacheShowResult(key: string, promise: Promise<unknown | undefined>): Promise<unknown | undefined> {
	// Tracked before it is handed out, so a rejection never stays cached as if
	// it were an answer.
	const tracked = promise.catch((error: unknown) => {
		if (showCache.get(key) === tracked) {
			showCache.delete(key)
		}
		throw error
	})
	showCache.set(key, tracked)
	return tracked
}

/**
 * One `/api/show` per model per endpoint, shared by everything that reads it.
 *
 * Family and image support are both properties of the model file and arrive in
 * the same response, so asking twice would put two waits on the session-start
 * path for one answer. The promise is cached rather than its result, so
 * concurrent readers join the request in flight instead of racing it.
 *
 * This is the soft form, for callers whose answer is a nicety: a prompt-template
 * family, the placeholder text in a settings field. One attempt, and nothing on
 * failure. A settings panel opened while Ollama is down must not sit through a
 * retry ladder to end up showing what it would have shown anyway.
 */
function fetchOllamaModelInfo(endpoint: string, modelId: string): Promise<unknown | undefined> {
	const key = cacheKey(endpoint, modelId)
	const cached = showCache.get(key)
	if (cached) {
		return cached
	}
	return cacheShowResult(
		key,
		attemptShow(endpoint, modelId, SHOW_FAST_TIMEOUT_MS).catch((error: unknown) => {
			// Not running, not reachable, model deleted: all the same answer here.
			Logger.log(
				`[Ollama] Could not read /api/show for ${modelId}: ${error instanceof Error ? error.message : String(error)}`,
			)
			return undefined
		}),
	)
}

/**
 * The same lookup, for callers a session cannot start without.
 *
 * Context window, image support and think budget are not niceties: each one
 * falls back to a guess, and a guessed context window has already broken
 * auto-compaction in this fork twice. Measured live, a single two-second
 * attempt lost the answer to an Ollama that was merely busy loading, and the
 * session went ahead on defaults. Ollama is local and it recovers, so this
 * waits for it -- and if it never answers, the session fails rather than
 * starting on values nobody chose.
 */
function requireOllamaModelInfo(endpoint: string, modelId: string): Promise<unknown> {
	const key = cacheKey(endpoint, modelId)
	const cached = showCache.get(key)
	if (cached) {
		return cached.then((info) => {
			if (info === undefined) {
				// A soft caller got here first and accepted nothing. That is not an
				// answer for this caller, so ask properly.
				showCache.delete(key)
				return requireOllamaModelInfo(endpoint, modelId)
			}
			return info
		})
	}
	const failedAt = showFailedAt.get(key)
	if (failedAt !== undefined && Date.now() - failedAt < SHOW_FAILURE_COOLDOWN_MS) {
		return Promise.reject(new OllamaModelInfoUnavailableError(modelId, SHOW_MAX_ATTEMPTS, "no answer, still cooling down"))
	}
	showFailedAt.delete(key)
	const request = (async () => {
		let lastError = "unknown error"
		let warned = false
		for (let attempt = 1; attempt <= SHOW_MAX_ATTEMPTS; attempt++) {
			try {
				const info = await attemptShow(endpoint, modelId, showAttemptTimeoutMs(attempt))
				if (attempt > 1) {
					Logger.log(`[Ollama] /api/show for ${modelId} answered on attempt ${attempt}`)
				}
				return info
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error)
				if (attempt >= SHOW_MAX_ATTEMPTS) {
					break
				}
				// Said once, at the point where the wait stops being invisible.
				if (attempt >= SHOW_FAST_ATTEMPTS && !warned) {
					warned = true
					Logger.log(`[Ollama] /api/show for ${modelId} has timed out ${attempt} times (${lastError}); still retrying`)
					void Promise.resolve(
						HostProvider.window.showMessage({
							type: ShowMessageType.WARNING,
							message: `Ollama is not answering /api/show for "${modelId}" (${lastError}). Still retrying — Cerebriline needs the model's own settings before it can start a session.`,
						}),
					).catch(() => undefined)
				}
				await delay(showRetryDelayMs(attempt))
			}
		}
		Logger.log(`[Ollama] Gave up on /api/show for ${modelId} after ${SHOW_MAX_ATTEMPTS} attempts: ${lastError}`)
		showFailedAt.set(key, Date.now())
		throw new OllamaModelInfoUnavailableError(modelId, SHOW_MAX_ATTEMPTS, lastError)
	})()
	return cacheShowResult(key, request) as Promise<unknown>
}

/**
 * Whether Ollama says this model can read images.
 *
 * Worth asking, because the alternative is a guess. Image support otherwise
 * comes from the model catalog, and a local or newly published model has no
 * catalog entry; the default there is optimistic, which is what keeps local
 * vision models working and is also how a screenshot once reached a model that
 * could not read one. Ollama knows — `/api/show` reports `capabilities`, with
 * `vision` among them — so for this provider the answer is available rather
 * than assumed, and the tools that attach images can be told not to.
 *
 * Returns undefined when the server did not say, which leaves it a guess.
 */
export async function resolveOllamaImageSupport(baseUrl: string | undefined, modelId: string): Promise<boolean | undefined> {
	const trimmedModel = modelId.trim()
	const endpoint = baseUrl?.trim() || DEFAULT_OLLAMA_BASE_URL
	if (trimmedModel === "" || !URL.canParse(endpoint)) {
		return undefined
	}
	return readImageSupport(await requireOllamaModelInfo(endpoint, trimmedModel))
}

/**
 * The same answer for a settings panel: one attempt, and `undefined` when the
 * server is not there to ask. A list of profiles must not wait out the ladder a
 * session start is entitled to.
 */
export async function peekOllamaImageSupport(baseUrl: string | undefined, modelId: string): Promise<boolean | undefined> {
	const trimmedModel = modelId.trim()
	const endpoint = baseUrl?.trim() || DEFAULT_OLLAMA_BASE_URL
	if (trimmedModel === "" || !URL.canParse(endpoint)) {
		return undefined
	}
	return readImageSupport(await fetchOllamaModelInfo(endpoint, trimmedModel))
}

/**
 * Whether Ollama says this model can call tools.
 *
 * Asked for the same reason as image support, and answered by the same cached
 * `/api/show` call: `capabilities` carries `tools` alongside `vision`. It
 * matters more than it looks. The runtime treats a *populated* capability list
 * without `tools` as an authoritative "cannot", and hands the model an empty
 * tool set — so writing a capability list for a local model without saying
 * anything about tools does not leave the question open, it answers it wrongly.
 *
 * Returns undefined when the server did not say, which leaves it a guess.
 */
export async function resolveOllamaToolSupport(baseUrl: string | undefined, modelId: string): Promise<boolean | undefined> {
	const trimmedModel = modelId.trim()
	const endpoint = baseUrl?.trim() || DEFAULT_OLLAMA_BASE_URL
	if (trimmedModel === "" || !URL.canParse(endpoint)) {
		return undefined
	}
	return readToolSupport(await requireOllamaModelInfo(endpoint, trimmedModel))
}

/**
 * The parameters a model's own Modelfile sets, keyed by Ollama's spelling.
 *
 * The settings panel leaves every sampling field blank and treats blank as "not
 * sent", so the model's own values stay in force — which is right, and gives
 * the user no way to see what those values are. A field showing "model default"
 * is telling them the model decides, without saying what it decided.
 *
 * `/api/show` reports them, and this is the same cached call that already runs
 * once per session, so asking costs nothing.
 *
 * Repeated parameters (`stop` is the usual one) are joined with newlines, which
 * is how the panel's own multi-line stop field is written.
 */
export async function resolveOllamaModelParameters(
	baseUrl: string | undefined,
	modelId: string,
): Promise<Record<string, string>> {
	const trimmedModel = modelId.trim()
	const endpoint = baseUrl?.trim() || DEFAULT_OLLAMA_BASE_URL
	if (trimmedModel === "" || !URL.canParse(endpoint)) {
		return {}
	}
	return readModelParameters(await fetchOllamaModelInfo(endpoint, trimmedModel))
}

/**
 * The thinking levels the model states, from `/api/show`'s `thinking` block.
 *
 * Only named levels are returned: `false` and `true` are the on/off switch the
 * panel's checkbox already is, so a model stating `[false, true]` -- gemma4 --
 * or nothing at all -- deepseek-r1 -- has no level to offer and gets an empty
 * list. The order is the server's. `default` is kept only when it is one of the
 * levels, so it can be named on the dropdown's Default entry.
 *
 * A level is the model's own control, handed to its template; it never bounds
 * the thinking. That is `think_budget`, a separate setting.
 */
export async function resolveOllamaModelThinkingLevels(
	baseUrl: string | undefined,
	modelId: string,
): Promise<{ values: string[]; default?: string }> {
	const trimmedModel = modelId.trim()
	const endpoint = baseUrl?.trim() || DEFAULT_OLLAMA_BASE_URL
	if (trimmedModel === "" || !URL.canParse(endpoint)) {
		return { values: [] }
	}
	return readThinkingLevels(await fetchOllamaModelInfo(endpoint, trimmedModel))
}

export function readThinkingLevels(payload: unknown): { values: string[]; default?: string } {
	const thinking = payload && typeof payload === "object" ? (payload as { thinking?: unknown }).thinking : undefined
	if (!thinking || typeof thinking !== "object") {
		return { values: [] }
	}
	const { values, default: fallback } = thinking as { values?: unknown; default?: unknown }
	const levels = Array.isArray(values)
		? values.filter((value): value is string => typeof value === "string" && value.trim() !== "")
		: []
	return {
		values: levels,
		...(typeof fallback === "string" && levels.includes(fallback) ? { default: fallback } : {}),
	}
}

/**
 * The context length this model actually runs with, according to Ollama.
 *
 * A local model is never in the catalog, so the runtime falls back to a guessed
 * window — and a guessed window is not a small error. Measured live: the guess
 * said 128,000 while `num_ctx` on the wire was 110,000, and the compaction
 * trigger, computed as 90% of the guess, landed at 115,200 — above the whole
 * real window. Auto-compaction could not fire at all, and every session ran
 * until its output cap collapsed.
 *
 * Ollama does not have to be guessed at. `num_ctx` in the Modelfile is what the
 * server will load, and the architecture's `context_length` is the ceiling that
 * allows. Preferring `num_ctx` matches what the model is actually running with
 * rather than what it could be asked to run with.
 */
export async function resolveOllamaContextWindow(baseUrl: string | undefined, modelId: string): Promise<number | undefined> {
	const trimmedModel = modelId.trim()
	const endpoint = baseUrl?.trim() || DEFAULT_OLLAMA_BASE_URL
	if (trimmedModel === "" || !URL.canParse(endpoint)) {
		return undefined
	}
	return readContextWindow(await requireOllamaModelInfo(endpoint, trimmedModel))
}

function readContextWindow(payload: unknown): number | undefined {
	if (!payload || typeof payload !== "object") {
		return undefined
	}
	const fromParameters = positiveInteger(readModelParameters(payload).num_ctx)
	if (fromParameters !== undefined) {
		return fromParameters
	}
	// `model_info` keys the ceiling under the architecture's own name, so the
	// architecture has to be read first to know what to ask for.
	const info = (payload as { model_info?: unknown }).model_info
	if (!info || typeof info !== "object") {
		return undefined
	}
	const record = info as Record<string, unknown>
	const architecture = record["general.architecture"]
	if (typeof architecture !== "string" || architecture.trim() === "") {
		return undefined
	}
	return positiveInteger(record[`${architecture}.context_length`])
}

function positiveInteger(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim())
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}

function readModelParameters(payload: unknown): Record<string, string> {
	if (!payload || typeof payload !== "object") {
		return {}
	}
	const raw = (payload as { parameters?: unknown }).parameters
	if (typeof raw !== "string" || raw.trim() === "") {
		return {}
	}
	const collected = new Map<string, string[]>()
	for (const line of raw.split("\n")) {
		// `name` then whitespace then the value: `temperature   0.7`. The value
		// may itself contain spaces, and is quoted when it does.
		const match = /^\s*(\S+)\s+(.*\S)\s*$/.exec(line)
		if (!match) {
			continue
		}
		const [, name, value] = match
		const quoted = /^"(.*)"$/.exec(value)
		const existing = collected.get(name) ?? []
		existing.push(quoted ? unescapeModelfileValue(quoted[1]) : value)
		collected.set(name, existing)
	}
	const parameters: Record<string, string> = {}
	for (const [name, values] of collected) {
		parameters[name] = values.join("\n")
	}
	return parameters
}

/**
 * A quoted Modelfile value carries its newlines as escapes.
 *
 * Measured on `v7-coder_tb:vision-iq4_nl`, whose `think_budget_message` is three
 * paragraphs written as one line of `\n` sequences. Left as-is the value reads
 * as literal backslashes wherever it is shown.
 */
function unescapeModelfileValue(value: string): string {
	return value.replace(/\\(.)/g, (_match, char: string) => {
		switch (char) {
			case "n":
				return "\n"
			case "t":
				return "\t"
			case "r":
				return "\r"
			default:
				// Covers `\"` and `\\`; anything else was not an escape to begin
				// with, and is left as the character it is.
				return char
		}
	})
}

function readImageSupport(payload: unknown): boolean | undefined {
	// Older servers answer without the field at all. Absent is not "no": it
	// means this server cannot tell us, and a guess stays a guess.
	const named = readCapabilityNames(payload)
	return named === undefined ? undefined : named.some((entry) => entry === "vision" || entry === "image")
}

function readToolSupport(payload: unknown): boolean | undefined {
	const named = readCapabilityNames(payload)
	return named === undefined ? undefined : named.includes("tools")
}

function readCapabilityNames(payload: unknown): string[] | undefined {
	if (!payload || typeof payload !== "object") {
		return undefined
	}
	const capabilities = (payload as { capabilities?: unknown }).capabilities
	if (!Array.isArray(capabilities)) {
		return undefined
	}
	const named = capabilities.filter((entry): entry is string => typeof entry === "string")
	return named.length === 0 ? undefined : named
}

function readFamily(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object") {
		return undefined
	}
	const details = (payload as { details?: unknown }).details
	if (details && typeof details === "object") {
		const family = (details as { family?: unknown }).family
		if (typeof family === "string" && family.trim() !== "") {
			return family.trim()
		}
	}
	// Older Ollama builds answered without a `details` block but still carried
	// the architecture in model_info, which is where `details.family` comes
	// from anyway.
	const modelInfo = (payload as { model_info?: unknown }).model_info
	if (modelInfo && typeof modelInfo === "object") {
		const architecture = (modelInfo as Record<string, unknown>)["general.architecture"]
		if (typeof architecture === "string" && architecture.trim() !== "") {
			return architecture.trim()
		}
	}
	return undefined
}

export async function resolveOllamaModelFamily(baseUrl: string | undefined, modelId: string): Promise<string | undefined> {
	const trimmedModel = modelId.trim()
	const endpoint = baseUrl?.trim() || DEFAULT_OLLAMA_BASE_URL
	if (trimmedModel === "" || !URL.canParse(endpoint)) {
		return undefined
	}

	return readFamily(await fetchOllamaModelInfo(endpoint, trimmedModel))
}

/**
 * Ask Ollama what will bound this model's thinking.
 *
 * The budget is a share of the room the response has, resolved server-side, so
 * a level names a different number on every request; a model can also carry a
 * `think_budget` parameter the caller never set. Deriving the figure here would
 * mean keeping a copy of Ollama's fraction table in step with the server's, and
 * a stale copy is worse than no figure at all — it would state a bound in the
 * system prompt that the model is not actually held to.
 *
 * So the server is asked instead. `/api/show` takes the think value and the
 * options the session will send and answers with both halves: `think_budget`,
 * the budget in the form it was written, and `think_budget_tokens`, what it
 * resolves to. Older servers answer neither, and then nothing is reported.
 */
export interface OllamaThinkBudget {
	/** The level or count that applied, as the server reported it. */
	level: string
	/** What it resolved to, in tokens. */
	budgetTokens: number
}

export interface OllamaThinkBudgetQuery {
	/** The think value the session will send, when it sets one. */
	think?: string
	/** The `think_budget` the session will send, when it sets one. */
	thinkBudget?: string
	/** The per-turn response cap, as `num_predict`. */
	numPredict?: number
	/** The context window, as `num_ctx`. */
	numCtx?: number
}

function readThinkBudget(payload: unknown): OllamaThinkBudget | undefined {
	if (!payload || typeof payload !== "object") {
		return undefined
	}
	const record = payload as { think_budget?: unknown; think_budget_tokens?: unknown }
	const tokens = record.think_budget_tokens
	if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) {
		return undefined
	}
	// The label is a level or a count, and arrives as whichever was written.
	const raw = record.think_budget
	const level = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : ""
	return { level: level || "unspecified", budgetTokens: Math.floor(tokens) }
}

export async function resolveOllamaThinkBudget(
	baseUrl: string | undefined,
	modelId: string,
	query: OllamaThinkBudgetQuery = {},
): Promise<OllamaThinkBudget | undefined> {
	const trimmedModel = modelId.trim()
	const endpoint = baseUrl?.trim() || DEFAULT_OLLAMA_BASE_URL
	if (trimmedModel === "" || !URL.canParse(endpoint)) {
		return undefined
	}

	const options: Record<string, number | string> = {}
	const thinkBudget = query.thinkBudget?.trim()
	if (thinkBudget) {
		// A count goes as a number, the form every think-budget build reads.
		options.think_budget = /^\d+$/.test(thinkBudget) ? Number(thinkBudget) : thinkBudget
	}
	if (typeof query.numPredict === "number" && Number.isFinite(query.numPredict) && query.numPredict > 0) {
		options.num_predict = Math.floor(query.numPredict)
	}
	if (typeof query.numCtx === "number" && Number.isFinite(query.numCtx) && query.numCtx > 0) {
		options.num_ctx = Math.floor(query.numCtx)
	}

	const body = JSON.stringify({
		model: trimmedModel,
		...(query.think ? { think: query.think } : {}),
		...(Object.keys(options).length > 0 ? { options } : {}),
	})

	// Retried like the other `/api/show` reads, because a busy Ollama loses a
	// single two-second attempt the same way here. Not demanded like them: this
	// call carries the session's own options, so it is never the first thing
	// asked, and a server that has already answered once is answering. A build
	// too old to report a budget answers 200 with neither field, which is a
	// legitimate "nothing to report" -- so exhausting the ladder still means
	// saying nothing rather than stating a bound the model is not held to.
	let lastError = "unknown error"
	for (let attempt = 1; attempt <= SHOW_MAX_ATTEMPTS; attempt++) {
		try {
			const response = await fetch(`${endpoint.replace(/\/+$/, "")}/api/show`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
				signal: AbortSignal.timeout(showAttemptTimeoutMs(attempt)),
			})
			if (!response.ok) {
				throw new Error(`/api/show returned ${response.status}`)
			}
			return readThinkBudget(await response.json())
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error)
			if (attempt >= SHOW_MAX_ATTEMPTS) {
				break
			}
			await delay(showRetryDelayMs(attempt))
		}
	}
	// Not running, older build, model deleted: all the same answer here —
	// say nothing rather than guess a bound.
	Logger.log(`[SessionFactory] Could not read the Ollama think budget for ${trimmedModel}: ${lastError}`)
	return undefined
}

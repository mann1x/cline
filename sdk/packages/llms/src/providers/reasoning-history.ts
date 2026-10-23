import {
	nativeReasoningHistoryPlan,
	type ReasoningHistoryMode,
	type ReasoningHistoryPlan,
	type ReasoningHistorySetting,
} from "@cline/shared";

/**
 * Whether prior assistant reasoning can reach this endpoint, and whether the
 * endpoint puts it back into the prompt.
 *
 * Two separate questions, and both have to be yes.
 *
 * **Nothing here is decided from a name.** Not the provider id, not the
 * renderer, not the model. Engines change their renderers and their chat
 * templates between releases, and a table of names that says "qwen3.5
 * re-injects" is only true until the next build -- at which point it fails
 * silently and in the expensive direction, because the estimator measures with
 * the same answer. Both probes below ask the server what it actually does with
 * a conversation that contains reasoning, and believe only the result.
 *
 * Measured 2026-09-18 against a live ollama on solidPC (`qwen3.5:2b`,
 * `/api/chat`, `num_predict 1`) -- the same three messages cost:
 *
 *   48 prompt tokens with no `thinking` field
 *  929 prompt tokens with 2,800 characters of `thinking`
 *
 * and with the assistant message placed *before* the last user turn, 31 tokens
 * either way. So the answer depends on the shape of the conversation and on
 * `think` being set, which is exactly why it is measured rather than declared.
 */
export interface ReasoningReinjection {
	/** How prior reasoning can be carried, if at all. */
	channel: "native-thinking" | "reasoning-content" | "none";
	/**
	 * Whether the server renders it back into the prompt. `undefined` means
	 * nobody has been able to ask yet -- which is not the same as `false`, but
	 * is treated the same way until it is answered.
	 */
	reinjects: boolean | undefined;
	/** What the probe actually saw, for the log and the settings panel. */
	detail?: string;
	/**
	 * Whether the template keeps a tool call's reasoning past a later user
	 * message when asked to with `chat_template_kwargs.preserve_thinking`
	 * (Gemma-4's official template, Qwen 3.6's). Measured on `/apply-template`
	 * only. `true` only where the flag is what makes the difference, so it is
	 * never sent to a template that ignores it or keeps the reasoning anyway.
	 */
	preservesThinking?: boolean;
}

/** A needle no chat template would emit on its own. */
const REINJECTION_NEEDLE = "CLINE-REINJECTION-PROBE-8F2A";

/**
 * Repeats of the needle in the ollama probe.
 *
 * Long enough that the prompt-token delta cannot be tokenizer boundary noise,
 * short enough that the probe's own prompt eval is trivial.
 */
const OLLAMA_PROBE_REPEATS = 24;

/** Prompt-token growth below this is noise, not a re-injected block. */
const REINJECTION_TOKEN_FLOOR = 8;

const reinjection = new Map<string, ReasoningReinjection>();

/**
 * The probe still running for a key. Its answer is cached only when it ends,
 * and the first one can sit through a model load: two sessions started 18
 * seconds apart on pandorum each sent their own pair (2026-10-22).
 */
const reinjectionInFlight = new Map<string, Promise<void>>();

/**
 * Keyed by the server, not by how its URL was written. The probe is handed
 * the vendor's normalized URL (opencoti always ends in `/v1`) and the request
 * path reads the one the host configured, which may not; keyed on the raw
 * string, a measured answer was never found again.
 */
function cacheKey(baseUrl: string | undefined, modelId: string): string {
	return `${baseUrl ? serverRoot(baseUrl) : "default"}::${modelId}`;
}

function root(baseUrl: string | undefined): string {
	return (baseUrl ?? "").replace(/\/+$/, "");
}

/**
 * The server's own root: the configured URL without the API prefix a client
 * library adds. llama-server serves `/apply-template` there and nowhere else
 * (tools/server/server.cpp), so the probe posted to `<host>/v1/apply-template`
 * got a 404 on every opencoti session and left `auto` at "none". Same rule as
 * `polykvRoot`, restated here because the vendors import this module.
 */
function serverRoot(baseUrl: string | undefined): string {
	return root(baseUrl).replace(/\/(?:v1|api)$/, "");
}

/**
 * Ollama's API root for a configured base URL: the origin, then `/api` once.
 *
 * The probe is handed the URL as configured, which is usually a bare origin
 * (`http://host:11434`), so `root()` alone posted to `<origin>/chat`. Ollama
 * answers that with a 404, and the probe measured nothing on any host,
 * leaving every Ollama model at "unproven". This is the same rule as the
 * vendor's `normalizeOllamaBaseUrl`, restated here because that module
 * imports this one.
 */
function ollamaApiRoot(baseUrl: string | undefined): string {
	return `${serverRoot(baseUrl)}/api`;
}

/**
 * What was measured for this endpoint and model, if anything.
 *
 * Synchronous on purpose. The compaction pipeline has to measure the request
 * the gateway is about to send and cannot await a probe mid-decision, so the
 * probe fills this map and every later reader is a lookup. Same shape as the
 * `declaredNumCtx` cache the ollama vendor already keeps.
 */
export function cachedReinjection(
	baseUrl: string | undefined,
	modelId: string,
): ReasoningReinjection | undefined {
	return reinjection.get(cacheKey(baseUrl, modelId));
}

export function resetReasoningReinjection(): void {
	reinjection.clear();
	reinjectionInFlight.clear();
}

/**
 * What `auto` means once the capability is known.
 *
 * Never "all", even when the server is proven to re-inject. Ollama's qwen3.5
 * renderer re-renders every assistant think block after the *last user turn*,
 * and an agent run has exactly one user message -- so "all" renders the whole
 * accumulated thinking history into every prompt. Run 20260918-022626-0367
 * produced 413,766 characters of reasoning in 50 turns, against a 48k window.
 *
 * "last" is the bounded form: the model gets its most recent reasoning and the
 * prompt does not grow without limit.
 *
 * Unproven is treated as "do not send". Sending reasoning to a server that
 * ignores it costs no prompt tokens, but the estimator measures with this same
 * mode, so it would count characters that never became any -- the 2.23x
 * overstatement that shrank an output cap to 32,000 on a 262,144 window.
 */
export function autoReasoningHistoryMode(
	capability: ReasoningReinjection | undefined,
	unprobed: ReasoningHistoryMode = "none",
): ReasoningHistoryMode {
	if (!capability) {
		// Nothing measured, because nothing here can measure this provider. A
		// hosted API is not a local engine whose template we can render: the
		// Anthropic and OpenAI wire formats specify reasoning replay, and
		// Anthropic *requires* the signed thinking blocks back for tool use, so
		// `auto` must leave those exactly as they were. `unprobed` is that
		// standing behaviour, not a guess about the server.
		return unprobed;
	}
	if (capability.channel === "none") {
		return "none";
	}
	return capability.reinjects === true ? "last" : "none";
}

/**
 * Measure whether ollama re-renders `thinking` into the prompt, by asking it.
 *
 * Ollama serves no template-rendering endpoint, so the prompt itself cannot be
 * read back. What can be read back is its length: `/api/chat` reports
 * `prompt_eval_count`, so sending the same conversation twice -- once with a
 * `thinking` field and once without -- measures the re-injection directly, in
 * the engine's own tokens, with no knowledge of renderers or templates.
 *
 * The conversation is deliberately shaped like an agent turn (one user message
 * first, the assistant after it, a tool result last) because that shape is what
 * decides the answer: with a user message last, the same probe returns equal
 * counts and the honest reading is "not in this conversation".
 *
 * `num_predict: 1` keeps generation to a single token; the cost is one prompt
 * eval of a handful of tokens. This does require the model to be loaded, which
 * is why it is called at first use rather than at settings time -- see
 * `probeOnFirstUse` at the call site. Nothing is inferred when the probe fails:
 * an unreachable server leaves the capability unproven, which sends nothing.
 */
export async function primeOllamaReinjection(
	baseUrl: string | undefined,
	modelId: string,
	fetchImpl: typeof fetch = fetch,
	/**
	 * Fields added to both requests. xOllama's window: the probe is usually the
	 * first request to reach the model, and the engine loads it at the size the
	 * probe asks for -- its own default when it asks for none, which the
	 * conversation's first turn then reloads.
	 */
	extraBody?: Readonly<Record<string, unknown>>,
): Promise<void> {
	const key = cacheKey(baseUrl, modelId);
	if (reinjection.has(key)) {
		return;
	}
	const running = reinjectionInFlight.get(key);
	if (running) {
		return running;
	}
	const probe = probeOllamaReinjection(
		key,
		baseUrl,
		modelId,
		fetchImpl,
		extraBody,
	).finally(() => {
		reinjectionInFlight.delete(key);
	});
	reinjectionInFlight.set(key, probe);
	return probe;
}

async function probeOllamaReinjection(
	key: string,
	baseUrl: string | undefined,
	modelId: string,
	fetchImpl: typeof fetch,
	extraBody: Readonly<Record<string, unknown>> | undefined,
): Promise<void> {
	const needle = `${REINJECTION_NEEDLE} `.repeat(OLLAMA_PROBE_REPEATS);
	const ask = async (
		thinking: string | undefined,
	): Promise<number | undefined> => {
		const assistant: Record<string, unknown> = {
			role: "assistant",
			content: "checking",
			tool_calls: [{ function: { name: "probe", arguments: {} } }],
		};
		if (thinking !== undefined) {
			assistant.thinking = thinking;
		}
		const response = await fetchImpl(`${ollamaApiRoot(baseUrl)}/chat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...(extraBody ?? {}),
				model: modelId,
				stream: false,
				think: true,
				options: { num_predict: 1 },
				messages: [
					{ role: "user", content: "probe" },
					assistant,
					{ role: "tool", content: "probe" },
				],
			}),
		});
		if (!response.ok) {
			return undefined;
		}
		const body = (await response.json()) as { prompt_eval_count?: number };
		return typeof body.prompt_eval_count === "number"
			? body.prompt_eval_count
			: undefined;
	};
	try {
		const without = await ask(undefined);
		const with_ = await ask(needle);
		if (without === undefined || with_ === undefined) {
			reinjection.set(key, {
				channel: "native-thinking",
				reinjects: undefined,
			});
			return;
		}
		const delta = with_ - without;
		reinjection.set(key, {
			channel: "native-thinking",
			reinjects: delta >= REINJECTION_TOKEN_FLOOR,
			detail: `prompt ${without} -> ${with_} tokens`,
		});
	} catch {
		reinjection.set(key, { channel: "native-thinking", reinjects: undefined });
	}
}

/**
 * Render a needle through the server's own chat template and look for it.
 *
 * The llama.cpp/opencoti probe, and the stronger of the two: `/apply-template`
 * returns the server's own formatted prompt, so "does this template re-inject
 * reasoning" is answered by reading the prompt rather than by measuring its
 * length. It is CPU-only and takes no slot, so it is safe to call while the
 * server is busy, and it costs no model load -- which is why this side can be
 * probed at settings time and ollama's cannot.
 *
 * Both field spellings go out because the two engines disagree and a template
 * reads whichever its author chose; the needle is what is looked for, not the
 * field.
 */
export async function primeTemplateReinjection(
	baseUrl: string | undefined,
	modelId: string,
	fetchImpl: typeof fetch = fetch,
	options: {
		/**
		 * Whether a refused or failed probe is recorded as "unproven". True for
		 * an engine that serves the route, where a refusal means the answer is
		 * unknown and nothing is sent. False for an endpoint that may not be
		 * llama-server at all: there the refusal says nothing about its
		 * template, and recording it would replace the provider's standing
		 * default (a hosted API's reasoning replay) with "none".
		 */
		recordRefusal?: boolean;
	} = {},
): Promise<void> {
	const key = cacheKey(baseUrl, modelId);
	if (reinjection.has(key)) {
		return;
	}
	const running = reinjectionInFlight.get(key);
	if (running) {
		return running;
	}
	const probe = probeTemplateReinjection(
		key,
		baseUrl,
		fetchImpl,
		options.recordRefusal ?? true,
	).finally(() => {
		reinjectionInFlight.delete(key);
	});
	reinjectionInFlight.set(key, probe);
	return probe;
}

/** The agent-run shape: one user message, a tool call carrying reasoning, its result. */
function agenticProbeMessages(): Array<Record<string, unknown>> {
	return [
		{ role: "user", content: "probe" },
		{
			role: "assistant",
			content: "",
			reasoning_content: REINJECTION_NEEDLE,
			thinking: REINJECTION_NEEDLE,
			tool_calls: [
				{
					id: "call_probe",
					type: "function",
					function: { name: "probe", arguments: "{}" },
				},
			],
		},
		{ role: "tool", tool_call_id: "call_probe", content: "probe" },
	];
}

const PROBE_TOOLS = [
	{
		type: "function",
		function: {
			name: "probe",
			description: "probe",
			parameters: { type: "object", properties: {} },
		},
	},
];

/** The server's rendering of `body`, or why there is none. */
async function renderTemplate(
	baseUrl: string | undefined,
	fetchImpl: typeof fetch,
	body: Record<string, unknown>,
): Promise<{ prompt: string } | { status: number }> {
	const response = await fetchImpl(`${serverRoot(baseUrl)}/apply-template`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const parsed = response.ok
		? ((await response.json().catch(() => undefined)) as
				| { prompt?: unknown }
				| undefined)
		: undefined;
	// Only a rendered prompt is an answer. A 200 with some other body is an
	// endpoint that is not llama-server, which is a refusal by another name.
	return typeof parsed?.prompt === "string"
		? { prompt: parsed.prompt }
		: { status: response.status };
}

async function probeTemplateReinjection(
	key: string,
	baseUrl: string | undefined,
	fetchImpl: typeof fetch,
	recordRefusal: boolean,
): Promise<void> {
	try {
		// The shape an agent run sends: one user message, then the model's
		// tool call carrying its reasoning, then the tool's result. Asked
		// with a user message *after* the reasoning, a template that keeps
		// reasoning only since the last user turn -- Gemma-4's official one
		// (ae53464b), qwen3's -- answers "drops", and this was the question
		// asked: Gemma was measured as dropping what it renders, and fell to
		// inlining, which breaks its turn structure (automaticum #1845).
		const rendered = await renderTemplate(baseUrl, fetchImpl, {
			messages: agenticProbeMessages(),
			tools: PROBE_TOOLS,
		});
		if (!("prompt" in rendered)) {
			if (recordRefusal) {
				reinjection.set(key, {
					channel: "reasoning-content",
					reinjects: undefined,
					detail: `/apply-template answered HTTP ${rendered.status}`,
				});
			}
			return;
		}
		const seen = rendered.prompt.includes(REINJECTION_NEEDLE);
		const preservesThinking = seen
			? await probePreserveThinking(baseUrl, fetchImpl)
			: undefined;
		reinjection.set(key, {
			channel: "reasoning-content",
			reinjects: seen,
			detail: seen
				? `template re-injects reasoning${
						preservesThinking
							? "; keeps it past a user message with preserve_thinking"
							: ""
					}`
				: "template drops reasoning",
			...(preservesThinking ? { preservesThinking } : {}),
		});
	} catch {
		if (recordRefusal) {
			reinjection.set(key, {
				channel: "reasoning-content",
				reinjects: undefined,
			});
		}
	}
}

/**
 * Whether `preserve_thinking` is what keeps a tool call's reasoning past a
 * later user message.
 *
 * The harness's own nudges are user messages, so on a template that keeps
 * reasoning only since the last user turn every nudge silently dropped the
 * reasoning before it (automaticum #1848). Two renderings of the same chain
 * with a user message after it: without the flag, and with it. Only "dropped
 * without, kept with" counts, so the flag is never sent where it changes
 * nothing. A failure is "no": the agentic answer above stands either way.
 */
async function probePreserveThinking(
	baseUrl: string | undefined,
	fetchImpl: typeof fetch,
): Promise<boolean> {
	const messages = [
		...agenticProbeMessages(),
		{ role: "user", content: "probe" },
	];
	try {
		const without = await renderTemplate(baseUrl, fetchImpl, {
			messages,
			tools: PROBE_TOOLS,
		});
		if (!("prompt" in without) || without.prompt.includes(REINJECTION_NEEDLE)) {
			return false;
		}
		const withFlag = await renderTemplate(baseUrl, fetchImpl, {
			messages,
			tools: PROBE_TOOLS,
			chat_template_kwargs: { preserve_thinking: true },
		});
		return "prompt" in withFlag && withFlag.prompt.includes(REINJECTION_NEEDLE);
	} catch {
		return false;
	}
}

/**
 * Whether to ask this endpoint's template for `preserve_thinking`: measured
 * to need it, and prior reasoning going out natively at all. Under `last` it
 * still carries one block, so the prompt stays bounded.
 */
export function shouldPreserveThinking(
	baseUrl: string | undefined,
	modelId: string,
	plan: ReasoningHistoryPlan,
): boolean {
	return (
		plan.channel === "native" &&
		plan.scope !== "none" &&
		cachedReinjection(baseUrl, modelId)?.preservesThinking === true
	);
}

/**
 * The mode the request path will use, from what the profile stored.
 *
 * An explicit choice always wins, including against the probe. The probe
 * describes the server as it is right now; an operator testing a template they
 * are about to change, or working around a probe that cannot run, has to be
 * able to override it or the setting is decoration. `auto` -- and an unset
 * value, which means the same -- defers to the measurement.
 */
export function resolveReasoningHistorySetting(
	setting: ReasoningHistorySetting | undefined,
	baseUrl: string | undefined,
	modelId: string,
	unprobed: ReasoningHistoryMode = "none",
): ReasoningHistoryMode {
	if (setting !== undefined && setting !== "auto") {
		return setting;
	}
	return autoReasoningHistoryMode(
		cachedReinjection(baseUrl, modelId),
		unprobed,
	);
}

/**
 * The same resolution, but saying how the reasoning travels as well as how much.
 *
 * `resolveReasoningHistorySetting` answers one question -- how much -- and its
 * answer for a server whose template drops the field is "none", which is
 * correct about the field and wrong about the model: the model then starts
 * every turn without the reasoning it produced in the last one.
 *
 * goose takes the other route in that case. It puts the block into the
 * assistant's own content, wrapped in `<think>`, because content is the one
 * thing every chat template renders. This resolver selects it only where the
 * evidence says the field is dead:
 *
 * - **measured, and the template drops it** -- inline. Nothing is lost by
 *   sending the field as well, but nothing is gained either, and the estimator
 *   would then count it twice.
 * - **measured, and the template renders it** -- native. Inlining on top would
 *   send the same thinking twice, once in each place.
 * - **no reasoning channel at all** -- inline, for the same reason as the
 *   first case.
 * - **never measured** -- native, at whatever the unprobed fallback is. The
 *   probe failing is not evidence that the field is dropped, and a hosted API
 *   that specifies reasoning replay must keep it.
 *
 * `allowInline` is the operator's switch over the whole fallback, on by
 * default. Off, this degrades exactly to the mode resolver.
 */
export function resolveReasoningHistoryPlan(
	setting: ReasoningHistorySetting | undefined,
	baseUrl: string | undefined,
	modelId: string,
	unprobed: ReasoningHistoryMode = "none",
	allowInline = true,
): ReasoningHistoryPlan {
	// An explicit choice is native by construction. Someone who picked Nothing
	// gets nothing by any route, and someone who picked Last or Everything asked
	// for the transport's own field.
	if (setting !== undefined && setting !== "auto") {
		return nativeReasoningHistoryPlan(setting);
	}
	const capability = cachedReinjection(baseUrl, modelId);
	const mode = autoReasoningHistoryMode(capability, unprobed);
	if (!allowInline || !capability) {
		return nativeReasoningHistoryPlan(mode);
	}
	const dropped =
		capability.channel === "none" || capability.reinjects === false;
	if (!dropped) {
		return nativeReasoningHistoryPlan(mode);
	}
	// Bounded the same way the native path is, and for the same reason: an agent
	// run has one user message, so "everything" means the whole accumulated
	// thinking history in every prompt. Inlining makes that cost unconditional
	// rather than dependent on a renderer, which makes it worse, not better.
	return { scope: "last", channel: "inline" };
}

/** The plan as data, with what decided it: for a host's record of the run. */
export interface ReasoningHistoryReport {
	/** What was asked for. Unset is `auto`. */
	setting: ReasoningHistorySetting;
	scope: ReasoningHistoryMode;
	channel: ReasoningHistoryPlan["channel"];
	/**
	 * - `set`: an explicit choice, which no probe overrides.
	 * - `measured`: `auto`, and the server answered the probe.
	 * - `unproven`: `auto`, the server was asked and gave no answer, so
	 *   nothing is sent.
	 * - `standing-default`: `auto`, and this endpoint is not probed (or not
	 *   yet: ollama's probe needs the model loaded and runs at the first
	 *   request), so the provider's long-standing behaviour holds.
	 */
	decidedBy: "set" | "measured" | "unproven" | "standing-default";
	inline: boolean;
	detail?: string;
}

export function reportReasoningHistoryPlan(
	setting: ReasoningHistorySetting | undefined,
	baseUrl: string | undefined,
	modelId: string,
	unprobed: ReasoningHistoryMode = "none",
	allowInline = true,
): ReasoningHistoryReport {
	const plan = resolveReasoningHistoryPlan(
		setting,
		baseUrl,
		modelId,
		unprobed,
		allowInline,
	);
	const base = {
		setting: setting ?? "auto",
		scope: plan.scope,
		channel: plan.channel,
		inline: allowInline,
	};
	if (setting !== undefined && setting !== "auto") {
		return { ...base, decidedBy: "set" };
	}
	const capability = cachedReinjection(baseUrl, modelId);
	if (!capability) {
		return { ...base, decidedBy: "standing-default" };
	}
	return {
		...base,
		decidedBy:
			capability.channel !== "none" && capability.reinjects === undefined
				? "unproven"
				: "measured",
		...(capability.detail ? { detail: capability.detail } : {}),
	};
}

/**
 * The plan in words, with what decided it, for the log.
 *
 * A run on pandorum (2026-10-12, session x8yap) stopped thinking at its sixth
 * turn and the first question was what `auto` had resolved to. Nothing said:
 * the answer was two probe requests in the server's log, 41 prompt tokens
 * without the field and 366 with it. This is that answer, written where the
 * request is built.
 */
export function describeReasoningHistoryPlan(
	setting: ReasoningHistorySetting | undefined,
	baseUrl: string | undefined,
	modelId: string,
	unprobed: ReasoningHistoryMode = "none",
	allowInline = true,
): string {
	const plan = resolveReasoningHistoryPlan(
		setting,
		baseUrl,
		modelId,
		unprobed,
		allowInline,
	);
	const what =
		plan.scope === "none"
			? "no prior reasoning"
			: `${plan.scope === "last" ? "the last reasoning block" : "all prior reasoning"} ${
					plan.channel === "inline"
						? "inlined into the reply text"
						: "in the reasoning field"
				}`;
	if (setting !== undefined && setting !== "auto") {
		return `${what} (set to "${setting}")`;
	}
	const capability = cachedReinjection(baseUrl, modelId);
	if (!capability) {
		return `${what} (automatic; this endpoint was not probed, standing default "${unprobed}")`;
	}
	const answer =
		capability.channel === "none"
			? "the endpoint has no reasoning channel"
			: capability.reinjects === true
				? "the probe saw reasoning rendered back into the prompt"
				: capability.reinjects === false
					? "the probe saw reasoning dropped from the prompt"
					: "the probe could not get an answer";
	return `${what} (automatic; ${answer}${capability.detail ? `: ${capability.detail}` : ""})`;
}

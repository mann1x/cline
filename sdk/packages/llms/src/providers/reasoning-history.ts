import type {
	ReasoningHistoryMode,
	ReasoningHistorySetting,
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

function cacheKey(baseUrl: string | undefined, modelId: string): string {
	return `${(baseUrl ?? "default").replace(/\/+$/, "")}::${modelId}`;
}

function root(baseUrl: string | undefined): string {
	return (baseUrl ?? "").replace(/\/+$/, "");
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
): Promise<void> {
	const key = cacheKey(baseUrl, modelId);
	if (reinjection.has(key)) {
		return;
	}
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
		const response = await fetchImpl(`${root(baseUrl)}/chat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
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
): Promise<void> {
	const key = cacheKey(baseUrl, modelId);
	if (reinjection.has(key)) {
		return;
	}
	try {
		const response = await fetchImpl(`${root(baseUrl)}/apply-template`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				messages: [
					{ role: "user", content: "probe" },
					{
						role: "assistant",
						content: "hi",
						reasoning_content: REINJECTION_NEEDLE,
						thinking: REINJECTION_NEEDLE,
					},
					{ role: "user", content: "probe" },
				],
			}),
		});
		if (!response.ok) {
			reinjection.set(key, {
				channel: "reasoning-content",
				reinjects: undefined,
			});
			return;
		}
		const body = (await response.json()) as { prompt?: string };
		const seen = (body.prompt ?? "").includes(REINJECTION_NEEDLE);
		reinjection.set(key, {
			channel: "reasoning-content",
			reinjects: seen,
			detail: seen
				? "template re-injects reasoning"
				: "template drops reasoning",
		});
	} catch {
		reinjection.set(key, {
			channel: "reasoning-content",
			reinjects: undefined,
		});
	}
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

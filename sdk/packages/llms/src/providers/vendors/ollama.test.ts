import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildOllamaSamplingOptions,
	buildOllamaStreamConfig,
	createOllamaProviderModule,
	hasOllamaNoStreamTimeoutDispatcher,
	normalizeOllamaBaseUrl,
	OLLAMA_DEFAULT_NUM_CTX,
	OLLAMA_DEFAULT_REASONING_EFFORT,
	OLLAMA_DEFAULT_TIMEOUT_MS,
	parseDeclaredNumCtx,
	primeDeclaredNumCtx,
	readOllamaNumCtx,
	readOllamaNumPredict,
	readOllamaTimeoutMs,
	resetDeclaredNumCtx,
	setOllamaFetch,
	setOllamaNoStreamTimeoutDispatcher,
	withOllamaResponseTimeout,
} from "./ollama";

const createOllamaMock = vi.hoisted(() => vi.fn());
const ollamaModelMock = vi.hoisted(() =>
	vi.fn((modelId: string, _settings?: unknown) => ({
		specificationVersion: "v4",
		provider: "ollama",
		modelId,
	})),
);

vi.mock("ollama-ai-provider-v2", () => ({
	createOllama: createOllamaMock,
}));

describe("normalizeOllamaBaseUrl", () => {
	// The provider appends bare paths (`/chat`), so the `/api` prefix has to be
	// part of the base URL. Returning an origin here is what sent every request
	// to `/chat` and got back a plain `404 page not found`.
	it("appends the /api prefix a bare origin is missing", () => {
		expect(normalizeOllamaBaseUrl("http://localhost:11434")).toBe(
			"http://localhost:11434/api",
		);
		expect(normalizeOllamaBaseUrl("https://ollama.com")).toBe(
			"https://ollama.com/api",
		);
	});

	it("replaces a legacy OpenAI-compat /v1 suffix", () => {
		expect(normalizeOllamaBaseUrl("http://localhost:11434/v1")).toBe(
			"http://localhost:11434/api",
		);
	});

	it("keeps a native-API /api suffix without doubling it", () => {
		expect(normalizeOllamaBaseUrl("http://localhost:11434/api")).toBe(
			"http://localhost:11434/api",
		);
	});

	it("strips trailing slashes", () => {
		expect(normalizeOllamaBaseUrl("http://localhost:11434/")).toBe(
			"http://localhost:11434/api",
		);
	});

	it("returns undefined for empty input", () => {
		expect(normalizeOllamaBaseUrl(undefined)).toBeUndefined();
		expect(normalizeOllamaBaseUrl("  ")).toBeUndefined();
	});
});

describe("readOllamaNumCtx", () => {
	it("reads the resolved model's context window", () => {
		expect(readOllamaNumCtx(context({ contextWindow: 500000 }))).toBe(500000);
	});

	it("falls back to maxInputTokens when contextWindow is absent", () => {
		expect(readOllamaNumCtx(context({ maxInputTokens: 128000 }))).toBe(128000);
	});

	it("falls back to the default for missing or invalid values", () => {
		expect(readOllamaNumCtx(context({}))).toBe(OLLAMA_DEFAULT_NUM_CTX);
		expect(readOllamaNumCtx(context({ contextWindow: 0 }))).toBe(
			OLLAMA_DEFAULT_NUM_CTX,
		);
		expect(readOllamaNumCtx(context({ contextWindow: -1 }))).toBe(
			OLLAMA_DEFAULT_NUM_CTX,
		);
	});
});

describe("the window the model declares for itself", () => {
	// Measured: a model whose Modelfile says `num_ctx 128000` loaded at
	// `runner.num_ctx=32768`, because sending the default overrode it.
	const SHOW_BODY = {
		parameters: [
			"num_ctx                        128000",
			"repeat_penalty                 1.1",
			'think_budget                   "medium"',
		].join("\n"),
	};

	function showFetch(body: unknown, ok = true) {
		return vi.fn(async () =>
			({
				ok,
				json: async () => body,
			}) as unknown as Response,
		) as unknown as typeof fetch;
	}

	/** A context that names the server it is talking to, as a real one does. */
	function contextAt(
		baseUrl: string | undefined,
		model: Record<string, unknown> = {},
	): GatewayProviderContext {
		return {
			...context(model),
			config: { baseUrl },
		} as unknown as GatewayProviderContext;
	}

	const LOCAL = "http://localhost:11434";

	beforeEach(() => {
		resetDeclaredNumCtx();
	});

	it("reads num_ctx out of the parameters block", () => {
		expect(parseDeclaredNumCtx(SHOW_BODY)).toBe(128000);
		expect(parseDeclaredNumCtx({ parameters: 'num_ctx "8192"' })).toBe(8192);
	});

	it("contributes nothing when the model declares no window", () => {
		expect(parseDeclaredNumCtx({ parameters: "temperature 0.7" })).toBeUndefined();
		expect(parseDeclaredNumCtx({})).toBeUndefined();
		expect(parseDeclaredNumCtx(undefined)).toBeUndefined();
		// `num_ctx` as part of another name must not match.
		expect(
			parseDeclaredNumCtx({ parameters: "num_ctx_override 4096" }),
		).toBeUndefined();
	});

	it("uses the declared window instead of the default", async () => {
		await primeDeclaredNumCtx(LOCAL, "minimax-m3:cloud", showFetch(SHOW_BODY));
		expect(readOllamaNumCtx(contextAt(LOCAL))).toBe(128000);
	});

	// The user's own setting is an instruction, not a guess, and outranks the
	// model's default exactly as it did before.
	it("still lets a configured window win", async () => {
		await primeDeclaredNumCtx(LOCAL, "minimax-m3:cloud", showFetch(SHOW_BODY));
		expect(readOllamaNumCtx(contextAt(LOCAL, { contextWindow: 110000 }))).toBe(
			110000,
		);
	});

	it("falls back unchanged when the server will not say", async () => {
		await primeDeclaredNumCtx(LOCAL, "minimax-m3:cloud", showFetch({}, false));
		expect(readOllamaNumCtx(contextAt(LOCAL))).toBe(OLLAMA_DEFAULT_NUM_CTX);
	});

	it("survives a server that is not there at all", async () => {
		const failing = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		await expect(
			primeDeclaredNumCtx(LOCAL, "minimax-m3:cloud", failing),
		).resolves.toBeUndefined();
		expect(readOllamaNumCtx(contextAt(LOCAL))).toBe(OLLAMA_DEFAULT_NUM_CTX);
	});

	it("asks once per model, however many sessions start", async () => {
		const fetchImpl = showFetch(SHOW_BODY);
		await primeDeclaredNumCtx(LOCAL, "a-model", fetchImpl);
		await primeDeclaredNumCtx(LOCAL, "a-model", fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	// Two servers can serve the same model name with different windows.
	it("keeps servers apart", async () => {
		await primeDeclaredNumCtx(LOCAL, "minimax-m3:cloud", showFetch(SHOW_BODY));
		await primeDeclaredNumCtx(
			"http://elsewhere:11434",
			"minimax-m3:cloud",
			showFetch({ parameters: "num_ctx 4096" }),
		);
		expect(readOllamaNumCtx(contextAt(LOCAL))).toBe(128000);
		expect(readOllamaNumCtx(contextAt("http://elsewhere:11434"))).toBe(4096);
	});
});

describe("readOllamaNumPredict", () => {
	it("reads the request's per-turn cap", () => {
		expect(readOllamaNumPredict({ maxTokens: 32000 }, context({}))).toBe(32000);
	});

	it("prefers the request cap over the model's catalog entry", () => {
		// The request cap is the number the system prompt states, so it is the
		// one the server has to be held to.
		expect(
			readOllamaNumPredict(
				{ maxTokens: 32000 },
				context({ maxOutputTokens: 8192 }),
			),
		).toBe(32000);
	});

	it("falls back to the model's output cap when the request carries none", () => {
		expect(
			readOllamaNumPredict({}, context({ maxOutputTokens: 8192 })),
		).toBe(8192);
	});

	it("returns undefined when neither is a usable number", () => {
		expect(readOllamaNumPredict({}, context({}))).toBeUndefined();
		expect(readOllamaNumPredict({ maxTokens: 0 }, context({}))).toBeUndefined();
		expect(
			readOllamaNumPredict({ maxTokens: -1 }, context({})),
		).toBeUndefined();
	});
});

describe("readOllamaTimeoutMs", () => {
	it("reads a configured timeout", () => {
		expect(readOllamaTimeoutMs(config({ timeoutMs: 180000 }))).toBe(180000);
	});

	it("falls back to the default for missing or invalid values", () => {
		expect(readOllamaTimeoutMs(config({}))).toBe(OLLAMA_DEFAULT_TIMEOUT_MS);
		expect(readOllamaTimeoutMs(config({ timeoutMs: 0 }))).toBe(
			OLLAMA_DEFAULT_TIMEOUT_MS,
		);
		expect(readOllamaTimeoutMs(config({ timeoutMs: -5 }))).toBe(
			OLLAMA_DEFAULT_TIMEOUT_MS,
		);
	});

	it("defaults to 5 minutes so model cold loads don't hit a timeout error", () => {
		// Ollama only sends response headers once the model is loaded, so the
		// response-start budget must cover a cold load (cline/cline#12829).
		expect(OLLAMA_DEFAULT_TIMEOUT_MS).toBe(300_000);
	});
});

describe("withOllamaResponseTimeout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// The wait for the first byte is no longer a stopwatch. Prefill at a large
	// context is minutes of silence on a healthy socket, and from the stream
	// alone that is indistinguishable from a dead server — so the stream is not
	// what decides. Each quiet interval asks the server, and only a server that
	// stops answering ends the request.
	it("aborts once the server has also stopped answering", async () => {
		const hangingFetch = ((input, init) => {
			if (String(input).endsWith("/api/ps")) {
				return Promise.reject(new Error("ECONNREFUSED"));
			}
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			});
		}) as typeof fetch;

		const wrapped = withOllamaResponseTimeout(hangingFetch, 1000);
		const pending = wrapped("http://localhost:11434/api/chat");
		const assertion = expect(pending).rejects.toThrow(
			"stopped answering health checks",
		);
		await vi.advanceTimersByTimeAsync(10_000);
		await assertion;
	});

	it("keeps waiting through a long prefill while the server answers", async () => {
		let probes = 0;
		const prefillingFetch = ((input, init) => {
			if (String(input).endsWith("/api/ps")) {
				probes += 1;
				return Promise.resolve(
					new Response(JSON.stringify({ models: [] }), { status: 200 }),
				);
			}
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			});
		}) as typeof fetch;

		const wrapped = withOllamaResponseTimeout(prefillingFetch, 1000);
		const pending = wrapped("http://localhost:11434/api/chat");
		let settled = false;
		void pending.catch(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(20_000);

		expect(probes).toBeGreaterThan(5);
		expect(settled).toBe(false);
	});

	it("does not abort once the response has started", async () => {
		let requestSignal: AbortSignal | undefined;
		const immediateFetch = (async (_input, init) => {
			requestSignal = init?.signal ?? undefined;
			return new Response("ok");
		}) as typeof fetch;

		const wrapped = withOllamaResponseTimeout(immediateFetch, 1000);
		const response = await wrapped("http://localhost:11434/api/chat");
		await vi.advanceTimersByTimeAsync(5000);

		expect(response.ok).toBe(true);
		// Timer was cleared on response start — streaming continues unaborted.
		expect(requestSignal?.aborted).toBe(false);
	});

	it("propagates upstream aborts", async () => {
		const hangingFetch = ((_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			})) as typeof fetch;

		const upstream = new AbortController();
		const wrapped = withOllamaResponseTimeout(hangingFetch, 60_000);
		const pending = wrapped("http://localhost:11434/api/chat", {
			signal: upstream.signal,
		});
		const assertion = expect(pending).rejects.toThrow("user cancelled");
		upstream.abort(new Error("user cancelled"));
		await assertion;
	});
});

describe("createOllamaProviderModule", () => {
	beforeEach(() => {
		createOllamaMock.mockReset();
		createOllamaMock.mockReturnValue({ chat: ollamaModelMock });
		ollamaModelMock.mockClear();
	});

	it("normalizes the base URL and passes the API key through", async () => {
		const provider = await createOllamaProviderModule(
			config({ baseUrl: "https://ollama.com/v1", apiKey: "ollama-key" }),
			context({}),
		);
		provider.model("minimax-m3:cloud");

		// This package takes auth through headers rather than an `apiKey` field.
		expect(createOllamaMock).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://ollama.com/api",
				headers: expect.objectContaining({
					Authorization: "Bearer ollama-key",
				}),
			}),
		);
		expect(ollamaModelMock).toHaveBeenCalledWith("minimax-m3:cloud");
	});

	// `num_ctx` and the sampler moved off the model and onto request-scoped
	// provider options — this package has no model-level options hook. They are
	// asserted where they are now built, in the provider-option rules; here the
	// model must be constructed with nothing but its id.
	it("constructs the model with no per-model options", async () => {
		const provider = await createOllamaProviderModule(
			config({}),
			context({ contextWindow: 65536 }),
		);
		provider.model("qwen3-coder:30b");

		expect(ollamaModelMock).toHaveBeenCalledWith("qwen3-coder:30b");
	});

	it("omits baseURL and apiKey for a default local server", async () => {
		await createOllamaProviderModule(config({}), context({}));

		const call = createOllamaMock.mock.calls[0][0];
		expect(call.baseURL).toBeUndefined();
		expect(call.apiKey).toBeUndefined();
	});
});

function config(
	overrides: Partial<GatewayResolvedProviderConfig>,
): GatewayResolvedProviderConfig {
	return {
		providerId: "ollama",
		...overrides,
	};
}

function context(model: Record<string, unknown> = {}): GatewayProviderContext {
	return {
		provider: {
			id: "ollama",
			name: "Ollama",
			defaultModelId: "",
			models: [],
		},
		model: {
			id: "minimax-m3:cloud",
			name: "minimax-m3:cloud",
			providerId: "ollama",
			...model,
		},
	} as unknown as GatewayProviderContext;
}

describe("buildOllamaSamplingOptions", () => {
	it("maps every parameter onto its Ollama wire name", () => {
		expect(
			buildOllamaSamplingOptions({
				temperature: 0.9,
				topK: 64,
				topP: 0.95,
				minP: 0.05,
				typicalP: 1,
				repeatLastN: 1024,
				repeatPenalty: 1.05,
				presencePenalty: 0.1,
				frequencyPenalty: 0.2,
				seed: 7,
				numPredict: -1,
				numKeep: 24,
				stop: ["</done>"],
				thinkBudget: "8192",
				thinkBudgetMessage: "answer now",
			}),
		).toEqual({
			temperature: 0.9,
			top_k: 64,
			top_p: 0.95,
			min_p: 0.05,
			typical_p: 1,
			repeat_last_n: 1024,
			repeat_penalty: 1.05,
			presence_penalty: 0.1,
			frequency_penalty: 0.2,
			seed: 7,
			num_predict: -1,
			num_keep: 24,
			stop: ["</done>"],
			think_budget: "8192",
			think_budget_message: "answer now",
		});
	});

	it("sends nothing for parameters the user did not set", () => {
		// The model's own Modelfile is the default, and it is usually one that
		// was measured. An unset field must not reach the wire as a zero.
		expect(buildOllamaSamplingOptions(undefined)).toEqual({});
		expect(buildOllamaSamplingOptions({})).toEqual({});
		expect(buildOllamaSamplingOptions({ stop: [], thinkBudget: "  " })).toEqual(
			{},
		);
	});

	it("keeps zero, which is a real setting", () => {
		expect(
			buildOllamaSamplingOptions({ temperature: 0, seed: 0, repeatLastN: 0 }),
		).toEqual({ temperature: 0, seed: 0, repeat_last_n: 0 });
	});

	it("drops values that are not finite", () => {
		expect(
			buildOllamaSamplingOptions({
				temperature: Number.NaN,
				topP: Number.POSITIVE_INFINITY,
			}),
		).toEqual({});
	});
});

describe("buildOllamaStreamConfig", () => {
	const context = {} as never;
	const base = {
		providerId: "ollama",
		modelId: "local-model",
		messages: [],
	} as never;

	function config(reasoning: unknown) {
		return buildOllamaStreamConfig(
			{ ...(base as object), reasoning } as never,
			context,
		);
	}

	it("names a level for a request that only asks for reasoning", () => {
		// the SDK vocabulary has no plain "on", and provider-default would
		// defer to a model setting this vendor deliberately does not set
		expect(config({ enabled: true }).reasoning).toBe(
			OLLAMA_DEFAULT_REASONING_EFFORT,
		);
	});

	it("leaves an explicit level alone", () => {
		expect(config({ enabled: true, effort: "low" }).reasoning).toBe("low");
		expect(config({ effort: "high" }).reasoning).toBe("high");
		expect(config({ effort: "max" }).reasoning).toBe("xhigh");
	});

	it("does not name a level for a request that asked for none", () => {
		expect(config({ enabled: false }).reasoning).toBe("none");
	});

	it("names a level when the request says nothing about reasoning", () => {
		// Repro for `think` never reaching the wire. An absent reasoning config
		// on this provider means "never asked", not "off": read as off, a
		// reasoning model runs with `think` unset, thinks into content anyway,
		// and leaves a thinking budget no level to derive a cap from. Measured
		// as a turn ending on the 32,000-token output limit at ~51k input, with
		// `think` absent from every logged request body.
		expect(config(undefined).reasoning).toBe(OLLAMA_DEFAULT_REASONING_EFFORT);
		expect(config({}).reasoning).toBe(OLLAMA_DEFAULT_REASONING_EFFORT);
	});

	it("passes the shared settings through untouched", () => {
		const built = buildOllamaStreamConfig(
			{ ...(base as object), maxTokens: 4096, temperature: 0.2 } as never,
			context,
		);
		expect(built.maxOutputTokens).toBe(4096);
		expect(built.temperature).toBe(0.2);
	});
});

describe("stream timeouts", () => {
	// Node's fetch is undici, which aborts a stream when no body chunk arrives
	// for `bodyTimeout` (5 min by default) — a bound on any single gap, not on
	// the response as a whole. Thinking is not the gap: Ollama streams reasoning
	// deltas, so a thinking model is sending. The gap is prompt prefill, which
	// happens after the headers are already out — observed ending live runs with
	// UND_ERR_BODY_TIMEOUT.
	it("passes the dispatcher through to the request", async () => {
		const seen: RequestInit[] = [];
		const baseFetch = (async (_input: unknown, init: RequestInit) => {
			seen.push(init);
			return new Response("ok");
		}) as unknown as typeof fetch;
		const dispatcher = { marker: true };

		const wrapped = withOllamaResponseTimeout(baseFetch, 1000, dispatcher);
		await wrapped("http://localhost:11434/api/chat");

		expect((seen[0] as { dispatcher?: unknown }).dispatcher).toBe(dispatcher);
	});

	it("omits the key entirely when there is no dispatcher", async () => {
		const seen: RequestInit[] = [];
		const baseFetch = (async (_input: unknown, init: RequestInit) => {
			seen.push(init);
			return new Response("ok");
		}) as unknown as typeof fetch;

		const wrapped = withOllamaResponseTimeout(baseFetch, 1000);
		await wrapped("http://localhost:11434/api/chat");

		expect("dispatcher" in (seen[0] as object)).toBe(false);
	});
});

describe("setOllamaNoStreamTimeoutDispatcher", () => {
	afterEach(() => {
		setOllamaNoStreamTimeoutDispatcher(undefined);
	});

	// The vendor's own lookup uses a variable specifier so no bundler can see
	// it — which is also why it finds nothing in a packaged extension, where
	// there is no `node_modules` to resolve against at runtime. It failed into
	// a silent catch for four releases while UND_ERR_BODY_TIMEOUT kept ending
	// runs. A host that has undici linked hands one in instead.
	it("reports whether a dispatcher is in force", () => {
		expect(hasOllamaNoStreamTimeoutDispatcher()).toBe(false);

		setOllamaNoStreamTimeoutDispatcher({ marker: true });

		expect(hasOllamaNoStreamTimeoutDispatcher()).toBe(true);
	});

	it("puts the injected dispatcher on the requests the provider makes", async () => {
		// End to end through the module, because the bug was never in the
		// wrapper — it was that nothing ever reached it.
		const injected = { marker: "injected" };
		setOllamaNoStreamTimeoutDispatcher(injected);

		createOllamaMock.mockReset();
		createOllamaMock.mockReturnValue({ chat: ollamaModelMock });
		const seen: RequestInit[] = [];
		const baseFetch = (async (_input: unknown, init: RequestInit) => {
			seen.push(init);
			return new Response("ok");
		}) as unknown as typeof fetch;

		await createOllamaProviderModule(
			config({ baseUrl: "http://localhost:11434", fetch: baseFetch }),
			context({}),
		);
		const passedFetch = createOllamaMock.mock.calls[0][0].fetch as typeof fetch;
		await passedFetch("http://localhost:11434/api/chat");

		expect((seen[0] as { dispatcher?: unknown }).dispatcher).toBe(injected);
	});

	it("prefers the fetch that honours the dispatcher over a supplied one", async () => {
		// `dispatcher` is undici's own extension to `RequestInit`, so a wrapper
		// that rebuilds the request from the fields it knows about drops it. A
		// caller-supplied fetch is exactly such a wrapper — installed for proxy
		// and CA config that a local Ollama endpoint does not go through — and
		// preferring it put undici's five-minute `headersTimeout` back on a
		// request the log had just called timeout-free. Measured: a 71,963-token
		// prompt whose prefill ran past that died 917 seconds later, three
		// attempts at 300 seconds, reported as a network fault.
		const injected = { marker: "injected" };
		setOllamaNoStreamTimeoutDispatcher(injected);

		const undiciSeen: RequestInit[] = [];
		const undiciFetch = (async (_input: unknown, init: RequestInit) => {
			undiciSeen.push(init);
			return new Response("ok");
		}) as unknown as typeof fetch;
		const suppliedSeen: RequestInit[] = [];
		const suppliedFetch = (async (_input: unknown, init: RequestInit) => {
			suppliedSeen.push(init);
			return new Response("ok");
		}) as unknown as typeof fetch;
		setOllamaFetch(undiciFetch);

		createOllamaMock.mockReset();
		createOllamaMock.mockReturnValue({ chat: ollamaModelMock });
		await createOllamaProviderModule(
			config({ baseUrl: "http://localhost:11434", fetch: suppliedFetch }),
			context({}),
		);
		const passedFetch = createOllamaMock.mock.calls[0][0].fetch as typeof fetch;
		await passedFetch("http://localhost:11434/api/chat");

		expect(undiciSeen).toHaveLength(1);
		expect(suppliedSeen).toHaveLength(0);
		expect((undiciSeen[0] as { dispatcher?: unknown }).dispatcher).toBe(
			injected,
		);

		setOllamaFetch(undefined as unknown as typeof fetch);
	});

	it("still uses the supplied fetch when there is no dispatcher to honour", async () => {
		// Without a dispatcher there is nothing for undici's fetch to carry, so
		// the host's routing decision stands.
		setOllamaNoStreamTimeoutDispatcher(undefined);
		const suppliedSeen: RequestInit[] = [];
		const suppliedFetch = (async (_input: unknown, init: RequestInit) => {
			suppliedSeen.push(init);
			return new Response("ok");
		}) as unknown as typeof fetch;

		createOllamaMock.mockReset();
		createOllamaMock.mockReturnValue({ chat: ollamaModelMock });
		await createOllamaProviderModule(
			config({ baseUrl: "http://localhost:11434", fetch: suppliedFetch }),
			context({}),
		);
		const passedFetch = createOllamaMock.mock.calls[0][0].fetch as typeof fetch;
		await passedFetch("http://localhost:11434/api/chat");

		expect(suppliedSeen).toHaveLength(1);
	});

	it("clears back to lookup when the injection is removed", () => {
		setOllamaNoStreamTimeoutDispatcher({ marker: true });
		setOllamaNoStreamTimeoutDispatcher(undefined);

		expect(hasOllamaNoStreamTimeoutDispatcher()).toBe(false);
	});
});

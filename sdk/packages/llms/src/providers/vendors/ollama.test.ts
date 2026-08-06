import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildOllamaSamplingOptions,
	buildOllamaStreamConfig,
	createOllamaProviderModule,
	normalizeOllamaBaseUrl,
	OLLAMA_DEFAULT_NUM_CTX,
	OLLAMA_DEFAULT_REASONING_EFFORT,
	OLLAMA_DEFAULT_TIMEOUT_MS,
	readOllamaNumCtx,
	readOllamaTimeoutMs,
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
	it("passes a bare origin through (the ollama client appends /api itself)", () => {
		expect(normalizeOllamaBaseUrl("http://localhost:11434")).toBe(
			"http://localhost:11434",
		);
		expect(normalizeOllamaBaseUrl("https://ollama.com")).toBe(
			"https://ollama.com",
		);
	});

	it("strips a legacy OpenAI-compat /v1 suffix", () => {
		expect(normalizeOllamaBaseUrl("http://localhost:11434/v1")).toBe(
			"http://localhost:11434",
		);
	});

	it("strips a native-API /api suffix", () => {
		expect(normalizeOllamaBaseUrl("http://localhost:11434/api")).toBe(
			"http://localhost:11434",
		);
	});

	it("strips trailing slashes", () => {
		expect(normalizeOllamaBaseUrl("http://localhost:11434/")).toBe(
			"http://localhost:11434",
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

	it("aborts when the response does not start within the timeout", async () => {
		const hangingFetch = ((_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			})) as typeof fetch;

		const wrapped = withOllamaResponseTimeout(hangingFetch, 1000);
		const pending = wrapped("http://localhost:11434/api/chat");
		const assertion = expect(pending).rejects.toThrow(
			"Ollama request timed out after 1 seconds",
		);
		await vi.advanceTimersByTimeAsync(1001);
		await assertion;
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
				baseURL: "https://ollama.com",
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

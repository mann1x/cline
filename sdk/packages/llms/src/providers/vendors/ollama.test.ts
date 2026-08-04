import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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

vi.mock("ai-sdk-ollama", () => ({
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
		createOllamaMock.mockReturnValue(ollamaModelMock);
		ollamaModelMock.mockClear();
	});

	it("normalizes the base URL and passes the API key through", async () => {
		const provider = await createOllamaProviderModule(
			config({ baseUrl: "https://ollama.com/v1", apiKey: "ollama-key" }),
			context({}),
		);
		provider.model("minimax-m3:cloud");

		expect(createOllamaMock).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://ollama.com",
				apiKey: "ollama-key",
			}),
		);
		expect(ollamaModelMock).toHaveBeenCalledWith(
			"minimax-m3:cloud",
			expect.anything(),
		);
	});

	it("requests num_ctx from the resolved model's context window", async () => {
		const provider = await createOllamaProviderModule(
			config({}),
			context({ contextWindow: 65536 }),
		);
		provider.model("qwen3-coder:30b");

		expect(ollamaModelMock).toHaveBeenCalledWith("qwen3-coder:30b", {
			options: { num_ctx: 65536 },
		});
	});

	it("requests the default num_ctx when the model has no context window", async () => {
		const provider = await createOllamaProviderModule(config({}), context({}));
		provider.model("llama3.1");

		expect(ollamaModelMock).toHaveBeenCalledWith("llama3.1", {
			options: { num_ctx: OLLAMA_DEFAULT_NUM_CTX },
		});
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

	it("expresses no preference when the request has none", () => {
		expect(config(undefined).reasoning).toBeUndefined();
		expect(config({}).reasoning).toBeUndefined();
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

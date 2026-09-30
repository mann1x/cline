import { describe, expect, it, vi } from "vitest";
import {
	applyOptionRanking,
	appraiseEscalation,
	createJevTool,
	describeOptionRanking,
	detectJevDialect,
	evaluateJev,
	JEV_TOOL_NAME,
	jevConfidence,
	listJevModels,
	OLLAMA_JEV_MAX_BODY_BYTES,
	rankQuestionOptions,
	readJevToolQuestions,
	resetJevDialectCache,
	resolveJevRoutes,
} from "./jev";

const endpoint = { apiKey: "sk-test", floor: 0.6, highStakesFloor: 0.85 };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function fetchReturning(...responses: Response[]) {
	const queue = [...responses];
	return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
		const next = queue.shift();
		if (!next) throw new Error("no more responses");
		return next;
	});
}

describe("evaluateJev", () => {
	it("posts the state, the model and the questions to /systemone with the key", async () => {
		const fetchImpl = fetchReturning(
			jsonResponse({
				model: "jev-1.13.0",
				answers: { a: { type: "noul", noul: 0.9 } },
			}),
		);
		const response = await evaluateJev(
			endpoint,
			{
				state: "hello",
				questions: { a: { type: "noul", instructions: "Is it?" } },
			},
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		expect(response.answers.a).toEqual({ type: "noul", noul: 0.9 });
		const [url, init] = fetchImpl.mock.calls[0] ?? [];
		expect(url).toBe("https://api.typesafe.ai/v1/systemone");
		expect((init?.headers as Record<string, string>).Authorization).toBe(
			"Bearer sk-test",
		);
		expect(JSON.parse(String(init?.body))).toEqual({
			state: "hello",
			model: "jev-latest",
			questions: { a: { type: "noul", instructions: "Is it?" } },
		});
	});

	it("retries a 429 and a 529, then succeeds", async () => {
		const fetchImpl = fetchReturning(
			new Response("slow down", { status: 429 }),
			new Response("busy", { status: 529 }),
			jsonResponse({ model: "m", answers: {} }),
		);
		const sleep = vi.fn(async () => {});
		await evaluateJev(
			endpoint,
			{ state: "s", questions: {} },
			{ fetchImpl: fetchImpl as unknown as typeof fetch, sleep },
		);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2);
	});

	it("does not retry a refused key, and says where the key is set", async () => {
		const fetchImpl = fetchReturning(new Response("no", { status: 401 }));
		await expect(
			evaluateJev(
				endpoint,
				{ state: "s", questions: {} },
				{ fetchImpl: fetchImpl as unknown as typeof fetch },
			),
		).rejects.toThrow(/Jev tab/);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});

describe("a custom endpoint", () => {
	const answer = () =>
		jsonResponse({
			model: "nimble",
			answers: { a: { type: "noul", noul: 0.9 } },
		});
	const version = () => jsonResponse({ version: "0.35.0" });

	it("takes a server root, its /v1 or the full path, and calls the same URL", () => {
		for (const typed of [
			"http://solidpc:11434",
			"http://solidpc:11434/",
			"http://solidpc:11434/v1",
			"http://solidpc:11434/v1/systemone",
		]) {
			expect(resolveJevRoutes(typed)).toEqual({
				systemone: "http://solidpc:11434/v1/systemone",
				models: "http://solidpc:11434/v1/models",
				root: "http://solidpc:11434",
				custom: true,
			});
		}
		expect(resolveJevRoutes("").custom).toBe(false);
		expect(
			resolveJevRoutes("https://api.typesafe.ai/v1/systemone").custom,
		).toBe(false);
	});

	it("never probes TypeSafe's own URL", async () => {
		const fetchImpl = fetchReturning();
		expect(
			await detectJevDialect(
				{},
				{ fetchImpl: fetchImpl as unknown as typeof fetch },
			),
		).toBe("typesafe");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("recognises Ollama by /api/version once, and remembers it", async () => {
		resetJevDialectCache();
		const fetchImpl = fetchReturning(
			version(),
			answer(),
			jsonResponse({
				model: "nimble",
				answers: {},
			}),
		);
		const target = { baseUrl: "http://ollama-a:11434", model: "nimble" };
		for (let i = 0; i < 2; i++) {
			await evaluateJev(
				target,
				{ state: "s", questions: {} },
				{ fetchImpl: fetchImpl as unknown as typeof fetch },
			);
		}
		const urls = fetchImpl.mock.calls.map(([url]) => String(url));
		expect(urls).toEqual([
			"http://ollama-a:11434/api/version",
			"http://ollama-a:11434/v1/systemone",
			"http://ollama-a:11434/v1/systemone",
		]);
	});

	it("sends no Authorization header without a key", async () => {
		const fetchImpl = fetchReturning(answer());
		await evaluateJev(
			{ baseUrl: "http://ollama-b:11434", dialect: "ollama", model: "nimble" },
			{ state: "s", questions: { a: { type: "noul", instructions: "?" } } },
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		const [, init] = fetchImpl.mock.calls[0] ?? [];
		expect(init?.headers).not.toHaveProperty("Authorization");
	});

	it("cuts the state to fit Ollama's 64 KiB, and leaves TypeSafe's alone", async () => {
		const big = { conversation: "é".repeat(60_000), goal: "x".repeat(20_000) };
		const questions = { a: { type: "noul" as const, instructions: "?" } };
		const ollama = fetchReturning(answer());
		await evaluateJev(
			{ baseUrl: "http://o:1", dialect: "ollama", model: "nimble" },
			{ state: big, questions },
			{ fetchImpl: ollama as unknown as typeof fetch },
		);
		const sent = String(ollama.mock.calls[0]?.[1]?.body);
		expect(new TextEncoder().encode(sent).length).toBeLessThanOrEqual(
			OLLAMA_JEV_MAX_BODY_BYTES,
		);
		expect(JSON.parse(sent).state.conversation).toContain("characters cut");

		const typesafe = fetchReturning(jsonResponse({ model: "m", answers: {} }));
		await evaluateJev(
			{ apiKey: "k" },
			{ state: big, questions },
			{ fetchImpl: typesafe as unknown as typeof fetch },
		);
		expect(JSON.parse(String(typesafe.mock.calls[0]?.[1]?.body)).state).toEqual(
			big,
		);
	});

	it("cuts the state to the model's window when Ollama says it is over, and remembers", async () => {
		resetJevDialectCache();
		const overflow = () =>
			jsonResponse(
				{
					error:
						"prompt 0 has 12215 tokens; expected 1–8194 (input is never truncated)",
				},
				400,
			);
		const fetchImpl = fetchReturning(overflow(), answer(), answer());
		const target = {
			baseUrl: "http://win:1",
			dialect: "ollama" as const,
			model: "nimble",
		};
		const request = {
			state: { conversation: "word ".repeat(9_000) },
			questions: { a: { type: "noul" as const, instructions: "?" } },
		};
		await evaluateJev(target, request, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		const sizes = fetchImpl.mock.calls.map(
			([, init]) => JSON.parse(String(init?.body)).state.conversation.length,
		);
		expect(sizes[1]).toBeLessThan(sizes[0] * (8194 / 12215));
		// The next call starts at the size that fitted, with no refusal first.
		await evaluateJev(target, request, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(
			JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body)).state.conversation
				.length,
		).toBe(sizes[1]);
	});

	it("refuses a choice over Ollama's 26 options before sending it", async () => {
		const fetchImpl = fetchReturning();
		const criteria = Object.fromEntries(
			Array.from({ length: 27 }, (_, i) => [`o${i}`, null]),
		);
		await expect(
			evaluateJev(
				{ baseUrl: "http://o:1", dialect: "ollama", model: "nimble" },
				{
					state: "s",
					questions: { pick: { type: "choice", instructions: "?", criteria } },
				},
				{ fetchImpl: fetchImpl as unknown as typeof fetch },
			),
		).rejects.toThrow(/at most 26/);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("words Ollama's refusals from its error body", async () => {
		const missing = fetchReturning(
			jsonResponse({ error: "model 'jev-latest' not found" }, 404),
		);
		await expect(
			evaluateJev(
				{ baseUrl: "http://o:1", dialect: "ollama" },
				{ state: "s", questions: {} },
				{ fetchImpl: missing as unknown as typeof fetch },
			),
		).rejects.toThrow(/no model "jev-latest".*nimble/);
		const bad = fetchReturning(
			jsonResponse({ error: "state must not be empty" }, 400),
		);
		await expect(
			evaluateJev(
				{ baseUrl: "http://o:1", dialect: "ollama", model: "nimble" },
				{ state: "s", questions: {} },
				{ fetchImpl: bad as unknown as typeof fetch },
			),
		).rejects.toThrow(/\(400\): state must not be empty$/);
	});
});

describe("listJevModels", () => {
	it("offers only Ollama's decision models", async () => {
		const fetchImpl = fetchReturning(
			jsonResponse({
				models: [
					{ name: "tev1:latest", capabilities: ["completion", "decision"] },
					{ name: "qwen3:8b", capabilities: ["completion", "tools"] },
					{ name: "nimble:latest", capabilities: ["decision"] },
				],
			}),
		);
		expect(
			await listJevModels(
				{ baseUrl: "http://o:1", dialect: "ollama" },
				{ fetchImpl: fetchImpl as unknown as typeof fetch },
			),
		).toEqual(["nimble:latest", "tev1:latest"]);
		expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://o:1/api/tags");
	});

	it("reads TypeSafe's list, and an OpenAI-shaped one, with the key", async () => {
		const typesafe = fetchReturning(
			jsonResponse({ models: [{ name: "jev-latest" }, { name: "jev-mini" }] }),
		);
		expect(
			await listJevModels(
				{ apiKey: "k" },
				{ fetchImpl: typesafe as unknown as typeof fetch },
			),
		).toEqual(["jev-latest", "jev-mini"]);
		const [url, init] = typesafe.mock.calls[0] ?? [];
		expect(url).toBe("https://api.typesafe.ai/v1/models");
		expect((init?.headers as Record<string, string>).Authorization).toBe(
			"Bearer k",
		);

		const other = fetchReturning(jsonResponse({ data: [{ id: "judge-1" }] }));
		expect(
			await listJevModels(
				{ baseUrl: "https://judge.example/v1", dialect: "typesafe" },
				{ fetchImpl: other as unknown as typeof fetch },
			),
		).toEqual(["judge-1"]);
	});

	it("is empty when the server cannot answer", async () => {
		const fetchImpl = fetchReturning(new Response("no", { status: 500 }));
		expect(
			await listJevModels(
				{ baseUrl: "http://o:1", dialect: "typesafe" },
				{ fetchImpl: fetchImpl as unknown as typeof fetch },
			),
		).toEqual([]);
	});
});

describe("jevConfidence", () => {
	it("reads a noul as the two-outcome confidence of its likelier side", () => {
		expect(jevConfidence({ type: "noul", noul: 0.5 })).toBe(0);
		expect(jevConfidence({ type: "noul", noul: 0.9 })).toBeCloseTo(0.8);
		expect(jevConfidence({ type: "noul", noul: 0.1 })).toBeCloseTo(0.8);
	});

	it("takes a choice's own confidence", () => {
		expect(
			jevConfidence({
				type: "choice",
				choice: "a",
				probabilities: { a: 0.9 },
				confidence: 0.81,
			}),
		).toBe(0.81);
	});
});

describe("applyOptionRanking", () => {
	it("recommends the top option above the floor and drops what is under 5%", () => {
		const ranked = applyOptionRanking(
			["Rewrite it", "Patch it", "Leave it"],
			{ "Rewrite it": 0.1, "Patch it": 0.87, "Leave it": 0.03 },
			0.8,
			0.6,
		);
		expect(ranked.options).toEqual(["Rewrite it", "Patch it (recommended)"]);
		expect(ranked.dropped).toEqual(["Leave it"]);
		expect(ranked.recommended).toBe("Patch it");
	});

	it("replaces the model's own mark rather than adding a second one", () => {
		const ranked = applyOptionRanking(
			["A (recommended)", "B"],
			{ A: 0.1, B: 0.9 },
			0.8,
			0.6,
		);
		expect(ranked.options).toEqual(["A", "B (recommended)"]);
	});

	it("recommends nothing under the floor, and strips the model's mark then too", () => {
		const ranked = applyOptionRanking(
			["A (recommended)", "B"],
			{ A: 0.55, B: 0.45 },
			0.1,
			0.6,
		);
		expect(ranked.options).toEqual(["A", "B"]);
		expect(ranked.recommended).toBeUndefined();
	});

	it("never leaves fewer than two options", () => {
		const ranked = applyOptionRanking(
			["A", "B", "C"],
			{ A: 0.98, B: 0.01, C: 0.01 },
			0.97,
			0.6,
		);
		expect(ranked.options).toHaveLength(2);
		expect(ranked.options[0]).toBe("A (recommended)");
	});

	it("words the scores and the dropped options for the user", () => {
		const text = describeOptionRanking(
			applyOptionRanking(
				["A", "B", "C"],
				{ A: 0.9, B: 0.08, C: 0.02 },
				0.8,
				0.6,
			),
		);
		expect(text).toContain("- A: 90%");
		expect(text).toContain("“C”");
	});
});

describe("rankQuestionOptions", () => {
	it("sends the options bare and asks one choice question", async () => {
		const fetchImpl = fetchReturning(
			jsonResponse({
				model: "m",
				answers: {
					preferred: {
						type: "choice",
						choice: "B",
						probabilities: { A: 0.2, B: 0.8 },
						confidence: 0.7,
					},
				},
			}),
		);
		const ranked = await rankQuestionOptions(
			endpoint,
			{
				conversation: "user: fix it",
				question: "Which?",
				options: ["A (recommended)", "B"],
			},
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
		expect(Object.keys(body.questions.preferred.criteria)).toEqual(["A", "B"]);
		expect(ranked.options).toEqual(["A", "B (recommended)"]);
	});
});

describe("appraiseEscalation", () => {
	it("returns a complexity line, a stuck line and the caveat", async () => {
		const fetchImpl = fetchReturning(
			jsonResponse({
				model: "m",
				answers: {
					complexity: {
						type: "score",
						score: 3.1,
						probabilities: {},
						confidence: 0.7,
					},
					stuck: { type: "noul", noul: 0.92 },
				},
			}),
		);
		const lines = await appraiseEscalation(
			endpoint,
			{ task: "port the renderer", reason: "tests keep failing" },
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		expect(lines[0]).toMatch(/complexity 3\.1 of 4 — Hard/);
		expect(lines[1]).toMatch(/92%/);
		expect(lines[2]).toMatch(/not a measurement/);
	});

	it("asks nothing when there is nothing to judge", async () => {
		const fetchImpl = fetchReturning();
		expect(
			await appraiseEscalation(
				endpoint,
				{},
				{ fetchImpl: fetchImpl as unknown as typeof fetch },
			),
		).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("readJevToolQuestions", () => {
	it("accepts the array as JSON text", () => {
		const read = readJevToolQuestions(
			'[{"id":"a","kind":"yes_no","question":"Is it?"}]',
		);
		expect("questions" in read && read.questions[0]?.id).toBe("a");
	});

	it("refuses a choice without enough options", () => {
		const read = readJevToolQuestions([
			{ id: "a", kind: "choice", question: "Which?", options: ["x"] },
		]);
		expect("error" in read && read.error).toMatch(/2 to 50/);
	});
});

describe("the jev tool", () => {
	it("reports confident and unsure answers against the floors", async () => {
		const fetchImpl = fetchReturning(
			jsonResponse({
				model: "jev-1.13.0",
				answers: {
					ambiguous: { type: "noul", noul: 0.05 },
					approach: {
						type: "choice",
						choice: "patch",
						probabilities: { patch: 0.6, rewrite: 0.4 },
						confidence: 0.2,
					},
					risky: { type: "noul", noul: 0.9 },
				},
			}),
		);
		const tool = createJevTool({
			getEndpoint: () => endpoint,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(tool.name).toBe(JEV_TOOL_NAME);
		const output = await tool.execute(
			{
				context: "The user asked to fix the build.",
				questions: [
					{
						id: "ambiguous",
						kind: "yes_no",
						question: "Is the request ambiguous?",
					},
					{
						id: "approach",
						kind: "choice",
						question: "Which?",
						options: ["patch", "rewrite"],
					},
					// 0.9 is 0.8 confident: clears 0.6, not the high-stakes 0.85.
					{ id: "risky", kind: "yes_no", question: "Safe?", high_stakes: true },
				],
			},
			{} as never,
		);
		expect(output).toContain("- ambiguous: no");
		expect(output).toContain("Unsure: approach, risky.");
	});

	it("explains a missing configuration instead of calling", async () => {
		const tool = createJevTool({ getEndpoint: () => undefined });
		const output = await tool.execute(
			{ context: "x", questions: [{ id: "a", kind: "yes_no", question: "?" }] },
			{} as never,
		);
		expect(output).toMatch(/not configured/);
	});
});

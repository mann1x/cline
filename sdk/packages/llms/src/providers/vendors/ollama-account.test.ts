import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	looksLikeCloudName,
	matchOllamaRecommendation,
	parseOllamaCatalog,
	parseOllamaRecommendations,
	parseOllamaWhoami,
	primeOllamaAccountStatus,
	readOllamaAccountStatus,
	readOllamaCloudFlag,
	readOllamaRecommendation,
	resetOllamaAccountStatus,
} from "./ollama-account";

/**
 * Every payload below is verbatim from a live server (ollama 0.34.x, the
 * reporter's own account), trimmed to the fields under test. Invented shapes
 * are what let the four bugs in the opencoti client pass their own suites.
 */

const TAGS = {
	models: [
		{
			name: "kimi-k2.6:cloud",
			model: "kimi-k2.6:cloud",
			remote_model: "kimi-k2.6",
			remote_host: "https://ollama.com:443",
			details: { family: "kimi-k2", families: ["kimi-k2"] },
			capabilities: ["vision", "thinking", "completion", "tools"],
		},
		{
			name: "glm-5.3-flash-tpl2:latest",
			model: "glm-5.3-flash-tpl2:latest",
			remote_model: "glm-5.3-flash",
			remote_host: "https://ollama.com:443",
			details: { family: "", families: null },
		},
		{
			name: "gemma4:31b",
			model: "gemma4:31b",
			details: { family: "gemma4", families: ["gemma4"] },
			capabilities: ["completion", "tools", "vision"],
		},
	],
};

const RECOMMENDATIONS = {
	recommendations: [
		{
			model: "glm-5.3-flash:cloud",
			description: "Fast reasoning for coding and agentic workloads",
			context_length: 1048576,
			max_output_tokens: 1048576,
			required_plan: "pro",
			thinking: { values: ["low", "high", "max"], default: "max" },
		},
		{
			model: "gemma4:31b-cloud",
			context_length: 262144,
			max_output_tokens: 262144,
			required_plan: "free",
			thinking: { values: [false, true], default: false },
		},
		{
			model: "gemma4:26b",
			context_length: 0,
			max_output_tokens: 0,
			vram_bytes: 19000000000,
			thinking: { values: [false, true], default: false },
		},
	],
};

const ME = {
	ID: "4241b994",
	Email: "someone@example.com",
	Name: "mannix",
	Plan: "pro",
};

describe("what /api/tags says about a model", () => {
	// The reported guess was that a cloud model reports no family. It does:
	// `kimi-k2.6:cloud` says `kimi-k2`. And a cloud model does not have to be
	// named like one -- both halves of the name-based test are wrong, on this
	// server, today.
	it("reads cloud from remote_host, not from the name or the family", () => {
		const catalog = parseOllamaCatalog(TAGS);

		const kimi = catalog.find((entry) => entry.name === "kimi-k2.6:cloud");
		expect(kimi?.cloud).toBe(true);
		expect(kimi?.family).toBe("kimi-k2");

		const templated = catalog.find(
			(entry) => entry.name === "glm-5.3-flash-tpl2:latest",
		);
		expect(templated?.cloud).toBe(true);
		expect(looksLikeCloudName("glm-5.3-flash-tpl2:latest")).toBe(false);

		expect(catalog.find((entry) => entry.name === "gemma4:31b")?.cloud).toBe(
			false,
		);
	});

	it("keeps the capabilities the server reports", () => {
		const kimi = parseOllamaCatalog(TAGS).find(
			(entry) => entry.name === "kimi-k2.6:cloud",
		);

		expect(kimi?.capabilities).toContain("thinking");
	});
});

describe("the recommendations list", () => {
	it("reads the plan, the window and the thinking settings", () => {
		const parsed = parseOllamaRecommendations(RECOMMENDATIONS);

		const flash = parsed.find((entry) => entry.model === "glm-5.3-flash:cloud");
		expect(flash).toMatchObject({
			requiredPlan: "pro",
			contextLength: 1048576,
			maxOutputTokens: 1048576,
			thinkingValues: ["low", "high", "max"],
			thinkingDefault: "max",
		});
	});

	// The wire mixes booleans and levels in one array. A parser that kept only
	// strings would report a model with an on/off switch as having no thinking
	// settings at all.
	it("names the boolean thinking settings rather than dropping them", () => {
		const gemma = parseOllamaRecommendations(RECOMMENDATIONS).find(
			(entry) => entry.model === "gemma4:31b-cloud",
		);

		expect(gemma?.thinkingValues).toEqual(["off", "on"]);
		expect(gemma?.thinkingDefault).toBe("off");
	});

	// A local recommendation sends zero, which means "the model decides".
	it("does not read a zero window as a window", () => {
		const local = parseOllamaRecommendations(RECOMMENDATIONS).find(
			(entry) => entry.model === "gemma4:26b",
		);

		expect(local?.contextLength).toBeUndefined();
		expect(local?.vramBytes).toBe(19000000000);
	});

	// A tag built FROM a cloud model keeps its own name; `remote_model` is what
	// says which model it is.
	it("matches a re-templated tag through its remote_model", () => {
		const found = matchOllamaRecommendation(
			parseOllamaRecommendations(RECOMMENDATIONS),
			{ name: "glm-5.3-flash-tpl2:latest", remoteModel: "glm-5.3-flash" },
		);

		expect(found?.model).toBe("glm-5.3-flash:cloud");
	});

	it("matches a local tag to the cloud recommendation of the same model", () => {
		const found = matchOllamaRecommendation(
			parseOllamaRecommendations(RECOMMENDATIONS),
			{ name: "gemma4:31b-cloud" },
		);

		expect(found?.requiredPlan).toBe("free");
	});
});

describe("the account", () => {
	it("reads the plan of a signed-in account", () => {
		expect(parseOllamaWhoami(200, ME)).toMatchObject({
			reachable: true,
			signedIn: true,
			name: "mannix",
			plan: "pro",
		});
	});

	// 401 is an answer: the server is there and nobody is signed in. It carries
	// the sign-in URL it computed, which is the one actionable thing on it.
	it("keeps the sign-in URL from a 401", () => {
		expect(
			parseOllamaWhoami(401, {
				error: "unauthorized",
				signin_url: "https://ollama.com/connect?name=x",
			}),
		).toMatchObject({
			reachable: true,
			signedIn: false,
			signinUrl: "https://ollama.com/connect?name=x",
		});
	});

	// 503 is "I could not check", which is not a verdict on the account -- and
	// rendering it as "not signed in" would send the user to sign in again.
	it("does not read a 503 as signed out", () => {
		expect(parseOllamaWhoami(503, { error: "account unavailable" })).toEqual({
			reachable: false,
			signedIn: false,
		});
	});
});

describe("reading a whole endpoint", () => {
	beforeEach(() => {
		resetOllamaAccountStatus();
	});

	function stub(overrides: Record<string, { status: number; body: unknown }>) {
		return vi.fn(async (url: string | URL | Request) => {
			const href = String(url);
			const key = Object.keys(overrides).find((path) => href.endsWith(path));
			const answer = key
				? overrides[key]
				: { status: 404, body: { error: "not found" } };
			return new Response(JSON.stringify(answer.body), {
				status: answer.status,
			});
		}) as unknown as typeof fetch;
	}

	it("reads all three endpoints off one base URL", async () => {
		const status = await readOllamaAccountStatus(
			"http://localhost:11434",
			stub({
				"/api/tags": { status: 200, body: TAGS },
				"/api/experimental/model-recommendations": {
					status: 200,
					body: RECOMMENDATIONS,
				},
				"/api/me": { status: 200, body: ME },
			}),
		);

		expect(status.reachable).toBe(true);
		expect(status.models).toHaveLength(3);
		expect(status.recommendations).toHaveLength(3);
		expect(status.account.plan).toBe("pro");
	});

	// The recommendations need no auth, so an account read that fails must not
	// take them with it -- that is the whole reason they are read separately.
	it("still reports models and recommendations when /api/me is refused", async () => {
		const status = await readOllamaAccountStatus(
			"http://localhost:11434",
			stub({
				"/api/tags": { status: 200, body: TAGS },
				"/api/experimental/model-recommendations": {
					status: 200,
					body: RECOMMENDATIONS,
				},
				"/api/me": { status: 401, body: { error: "unauthorized" } },
			}),
		);

		expect(status.account.signedIn).toBe(false);
		expect(status.recommendations).toHaveLength(3);
		expect(status.models).toHaveLength(3);
	});

	it("reports an unreachable server as unreachable, not as empty", async () => {
		const status = await readOllamaAccountStatus(
			"http://localhost:11434",
			vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		);

		expect(status.reachable).toBe(false);
	});

	it("primes once and answers per model from the cache", async () => {
		const doFetch = stub({
			"/api/tags": { status: 200, body: TAGS },
			"/api/experimental/model-recommendations": {
				status: 200,
				body: RECOMMENDATIONS,
			},
			"/api/me": { status: 200, body: ME },
		});

		await primeOllamaAccountStatus("http://localhost:11434", doFetch);
		await primeOllamaAccountStatus("http://localhost:11434/api", doFetch);

		expect(
			(doFetch as unknown as ReturnType<typeof vi.fn>).mock.calls,
		).toHaveLength(3);
		expect(
			readOllamaCloudFlag("http://localhost:11434", "kimi-k2.6:cloud"),
		).toBe(true);
		expect(readOllamaCloudFlag("http://localhost:11434", "gemma4:31b")).toBe(
			false,
		);
		expect(
			readOllamaRecommendation(
				"http://localhost:11434",
				"glm-5.3-flash-tpl2:latest",
			)?.requiredPlan,
		).toBe("pro");
	});

	// Nothing primed is not the same as nothing found: a caller that wants to
	// say "local" has to know the catalog was read.
	it("says nothing about a server it has not read", () => {
		expect(readOllamaCloudFlag("http://elsewhere:11434", "gemma4:31b")).toBe(
			undefined,
		);
	});
});

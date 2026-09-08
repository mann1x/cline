import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock("@/shared/net", () => ({ fetch: mocks.fetch }))
vi.mock("@/shared/services/Logger", () => ({ Logger: { log: vi.fn() } }))
vi.mock("@/hosts/host-provider", () => ({ HostProvider: { window: { showMessage: vi.fn(async () => undefined) } } }))

import { HostProvider } from "@/hosts/host-provider"
import {
	clearOllamaModelFamilyCache,
	DEFAULT_OLLAMA_BASE_URL,
	OllamaModelInfoUnavailableError,
	resolveOllamaContextWindow,
	resolveOllamaImageSupport,
	resolveOllamaModelFamily,
	resolveOllamaModelParameters,
	resolveOllamaToolSupport,
} from "./ollama-model-family"

const post = mocks.fetch

/** Every attempt in the ladder, so a run that never succeeds can be watched to the end. */
const SHOW_MAX_ATTEMPTS = 30

/**
 * Drive a lookup past its retries.
 *
 * The ladder deliberately waits between attempts; a test that waited with it
 * would take half a minute to assert one throw.
 */
async function settle<T>(pending: Promise<T>): Promise<T> {
	// Captured before the clock moves. Advancing timers with a bare rejection in
	// flight leaves it unhandled for a microtask turn, which vitest reports as
	// an error even though the test goes on to assert it.
	const settled = pending.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error }),
	)
	await vi.advanceTimersByTimeAsync(120_000)
	const result = await settled
	if (result.ok) {
		return result.value
	}
	throw result.error
}

/** What `fetch` gives back, as much of it as this module reads. */
function ok(payload: unknown) {
	return { ok: true, status: 200, json: async () => payload }
}

beforeEach(() => {
	vi.useFakeTimers()
	clearOllamaModelFamilyCache()
	post.mockReset()
})

afterEach(() => {
	vi.useRealTimers()
	vi.clearAllMocks()
})

describe("resolveOllamaModelFamily", () => {
	it("reads the family a local model reports", async () => {
		// The case this exists for: nothing in the name says "Gemma".
		post.mockResolvedValueOnce(ok({ details: { family: "gemma4" } }) as never)

		await expect(resolveOllamaModelFamily("http://localhost:11434", "v7-coder_tb:Q4_K_M")).resolves.toBe("gemma4")

		expect(post).toHaveBeenCalledWith(
			"http://localhost:11434/api/show",
			expect.objectContaining({
				method: "POST",
				// A string body, not a stream: the fetch adapter axios is configured
				// with hands undici a stream, which it rejects without `duplex`.
				body: JSON.stringify({ model: "v7-coder_tb:Q4_K_M" }),
			}),
		)
	})

	it("falls back to the architecture when there is no details block", async () => {
		post.mockResolvedValueOnce(ok({ model_info: { "general.architecture": "qwen35moe" } }) as never)

		await expect(resolveOllamaModelFamily("http://localhost:11434", "old-build")).resolves.toBe("qwen35moe")
	})

	// A family is a nicety: without one the session uses the default template.
	// It must not sit through a retry ladder to find that out.
	it("resolves to nothing, in one attempt, when Ollama is not reachable", async () => {
		post.mockRejectedValue(new Error("ECONNREFUSED"))

		await expect(resolveOllamaModelFamily("http://localhost:11434", "anything")).resolves.toBeUndefined()
		expect(post).toHaveBeenCalledTimes(1)
	})

	it("sends a body undici will accept", async () => {
		// The bug this exists for. Going through axios meant going through the
		// fetch adapter it is configured with, which hands undici a stream —
		// and undici rejects a stream body outright: `RequestInit: duplex
		// option is required when sending a body`. Every other caller on this
		// path issues a GET, so this was the only one to meet it, and the
		// failure was invisible: the lookup fails soft, so the only symptom was
		// every Ollama model quietly resolving to `default.md`.
		post.mockResolvedValueOnce(ok({ details: { family: "gemma4" } }) as never)

		await resolveOllamaModelFamily("http://localhost:11434", "m")

		const init = post.mock.calls[0]?.[1] as RequestInit
		expect(typeof init.body).toBe("string")
	})

	it("treats a non-2xx answer as no family", async () => {
		// A wrong endpoint answers 404 rather than throwing, and a 404 body is
		// not a model description.
		post.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as never)

		await expect(resolveOllamaModelFamily("http://localhost:11434", "m")).resolves.toBeUndefined()
	})

	it("caches a hit so a session does not pay for it twice", async () => {
		post.mockResolvedValueOnce(ok({ details: { family: "gemma4" } }) as never)

		await resolveOllamaModelFamily("http://localhost:11434", "m")
		await resolveOllamaModelFamily("http://localhost:11434", "m")

		expect(post).toHaveBeenCalledTimes(1)
	})

	it("caches a miss so an absent Ollama is not waited on every session", async () => {
		post.mockRejectedValue(new Error("ECONNREFUSED"))

		await resolveOllamaModelFamily("http://localhost:11434", "m")
		await resolveOllamaModelFamily("http://localhost:11434", "m")

		expect(post).toHaveBeenCalledTimes(1)
	})

	it("keys the cache by endpoint as well as model", async () => {
		// Two hosts can serve different models under the same name.
		post.mockResolvedValueOnce(ok({ details: { family: "gemma4" } }) as never)
		post.mockResolvedValueOnce(ok({ details: { family: "qwen35" } }) as never)

		await expect(resolveOllamaModelFamily("http://a:11434", "same-name")).resolves.toBe("gemma4")
		await expect(resolveOllamaModelFamily("http://b:11434", "same-name")).resolves.toBe("qwen35")
	})

	it("trims a trailing slash off the endpoint", async () => {
		post.mockResolvedValueOnce(ok({ details: { family: "gemma4" } }) as never)

		await resolveOllamaModelFamily("http://localhost:11434/", "m")

		expect(post).toHaveBeenCalledWith("http://localhost:11434/api/show", expect.anything())
	})

	it("asks nothing of an unusable base url or empty model", async () => {
		await expect(resolveOllamaModelFamily("not a url", "m")).resolves.toBeUndefined()
		await expect(resolveOllamaModelFamily("http://localhost:11434", "   ")).resolves.toBeUndefined()
		expect(post).not.toHaveBeenCalled()
	})

	it("falls back to Ollama's own endpoint when none is configured", async () => {
		// The settings field is blank for anyone running Ollama where it
		// installs itself, and skipping the lookup there sent every local model
		// to default.md however clearly the GGUF named its architecture.
		post.mockResolvedValue(ok({ details: { family: "qwen35moe" } }) as never)

		await expect(resolveOllamaModelFamily(undefined, "a3b-coder_tb:vision-Q3_K_M")).resolves.toBe("qwen35moe")
		await expect(resolveOllamaModelFamily("   ", "a3b-coder_tb:vision-Q3_K_M")).resolves.toBe("qwen35moe")

		expect(post).toHaveBeenCalledWith(
			`${DEFAULT_OLLAMA_BASE_URL}/api/show`,
			expect.objectContaining({ body: JSON.stringify({ model: "a3b-coder_tb:vision-Q3_K_M" }) }),
		)
		// Both spellings of "unset" land on one cache entry.
		expect(post).toHaveBeenCalledTimes(1)
	})

	it("treats a blank family as no family", async () => {
		post.mockResolvedValueOnce(ok({ details: { family: "  " } }) as never)

		await expect(resolveOllamaModelFamily("http://localhost:11434", "m")).resolves.toBeUndefined()
	})
})

/**
 * Read for the same reason as image support, but the cost of getting it wrong
 * is higher: the runtime reads a populated capability list without "tools" as
 * an authoritative "cannot" and hands the model no tools at all.
 */
describe("resolveOllamaToolSupport", () => {
	it("reports a tool-calling model as one", async () => {
		post.mockResolvedValueOnce(ok({ capabilities: ["completion", "tools", "vision"] }) as never)

		await expect(resolveOllamaToolSupport("http://localhost:11434", "qwen3:8b")).resolves.toBe(true)
	})

	it("reports a model that lists capabilities without tools as one that cannot", async () => {
		post.mockResolvedValueOnce(ok({ capabilities: ["completion", "vision"] }) as never)

		await expect(resolveOllamaToolSupport("http://localhost:11434", "llava")).resolves.toBe(false)
	})

	// Absent is not "no": every other capability check in the codebase assumes
	// tool calling for a model that never declared otherwise.
	it("says nothing when the server does not report capabilities", async () => {
		post.mockResolvedValueOnce(ok({ details: { family: "llama" } }) as never)

		await expect(resolveOllamaToolSupport("http://localhost:11434", "llama3")).resolves.toBeUndefined()
	})
})

/**
 * The alternative is a guess, and the guess is optimistic: image support comes
 * from the model catalog, which has never heard of a local model. That is how a
 * browser screenshot reached a model that could not read one. Ollama knows.
 */
describe("resolveOllamaImageSupport", () => {
	it("reports a vision model as one", async () => {
		post.mockResolvedValueOnce(ok({ capabilities: ["completion", "tools", "vision"] }) as never)

		await expect(resolveOllamaImageSupport("http://localhost:11434", "qwen2.5vl:7b")).resolves.toBe(true)
	})

	it("reports a model that lists capabilities without vision as one that cannot", async () => {
		post.mockResolvedValueOnce(ok({ capabilities: ["completion", "tools"] }) as never)

		await expect(resolveOllamaImageSupport("http://localhost:11434", "deepseek-v3")).resolves.toBe(false)
	})

	// Absent is not "no". An older server that cannot answer must leave the
	// existing optimistic default alone rather than disable images.
	it("says nothing when the server does not report capabilities", async () => {
		post.mockResolvedValueOnce(ok({ details: { family: "llama" } }) as never)

		await expect(resolveOllamaImageSupport("http://localhost:11434", "llama3")).resolves.toBeUndefined()
	})

	// Everything the demanded lookup answers -- context window, image support --
	// is a value the session would otherwise guess, and a guessed context window
	// is the bug this fork has had to fix twice. Ollama is local and it recovers,
	// so this waits for it, says so on screen, and then gives up loudly.
	it("fails rather than letting a session start on guessed values", async () => {
		post.mockRejectedValue(new Error("connect ECONNREFUSED") as never)

		await expect(settle(resolveOllamaImageSupport("http://localhost:11434", "llama3"))).rejects.toBeInstanceOf(
			OllamaModelInfoUnavailableError,
		)
		expect(post).toHaveBeenCalledTimes(SHOW_MAX_ATTEMPTS)
	})

	it("keeps trying, and takes the answer when it arrives", async () => {
		post.mockRejectedValueOnce(new Error("The operation was aborted due to timeout"))
		post.mockRejectedValueOnce(new Error("The operation was aborted due to timeout"))
		post.mockResolvedValueOnce(ok({ capabilities: ["vision"] }) as never)

		await expect(settle(resolveOllamaImageSupport("http://localhost:11434", "m"))).resolves.toBe(true)
		expect(post).toHaveBeenCalledTimes(3)
	})

	// The first ten attempts are quick enough to go unnoticed. Past that the
	// wait is real, so it is said out loud -- once, not thirty times.
	it("says on screen that it is waiting, once", async () => {
		post.mockRejectedValue(new Error("ECONNREFUSED") as never)

		await expect(settle(resolveOllamaImageSupport("http://localhost:11434", "m"))).rejects.toThrow()

		expect(HostProvider.window.showMessage).toHaveBeenCalledTimes(1)
		const message = vi.mocked(HostProvider.window.showMessage).mock.calls[0]?.[0] as { message: string }
		expect(message.message).toContain("/api/show")
	})

	// Context window, image support and think budget read the same response and
	// do not all run at once. Without the cooldown each would climb the whole
	// ladder again, turning one three-minute wait into three.
	it("does not climb the ladder again for the next reader of the same failure", async () => {
		post.mockRejectedValue(new Error("ECONNREFUSED") as never)

		await expect(settle(resolveOllamaImageSupport("http://localhost:11434", "m"))).rejects.toThrow()
		const afterFirst = post.mock.calls.length
		await expect(resolveOllamaContextWindow("http://localhost:11434", "m")).rejects.toThrow()

		expect(post).toHaveBeenCalledTimes(afterFirst)
	})

	// Family and capabilities arrive in the same response; asking twice would
	// put two waits on the session-start path for one answer.
	it("shares one request with the family lookup", async () => {
		post.mockResolvedValueOnce(ok({ details: { family: "qwen3vl" }, capabilities: ["vision"] }) as never)

		const [family, images] = await Promise.all([
			resolveOllamaModelFamily("http://localhost:11434", "qwen2.5vl:7b"),
			resolveOllamaImageSupport("http://localhost:11434", "qwen2.5vl:7b"),
		])

		expect(family).toBe("qwen3vl")
		expect(images).toBe(true)
		expect(post).toHaveBeenCalledTimes(1)
	})

	it("falls back to the default endpoint when the setting is blank", async () => {
		post.mockResolvedValueOnce(ok({ capabilities: ["vision"] }) as never)

		await expect(resolveOllamaImageSupport("", "qwen2.5vl:7b")).resolves.toBe(true)

		expect(post).toHaveBeenCalledWith(`${DEFAULT_OLLAMA_BASE_URL.replace(/\/+$/, "")}/api/show`, expect.anything())
	})
})

/**
 * The panel leaves sampling fields blank and sends nothing for them, so the
 * model's own values stand — which left every field saying "model default" and
 * no way to find out what that default was.
 *
 * `/api/show` returns them as the Modelfile wrote them: a name, whitespace, a
 * value, one per line.
 */
describe("resolveOllamaModelParameters", () => {
	const v7Coder = [
		'stop                           "<end_of_turn>"',
		"temperature                    0.7",
		"top_k                          64",
		"top_p                          0.95",
		"min_p                          0.05",
		"repeat_penalty                 1.1",
		"frequency_penalty              0.3",
		"think_budget                   medium",
		"num_ctx                        128000",
	].join("\n")

	it("reads what the model actually sets", async () => {
		post.mockResolvedValueOnce(ok({ parameters: v7Coder }) as never)

		const parameters = await resolveOllamaModelParameters("http://localhost:11434", "v7-coder_tb:vision-iq4_nl")

		expect(parameters.temperature).toBe("0.7")
		expect(parameters.top_k).toBe("64")
		expect(parameters.min_p).toBe("0.05")
		expect(parameters.think_budget).toBe("medium")
	})

	// The names have to match the panel's field labels exactly, or a value is
	// read and then shown against nothing.
	it("keys them by the spelling the panel labels its fields with", async () => {
		post.mockResolvedValueOnce(ok({ parameters: v7Coder }) as never)

		const parameters = await resolveOllamaModelParameters("http://localhost:11434", "m")

		for (const label of ["temperature", "top_k", "top_p", "min_p", "repeat_penalty", "frequency_penalty"]) {
			expect(Object.hasOwn(parameters, label)).toBe(true)
		}
	})

	it("unquotes a quoted value", async () => {
		post.mockResolvedValueOnce(ok({ parameters: 'stop "<end_of_turn>"' }) as never)

		expect((await resolveOllamaModelParameters("http://localhost:11434", "m")).stop).toBe("<end_of_turn>")
	})

	// `stop` is the one that repeats, and the panel's own stop field is a
	// newline-separated list.
	it("joins a repeated parameter the way the panel writes it", async () => {
		post.mockResolvedValueOnce(ok({ parameters: 'stop "<end_of_turn>"\nstop "<eos>"\ntemperature 0.7' }) as never)

		const parameters = await resolveOllamaModelParameters("http://localhost:11434", "m")

		expect(parameters.stop).toBe("<end_of_turn>\n<eos>")
		expect(parameters.temperature).toBe("0.7")
	})

	it("keeps a value that contains spaces", async () => {
		post.mockResolvedValueOnce(ok({ parameters: 'think_budget_message "You must answer now."' }) as never)

		expect((await resolveOllamaModelParameters("http://localhost:11434", "m")).think_budget_message).toBe(
			"You must answer now.",
		)
	})

	// Taken from the live model: `think_budget` arrives quoted even though it is
	// a bare word, and `think_budget_message` writes its paragraphs as escapes.
	it("unquotes a value that did not need quoting", async () => {
		post.mockResolvedValueOnce(ok({ parameters: 'think_budget                   "medium"' }) as never)

		expect((await resolveOllamaModelParameters("http://localhost:11434", "m")).think_budget).toBe("medium")
	})

	it("turns escaped newlines back into newlines", async () => {
		post.mockResolvedValueOnce(
			ok({ parameters: 'think_budget_message "\\n\\nI have used my thinking budget.\\nI\'ll be terse.\\n"' }) as never,
		)

		const value = (await resolveOllamaModelParameters("http://localhost:11434", "m")).think_budget_message

		expect(value).not.toContain("\\n")
		expect(value).toContain("I have used my thinking budget.")
		expect(value.split("\n").length).toBeGreaterThan(2)
	})

	// A model that sets nothing, and a server that cannot be reached, both leave
	// the fields reading what they read before.
	it("reports nothing rather than failing when the model sets no parameters", async () => {
		post.mockResolvedValueOnce(ok({ details: { family: "gemma4" } }) as never)

		expect(await resolveOllamaModelParameters("http://localhost:11434", "m")).toEqual({})
	})

	it("reports nothing when Ollama is unreachable", async () => {
		post.mockRejectedValueOnce(new Error("connect ECONNREFUSED") as never)

		expect(await resolveOllamaModelParameters("http://localhost:11434", "m")).toEqual({})
	})

	it("asks for nothing when no model is selected", async () => {
		expect(await resolveOllamaModelParameters("http://localhost:11434", "  ")).toEqual({})
		expect(post).not.toHaveBeenCalled()
	})

	it("shares its request with the family and capability lookups", async () => {
		post.mockResolvedValueOnce(ok({ parameters: v7Coder, details: { family: "gemma4" }, capabilities: ["vision"] }) as never)

		const [parameters, family, images] = await Promise.all([
			resolveOllamaModelParameters("http://localhost:11434", "m"),
			resolveOllamaModelFamily("http://localhost:11434", "m"),
			resolveOllamaImageSupport("http://localhost:11434", "m"),
		])

		expect(parameters.temperature).toBe("0.7")
		expect(family).toBe("gemma4")
		expect(images).toBe(true)
		expect(post).toHaveBeenCalledTimes(1)
	})
})

describe("resolveOllamaContextWindow", () => {
	it("reads the num_ctx the model will actually load with", async () => {
		// The whole reason this exists: a local model is not in the catalog, so
		// the window was guessed at 128,000 while the wire carried 110,000, and
		// the compaction trigger — 90% of the guess — landed past the end of the
		// real window.
		post.mockResolvedValueOnce(ok({ parameters: "num_ctx                        110000\ntemperature 0.7" }) as never)

		await expect(resolveOllamaContextWindow(DEFAULT_OLLAMA_BASE_URL, "v7-coder_tb:vision-iq4_nl")).resolves.toBe(110000)
	})

	it("falls back to the architecture's own ceiling", async () => {
		post.mockResolvedValueOnce(
			ok({
				parameters: "temperature 0.7",
				model_info: { "general.architecture": "qwen3", "qwen3.context_length": 262144 },
			}) as never,
		)

		await expect(resolveOllamaContextWindow(DEFAULT_OLLAMA_BASE_URL, "qwen3:8b")).resolves.toBe(262144)
	})

	it("prefers what the model runs with over what it could run with", async () => {
		post.mockResolvedValueOnce(
			ok({
				parameters: "num_ctx 32768",
				model_info: { "general.architecture": "qwen3", "qwen3.context_length": 262144 },
			}) as never,
		)

		await expect(resolveOllamaContextWindow(DEFAULT_OLLAMA_BASE_URL, "qwen3:8b")).resolves.toBe(32768)
	})

	it("says nothing rather than guessing when the server does not report one", async () => {
		post.mockResolvedValueOnce(ok({ parameters: "temperature 0.7" }) as never)

		await expect(resolveOllamaContextWindow(DEFAULT_OLLAMA_BASE_URL, "mystery:latest")).resolves.toBeUndefined()
	})

	it("rejects a non-numeric or non-positive num_ctx", async () => {
		post.mockResolvedValueOnce(ok({ parameters: "num_ctx 0" }) as never)

		await expect(resolveOllamaContextWindow(DEFAULT_OLLAMA_BASE_URL, "broken:latest")).resolves.toBeUndefined()
	})
})

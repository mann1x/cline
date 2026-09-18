import { beforeEach, describe, expect, it } from "vitest";
import {
	autoReasoningHistoryMode,
	cachedReinjection,
	primeOllamaReinjection,
	primeTemplateReinjection,
	resetReasoningReinjection,
	resolveReasoningHistorySetting,
} from "./reasoning-history";

describe("autoReasoningHistoryMode", () => {
	it("sends nothing when the server will not re-render it", () => {
		expect(
			autoReasoningHistoryMode({
				channel: "native-thinking",
				reinjects: false,
			}),
		).toBe("none");
		expect(autoReasoningHistoryMode({ channel: "none", reinjects: true })).toBe(
			"none",
		);
	});

	it("is unproven until probed, and unproven means do not send", () => {
		// Not the same as false, but treated the same way: the estimator measures
		// with this mode, so guessing "send" would count characters that may
		// never become prompt tokens.
		expect(
			autoReasoningHistoryMode({
				channel: "native-thinking",
				reinjects: undefined,
			}),
		).toBe("none");
		expect(autoReasoningHistoryMode(undefined)).toBe("none");
	});

	it("keeps only the last block when the server does re-render it", () => {
		// Never "all": ollama re-renders every assistant think block after the
		// last user turn, and an agent run has one user message, so "all" puts
		// the whole thinking history in every prompt -- 413,766 characters in
		// run 20260918-022626-0367.
		expect(
			autoReasoningHistoryMode({ channel: "native-thinking", reinjects: true }),
		).toBe("last");
		expect(
			autoReasoningHistoryMode({
				channel: "reasoning-content",
				reinjects: true,
			}),
		).toBe("last");
	});
});

describe("the ollama probe measures the prompt rather than naming the renderer", () => {
	beforeEach(() => {
		resetReasoningReinjection();
	});

	it("reads re-injection off the prompt-token delta", async () => {
		// The real numbers from solidPC, qwen3.5:2b, 2026-09-18.
		const counts = [48, 929];
		const bodies: string[] = [];
		const fetchImpl = async (_url: string, init: { body: string }) => {
			bodies.push(init.body);
			return new Response(
				JSON.stringify({ prompt_eval_count: counts.shift() }),
				{ status: 200 },
			);
		};
		await primeOllamaReinjection(
			"http://h/api",
			"m",
			fetchImpl as unknown as typeof fetch,
		);
		expect(cachedReinjection("http://h/api", "m")).toEqual({
			channel: "native-thinking",
			reinjects: true,
			detail: "prompt 48 -> 929 tokens",
		});
		// The probe must use the agent shape -- one user turn first, the
		// assistant after it, a tool result last. With a user message last the
		// same probe returns equal counts on a server that does re-inject.
		const probed = JSON.parse(bodies[1] ?? "{}");
		expect(probed.messages.map((m: { role: string }) => m.role)).toEqual([
			"user",
			"assistant",
			"tool",
		]);
		expect(probed.think).toBe(true);
	});

	it("calls an unchanged prompt length a refusal, whatever the renderer is named", async () => {
		const counts = [31, 31];
		const fetchImpl = async () =>
			new Response(JSON.stringify({ prompt_eval_count: counts.shift() }), {
				status: 200,
			});
		await primeOllamaReinjection(
			"http://h/api",
			"m",
			fetchImpl as unknown as typeof fetch,
		);
		expect(cachedReinjection("http://h/api", "m")?.reinjects).toBe(false);
	});

	it("does not read a few tokens of tokenizer noise as re-injection", async () => {
		const counts = [48, 51];
		const fetchImpl = async () =>
			new Response(JSON.stringify({ prompt_eval_count: counts.shift() }), {
				status: 200,
			});
		await primeOllamaReinjection(
			"http://h/api",
			"m",
			fetchImpl as unknown as typeof fetch,
		);
		expect(cachedReinjection("http://h/api", "m")?.reinjects).toBe(false);
	});
});

describe("the template probe reads the server's own rendered prompt", () => {
	beforeEach(() => {
		resetReasoningReinjection();
	});

	it("finds the needle a re-injecting template emits", async () => {
		let sent = "";
		const fetchImpl = async (_url: string, init: { body: string }) => {
			sent = init.body;
			return new Response(
				JSON.stringify({
					prompt:
						"<|im_start|>assistant\n<think>\nCLINE-REINJECTION-PROBE-8F2A\n</think>\nhi",
				}),
				{ status: 200 },
			);
		};
		await primeTemplateReinjection(
			"http://h",
			"m",
			fetchImpl as unknown as typeof fetch,
		);
		expect(cachedReinjection("http://h", "m")).toEqual({
			channel: "reasoning-content",
			reinjects: true,
			detail: "template re-injects reasoning",
		});
		// Both spellings go out, because the engines disagree and the template
		// reads whichever its author chose.
		expect(sent).toContain("reasoning_content");
		expect(sent).toContain("thinking");
	});

	it("records a template that drops it", async () => {
		const fetchImpl = async () =>
			new Response(JSON.stringify({ prompt: "<|im_start|>assistant\nhi" }), {
				status: 200,
			});
		await primeTemplateReinjection(
			"http://h",
			"m",
			fetchImpl as unknown as typeof fetch,
		);
		expect(cachedReinjection("http://h", "m")?.reinjects).toBe(false);
	});

	it("leaves the capability unproven when the probe cannot be made", async () => {
		const fetchImpl = async () => {
			throw new Error("connection refused");
		};
		await primeTemplateReinjection(
			"http://h",
			"m",
			fetchImpl as unknown as typeof fetch,
		);
		expect(cachedReinjection("http://h", "m")?.reinjects).toBeUndefined();
	});
});

describe("the configured setting outranks the probe", () => {
	beforeEach(() => {
		resetReasoningReinjection();
	});

	it("resolves auto from the measured capability", async () => {
		const counts = [48, 929];
		const fetchImpl = async () =>
			new Response(JSON.stringify({ prompt_eval_count: counts.shift() }), {
				status: 200,
			});
		await primeOllamaReinjection(
			"http://h/api",
			"m",
			fetchImpl as unknown as typeof fetch,
		);
		expect(resolveReasoningHistorySetting("auto", "http://h/api", "m")).toBe(
			"last",
		);
	});

	it("treats an unset setting as auto", () => {
		expect(resolveReasoningHistorySetting(undefined, "http://h/api", "m")).toBe(
			"none",
		);
	});

	it("honours an explicit choice even against the probe", async () => {
		// The probe says the server drops it; the operator says send it anyway.
		// That has to win, or the setting is decoration -- and it is the only way
		// to test a server whose template is about to change.
		const counts = [31, 31];
		const fetchImpl = async () =>
			new Response(JSON.stringify({ prompt_eval_count: counts.shift() }), {
				status: 200,
			});
		await primeOllamaReinjection(
			"http://h/api",
			"m",
			fetchImpl as unknown as typeof fetch,
		);
		expect(cachedReinjection("http://h/api", "m")?.reinjects).toBe(false);
		expect(resolveReasoningHistorySetting("all", "http://h/api", "m")).toBe(
			"all",
		);
		expect(resolveReasoningHistorySetting("none", "http://h/api", "m")).toBe(
			"none",
		);
	});
});

describe("auto never silently changes a provider it cannot probe", () => {
	beforeEach(() => {
		resetReasoningReinjection();
	});

	it("leaves a hosted API on its standing behaviour", () => {
		// Anthropic requires the signed thinking blocks back for tool use, and
		// nothing here can render its template to check. An unprobed provider
		// keeps exactly what it had, which for those is "all".
		expect(autoReasoningHistoryMode(undefined, "all")).toBe("all");
		expect(
			resolveReasoningHistorySetting("auto", undefined, "claude", "all"),
		).toBe("all");
	});

	it("still refuses when the probe ran and said no", async () => {
		const counts = [31, 31];
		const fetchImpl = async () =>
			new Response(JSON.stringify({ prompt_eval_count: counts.shift() }), {
				status: 200,
			});
		await primeOllamaReinjection(
			"http://h/api",
			"m",
			fetchImpl as unknown as typeof fetch,
		);
		// The fallback is for "nobody could ask", not for "we asked and it is no".
		expect(
			resolveReasoningHistorySetting("auto", "http://h/api", "m", "all"),
		).toBe("none");
	});
});

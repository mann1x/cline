import { describe, expect, it } from "vitest";
import {
	probeOllamaReachability,
	resolveOllamaOrigin,
} from "./ollama-reachability";

const tags = (...names: string[]) =>
	(async () =>
		Response.json({
			models: names.map((name) => ({ name, model: name })),
		})) as unknown as typeof fetch;

describe("which server the chat input asks", () => {
	it("asks the server a chat would go to when no URL is set", () => {
		expect(resolveOllamaOrigin("ollama", undefined)).toBe(
			"http://127.0.0.1:11434",
		);
		expect(resolveOllamaOrigin("xollama", "")).toBe("http://localhost:22434");
	});

	it("takes a configured URL with or without its API suffix", () => {
		expect(resolveOllamaOrigin("ollama", "http://gpu2:11434/v1/")).toBe(
			"http://gpu2:11434",
		);
		expect(resolveOllamaOrigin("xollama", "http://gpu2:22434/api")).toBe(
			"http://gpu2:22434",
		);
	});
});

describe("whether it answers", () => {
	it("says reachable, and whether the model is there, from /api/tags", async () => {
		const asked: string[] = [];
		const fetchImpl = (async (url: string) => {
			asked.push(url);
			return Response.json({ models: [{ name: "qwen3:latest" }] });
		}) as unknown as typeof fetch;
		expect(
			await probeOllamaReachability(
				"ollama",
				"http://gpu2:11434",
				"qwen3",
				fetchImpl,
			),
		).toEqual({
			reachable: true,
			baseUrl: "http://gpu2:11434",
			modelFound: true,
		});
		expect(asked).toEqual(["http://gpu2:11434/api/tags"]);
	});

	it("reports a model the server does not list", async () => {
		const result = await probeOllamaReachability(
			"ollama",
			"http://gpu2:11434",
			"gone:7b",
			tags("qwen3:latest"),
		);
		expect(result.modelFound).toBe(false);
	});

	// pandorum, 2026-09-30: the chat box said the server did not have
	// glm-5.3-flash:cloud while a session was running on it.
	it("counts a cloud model the server offers but has not pulled", async () => {
		const asked: string[] = [];
		const fetchImpl = (async (url: string) => {
			asked.push(url);
			return url.endsWith("/api/tags")
				? Response.json({ models: [{ name: "qwen3:latest" }] })
				: Response.json({
						recommendations: [
							{ model: "glm-5.3-flash:cloud", context_length: 1048576 },
							{ model: "gemma4:26b", vram_bytes: 19000000000 },
						],
					});
		}) as unknown as typeof fetch;
		const cloud = await probeOllamaReachability(
			"ollama",
			"http://gpu2:11434",
			"glm-5.3-flash:cloud",
			fetchImpl,
		);
		expect(cloud.modelFound).toBe(true);
		expect(asked).toEqual([
			"http://gpu2:11434/api/tags",
			"http://gpu2:11434/api/experimental/model-recommendations",
		]);
		// A local recommendation does need a pull.
		const local = await probeOllamaReachability(
			"ollama",
			"http://gpu2:11434",
			"gemma4:26b",
			fetchImpl,
		);
		expect(local.modelFound).toBe(false);
	});

	it("says nothing about the model when none was named", async () => {
		const result = await probeOllamaReachability(
			"ollama",
			"http://gpu2:11434",
			undefined,
			tags(),
		);
		expect(result).not.toHaveProperty("modelFound");
	});

	it("names the network's refusal, not 'fetch failed'", async () => {
		const fetchImpl = (async () => {
			throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
		}) as unknown as typeof fetch;
		expect(
			await probeOllamaReachability("xollama", undefined, "m", fetchImpl),
		).toEqual({
			reachable: false,
			baseUrl: "http://localhost:22434",
			error: "ECONNREFUSED",
		});
	});

	it("reads a timeout as no answer", async () => {
		const fetchImpl = (async () => {
			throw new DOMException("timed out", "TimeoutError");
		}) as unknown as typeof fetch;
		const result = await probeOllamaReachability(
			"ollama",
			"http://gpu2:11434",
			"m",
			fetchImpl,
		);
		expect(result.error).toBe("no answer within 4s");
	});

	it("tells a refused key from a server that is not there", async () => {
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ error: "unauthorized" }), {
				status: 401,
				headers: { "www-authenticate": 'Bearer realm="xollama"' },
			})) as unknown as typeof fetch;
		expect(
			await probeOllamaReachability(
				"xollama",
				"http://gpu2:22434",
				"m",
				fetchImpl,
			),
		).toEqual({
			reachable: false,
			baseUrl: "http://gpu2:22434",
			error: "HTTP 401",
			unauthorized: true,
		});
	});

	it("treats a non-Ollama answer as not reachable", async () => {
		const fetchImpl = (async () =>
			new Response("nope", { status: 404 })) as unknown as typeof fetch;
		expect(
			await probeOllamaReachability(
				"ollama",
				"http://gpu2:8080",
				"m",
				fetchImpl,
			),
		).toMatchObject({
			reachable: false,
			error: "HTTP 404",
		});
	});
});

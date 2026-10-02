import { describe, expect, it, vi } from "vitest";
import {
	listMediaModels,
	type MediaEndpointProbe,
	MediaRequestTimeoutError,
	mediaKindsOfModelRow,
	normalizeBaseUrl,
	probeMediaEndpoint,
	resolveMediaEndpoint,
	retryAfterMs,
	sendMediaRequest,
} from "./media-endpoint";

/** A server, as the routes it answers. Anything else is a 404. */
function server(routes: Record<string, unknown>): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = String(input);
		const hit = Object.keys(routes).find((route) => url.endsWith(route));
		return hit
			? new Response(JSON.stringify(routes[hit]))
			: new Response("not found", { status: 404 });
	}) as typeof fetch;
}

const opencoti = server({
	"/props": {
		build_info: "opencoti-0.10.5-c7-2610021340001",
		features: ["images_generate_v1", "images_edit_v1", "audio_speech_v1"],
	},
	"/v1/models": {
		data: [
			{ id: "qwen3-14b" },
			{ id: "klein", capabilities: ["image_generation", "image_edit"] },
			{ id: "outetts", kind: "audio", capabilities: ["audio_speech"] },
		],
	},
});

const xollama = server({
	"/api/xollama": { xollama: true, version: "0.34.4", features: [] },
	"/v1/models": {
		data: [
			{ id: "omni:latest" },
			{
				id: "mannix/flux2-klein:4b",
				input_modalities: ["text", "image"],
				output_modalities: ["image"],
			},
			{
				id: "mannix/z-image:turbo",
				input_modalities: ["text"],
				output_modalities: ["image"],
			},
			{
				id: "mannix/whisper:large-v3-turbo",
				input_modalities: ["audio"],
				output_modalities: ["text"],
			},
		],
	},
});

const plain = server({
	"/v1/models": { data: [{ id: "dall-e-3" }, { id: "gpt-4o" }] },
});

describe("normalizeBaseUrl", () => {
	it("ends in /v1 whatever was typed", () => {
		expect(normalizeBaseUrl("http://h:8080")).toBe("http://h:8080/v1");
		expect(normalizeBaseUrl("http://h:8080/v1/")).toBe("http://h:8080/v1");
		// An Ollama provider's base URL, reused for media.
		expect(normalizeBaseUrl("http://h:22434/api")).toBe("http://h:22434/v1");
	});
});

describe("mediaKindsOfModelRow", () => {
	it("reads an edit model and a transcription model from modalities", () => {
		expect(
			mediaKindsOfModelRow({
				input_modalities: ["text", "image"],
				output_modalities: ["image"],
			}),
		).toEqual(["image_generation", "image_edit"]);
		expect(
			mediaKindsOfModelRow({
				input_modalities: ["audio"],
				output_modalities: ["text"],
			}),
		).toEqual(["transcription"]);
	});

	it("says nothing for a row that says nothing", () => {
		expect(mediaKindsOfModelRow({ id: "gpt-4o" })).toBeUndefined();
	});
});

describe("probeMediaEndpoint", () => {
	it("reads opencoti's features, and a missing one as not served", async () => {
		const probe = await probeMediaEndpoint("http://bs2:8244", {
			fetchImpl: opencoti,
		});
		expect(probe?.server).toBe("opencoti");
		expect(probe?.kinds).toEqual({
			image_generation: true,
			image_edit: true,
			transcription: false,
			speech: true,
			video: false,
		});
		expect(probe && listMediaModels(probe, "speech")).toEqual([
			"outetts",
			"qwen3-14b",
		]);
	});

	it("reads xOllama's models, and lists only those that serve the kind", async () => {
		const probe = await probeMediaEndpoint("http://e2g:22434/api", {
			fetchImpl: xollama,
		});
		expect(probe?.server).toBe("xollama");
		expect(probe?.kinds).toEqual({
			image_generation: true,
			image_edit: true,
			transcription: true,
			speech: false,
			video: false,
		});
		expect(probe && listMediaModels(probe, "image_edit")).toEqual([
			"mannix/flux2-klein:4b",
		]);
		expect(probe && listMediaModels(probe, "image_generation")).toEqual([
			"mannix/flux2-klein:4b",
			"mannix/z-image:turbo",
		]);
	});

	it("takes a plain OpenAI server as unknown, not as serving nothing", async () => {
		const probe = await probeMediaEndpoint("https://api.example.com/v1", {
			fetchImpl: plain,
		});
		expect(probe).toEqual({
			server: "openai",
			kinds: {},
			models: [{ id: "dall-e-3" }, { id: "gpt-4o" }],
		});
	});

	it("answers nothing for a server that does not answer", async () => {
		const dead = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		expect(
			await probeMediaEndpoint("http://gone:1", { fetchImpl: dead }),
		).toBeUndefined();
		expect(await probeMediaEndpoint("  ", { fetchImpl: dead })).toBeUndefined();
	});
});

describe("resolveMediaEndpoint", () => {
	const probes: Record<string, MediaEndpointProbe | undefined> = {};
	const probe = async (baseUrl: string) => probes[baseUrl];
	const load = async () => {
		probes["http://bs2:8244"] = await probeMediaEndpoint("http://bs2:8244", {
			fetchImpl: opencoti,
		});
		probes["http://e2g:22434"] = await probeMediaEndpoint("http://e2g:22434", {
			fetchImpl: xollama,
		});
		probes["https://api.example.com/v1"] = await probeMediaEndpoint(
			"https://api.example.com/v1",
			{ fetchImpl: plain },
		);
	};
	const typed = { baseUrl: "https://api.example.com/v1", model: "dall-e-3" };

	it("uses the session's opencoti when it serves the kind", async () => {
		await load();
		expect(
			await resolveMediaEndpoint({
				kind: "image_generation",
				useProvider: true,
				provider: {
					providerId: "opencoti",
					baseUrl: "http://bs2:8244",
					modelId: "qwen3-14b",
				},
				typed,
				probe,
			}),
		).toEqual({
			endpoint: { baseUrl: "http://bs2:8244", model: "klein" },
			source: "provider",
			server: "opencoti",
		});
	});

	it("falls to the typed URL when the provider lacks the kind", async () => {
		await load();
		const resolved = await resolveMediaEndpoint({
			kind: "transcription",
			useProvider: true,
			provider: { providerId: "opencoti", baseUrl: "http://bs2:8244" },
			typed: {
				baseUrl: "http://e2g:22434",
				model: "mannix/whisper:large-v3-turbo",
			},
			probe,
		});
		expect(resolved).toMatchObject({ source: "typed", server: "xollama" });
	});

	it("falls to the typed URL when the lead is neither opencoti nor xOllama", async () => {
		await load();
		const resolved = await resolveMediaEndpoint({
			kind: "image_generation",
			useProvider: true,
			provider: {
				providerId: "openai",
				baseUrl: "https://api.example.com/v1",
				modelId: "gpt-4o",
			},
			typed,
			probe,
		});
		expect(resolved).toMatchObject({ source: "typed", server: "openai" });
	});

	it("does not guess among several xOllama models that serve the kind", async () => {
		await load();
		const input = {
			kind: "image_generation" as const,
			useProvider: true,
			provider: {
				providerId: "ollama",
				baseUrl: "http://e2g:22434",
				modelId: "omni:latest",
			},
			probe,
		};
		expect(await resolveMediaEndpoint(input)).toEqual({
			disabled:
				"the session's xollama provider serves this with several models, and none is named",
		});
		// The tab names which of them.
		expect(
			await resolveMediaEndpoint({
				...input,
				typed: { model: "mannix/z-image:turbo" },
			}),
		).toMatchObject({
			endpoint: { model: "mannix/z-image:turbo" },
			source: "provider",
		});
	});

	it("takes the model the server's operator marked as the default for the kind", async () => {
		const marked = await probeMediaEndpoint("http://e2g:22499", {
			fetchImpl: server({
				"/api/xollama": { xollama: true, version: "0.34.4", features: [] },
				"/v1/models": {
					data: [
						{
							id: "mannix/flux2-klein:4b",
							capabilities: ["image_generation", "image_edit"],
							// `video` is not a kind this model serves, so it is dropped.
							default_for: ["image_generation", "image_edit", "video"],
						},
						{
							id: "mannix/z-image:turbo",
							capabilities: ["image_generation", "image_edit"],
						},
					],
				},
			}),
		});
		expect(marked?.models).toEqual([
			{
				id: "mannix/flux2-klein:4b",
				kinds: ["image_generation", "image_edit"],
				defaultFor: ["image_generation", "image_edit"],
			},
			{ id: "mannix/z-image:turbo", kinds: ["image_generation", "image_edit"] },
		]);
		const input = {
			kind: "image_edit" as const,
			useProvider: true,
			provider: {
				providerId: "ollama",
				baseUrl: "http://e2g:22499",
				modelId: "omni:latest",
			},
			probe: async () => marked,
		};
		expect(await resolveMediaEndpoint(input)).toMatchObject({
			source: "provider",
			endpoint: { model: "mannix/flux2-klein:4b" },
		});
		// A model the tab names still comes first.
		expect(
			await resolveMediaEndpoint({
				...input,
				typed: { model: "mannix/z-image:turbo" },
			}),
		).toMatchObject({ endpoint: { model: "mannix/z-image:turbo" } });
	});

	it("is disabled only with no typed URL or no model", async () => {
		await load();
		const base = { kind: "speech" as const, useProvider: false, probe };
		expect(await resolveMediaEndpoint(base)).toEqual({
			disabled: "no endpoint is configured",
		});
		expect(
			await resolveMediaEndpoint({
				...base,
				typed: { baseUrl: "http://e2g:22434" },
			}),
		).toEqual({ disabled: "the endpoint has no model named" });
	});

	// These servers may be started on request, so a typed endpoint is offered
	// whatever it says at session start. The tab's switch is the off switch.
	it("offers a typed endpoint that is down, or lacks the kind, with a warning", async () => {
		await load();
		const base = { kind: "speech" as const, useProvider: false, probe };
		expect(
			await resolveMediaEndpoint({
				...base,
				typed: { baseUrl: "http://gone:1", model: "m" },
			}),
		).toEqual({
			endpoint: { baseUrl: "http://gone:1", model: "m" },
			source: "typed",
			server: "unknown",
			warning: "the endpoint at http://gone:1 does not answer right now",
		});
		expect(
			await resolveMediaEndpoint({
				...base,
				typed: { baseUrl: "http://e2g:22434", model: "omni:latest" },
			}),
		).toEqual({
			endpoint: { baseUrl: "http://e2g:22434", model: "omni:latest" },
			source: "typed",
			server: "xollama",
			warning:
				"the xollama server at http://e2g:22434 does not serve this right now",
		});
	});
});

describe("sendMediaRequest", () => {
	it("waits out a busy engine and never returns the 503", async () => {
		const replies = [
			new Response("busy", { status: 503, headers: { "retry-after": "7" } }),
			new Response("busy", { status: 503 }),
			new Response('{"ok":true}'),
		];
		const fetchImpl = vi.fn(async () => replies.shift() as Response);
		const waits: number[] = [];
		const init = vi.fn(() => ({ method: "POST" }));
		const response = await sendMediaRequest("http://h/v1/images/edits", init, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			onBusy: (waitMs) => waits.push(waitMs),
			sleep: async () => {},
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(waits).toEqual([7_000, 5_000]);
		// A body is built per attempt: multipart is spent by the one that sent it.
		expect(init).toHaveBeenCalledTimes(3);
	});

	it("hands the 503 back once it has waited as long as it may", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response("busy", { status: 503, headers: { "retry-after": "60" } }),
		);
		const response = await sendMediaRequest("http://h/v1/x", () => ({}), {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			maxBusyMs: 120_000,
			sleep: async () => {},
		});
		expect(response.status).toBe(503);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("hands back any other refusal as it is", async () => {
		const fetchImpl = (async () =>
			new Response("no such capability", { status: 400 })) as typeof fetch;
		const response = await sendMediaRequest("http://h/v1/x", () => ({}), {
			fetchImpl,
		});
		expect(response.status).toBe(400);
		expect(await response.text()).toBe("no such capability");
	});

	it("stops waiting when the caller stops", async () => {
		const abort = new AbortController();
		const fetchImpl = (async () =>
			new Response("busy", { status: 503 })) as typeof fetch;
		const sent = sendMediaRequest("http://h/v1/x", () => ({}), {
			fetchImpl,
			signal: abort.signal,
			onBusy: () => abort.abort(new Error("stopped")),
		});
		await expect(sent).rejects.toThrow("stopped");
	});

	it("names an attempt that ran past its limit", async () => {
		const fetchImpl = ((_url: string, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new Error("aborted")),
				);
			})) as unknown as typeof fetch;
		await expect(
			sendMediaRequest("http://h/v1/x", () => ({}), {
				fetchImpl,
				attemptTimeoutMs: 20,
			}),
		).rejects.toBeInstanceOf(MediaRequestTimeoutError);
	});

	it("bounds Retry-After", () => {
		expect(retryAfterMs(null)).toBe(5_000);
		expect(retryAfterMs("0")).toBe(1_000);
		expect(retryAfterMs("600")).toBe(60_000);
	});
});

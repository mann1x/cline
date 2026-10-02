import { describe, expect, it } from "vitest";
import type { MediaEndpointProbe } from "./media-endpoint";
import {
	createMediaTools,
	type MediaProbe,
	parseMediaToolsConfig,
	resolveMediaTool,
} from "./media-tools";

/** An opencoti serving every kind, as its probe reports it. */
const everything: MediaEndpointProbe = {
	server: "opencoti",
	kinds: {
		image_generation: true,
		image_edit: true,
		transcription: true,
		speech: true,
		video: true,
	},
	models: [],
};
const chatOnly: MediaEndpointProbe = {
	server: "opencoti",
	kinds: {
		image_generation: false,
		image_edit: false,
		transcription: false,
		speech: false,
		video: false,
	},
	models: [],
};
const probeOf =
	(servers: Record<string, MediaEndpointProbe | undefined>): MediaProbe =>
	async (baseUrl) =>
		servers[baseUrl];

const provider = {
	providerId: "opencoti",
	baseUrl: "http://lead:8080/v1",
	modelId: "qwen",
};
const io = {
	cwd: "/work",
	readFile: async () => Buffer.alloc(0),
	writeFile: async () => {},
};

describe("parseMediaToolsConfig", () => {
	it("switches on only the sections the document names", () => {
		expect(parseMediaToolsConfig({})).toEqual({});
		expect(
			parseMediaToolsConfig({
				baseUrl: " http://media:1 ",
				apiKey: "sk",
				image: { model: "klein", size: "1024x1024", edit: false },
				speech: {
					baseUrl: "http://tts:2",
					model: "outetts",
					voice: "anna",
					format: "WAV",
				},
				transcription: true,
				video: false,
			}),
		).toEqual({
			image: {
				baseUrl: "http://media:1",
				apiKey: "sk",
				model: "klein",
				size: "1024x1024",
				edit: false,
			},
			speech: {
				baseUrl: "http://tts:2",
				apiKey: "sk",
				model: "outetts",
				voice: "anna",
				format: "wav",
			},
			transcription: { baseUrl: "http://media:1", apiKey: "sk" },
		});
	});

	it("`all` is every section on the session's provider, and a section can still opt out", () => {
		expect(
			parseMediaToolsConfig({ video: false }, { all: true, useProvider: true }),
		).toEqual({
			image: { useProvider: true },
			transcription: { useProvider: true },
			speech: { useProvider: true },
		});
	});
});

describe("resolveMediaTool", () => {
	it("is off without its section, and edit is off with `edit: false`", async () => {
		const probe = probeOf({});
		expect(
			await resolveMediaTool("generate_video", {}, provider, probe),
		).toEqual({
			disabled: "video generation is switched off",
		});
		expect(
			await resolveMediaTool(
				"edit_image",
				{ image: { baseUrl: "http://m:1", model: "klein", edit: false } },
				provider,
				probe,
			),
		).toEqual({ disabled: "image editing is switched off" });
	});

	it("sends edits where generation goes unless the section says otherwise, with the section's defaults", async () => {
		const probe = probeOf({});
		const image = {
			baseUrl: "http://m:1",
			model: "klein",
			apiKey: "sk",
			size: "512x512",
		};
		expect(
			await resolveMediaTool("edit_image", { image }, undefined, probe),
		).toMatchObject({
			source: "typed",
			endpoint: {
				baseUrl: "http://m:1",
				model: "klein",
				apiKey: "sk",
				size: "512x512",
			},
		});
		expect(
			await resolveMediaTool(
				"edit_image",
				{
					image: {
						...image,
						edit: { baseUrl: "http://e:2", model: "qwen-image" },
					},
				},
				undefined,
				probe,
			),
		).toMatchObject({
			endpoint: { baseUrl: "http://e:2", model: "qwen-image", apiKey: "sk" },
		});
	});

	it("uses the session's provider when it serves the kind, the typed endpoint when it does not", async () => {
		const config = {
			video: {
				useProvider: true,
				baseUrl: "http://v:9",
				model: "wan2.1",
				seconds: 3,
				format: "mp4",
			},
		};
		expect(
			await resolveMediaTool(
				"generate_video",
				config,
				provider,
				probeOf({ "http://lead:8080/v1": everything }),
			),
		).toMatchObject({
			source: "provider",
			server: "opencoti",
			endpoint: { baseUrl: "http://lead:8080/v1", seconds: 3, format: "mp4" },
		});
		expect(
			await resolveMediaTool(
				"generate_video",
				config,
				provider,
				probeOf({ "http://lead:8080/v1": chatOnly }),
			),
		).toMatchObject({
			source: "typed",
			endpoint: { baseUrl: "http://v:9", model: "wan2.1" },
		});
	});
});

describe("createMediaTools", () => {
	it("offers exactly the tools the configuration resolves, and says why for each", async () => {
		const log: string[] = [];
		const tools = await createMediaTools({
			...io,
			getConfig: () => ({
				image: { baseUrl: "http://m:1", model: "klein", edit: false },
				speech: { baseUrl: "http://down:2", model: "outetts" },
				// On, but naming nowhere to go and no provider to fall back on.
				transcription: { useProvider: true },
			}),
			probe: probeOf({}),
			log: (line) => log.push(line),
		});
		expect(tools.map((tool) => tool.name)).toEqual([
			"generate_image",
			"synthesize_speech",
		]);
		expect(log).toHaveLength(5);
		expect(log[0]).toMatch(
			/^generate_image uses the typed endpoint \(unknown\), model klein; /,
		);
		expect(log[1]).toBe("edit_image omitted: image editing is switched off");
		expect(log[2]).toMatch(/^transcribe_audio omitted: /);
		expect(log[4]).toBe(
			"generate_video omitted: video generation is switched off",
		);
	});

	it("offers all five on a provider that serves everything", async () => {
		const tools = await createMediaTools({
			...io,
			getConfig: () =>
				parseMediaToolsConfig({}, { all: true, useProvider: true }),
			provider,
			probe: probeOf({ "http://lead:8080/v1": everything }),
		});
		expect(tools.map((tool) => tool.name)).toEqual([
			"generate_image",
			"edit_image",
			"transcribe_audio",
			"synthesize_speech",
			"generate_video",
		]);
	});
});

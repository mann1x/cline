import { relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	audioExtension,
	createSynthesizeSpeechTool,
	createTranscribeAudioTool,
	listSpeechVoices,
	sniffAudioExtension,
	wavSeconds,
} from "./audio-tools";

/** A path under the test workspace, in the running platform's form. */
const at = (...parts: string[]) => resolve("/ws", ...parts);

/** A WAV of `seconds` of 24 kHz mono 16-bit silence. */
function wav(seconds: number): Buffer {
	const rate = 24_000;
	const dataBytes = Math.round(seconds * rate * 2);
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "latin1");
	header.writeUInt32LE(36 + dataBytes, 4);
	header.write("WAVEfmt ", 8, "latin1");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(rate, 24);
	header.writeUInt32LE(rate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "latin1");
	header.writeUInt32LE(dataBytes, 40);
	return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}
const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]);

describe("what the bytes are", () => {
	it("tells WAV, MP3, FLAC and Ogg apart", () => {
		expect(sniffAudioExtension(wav(0.1))).toBe(".wav");
		expect(sniffAudioExtension(MP3)).toBe(".mp3");
		expect(sniffAudioExtension(Buffer.from("ID3\u0004...."))).toBe(".mp3");
		expect(sniffAudioExtension(Buffer.from("fLaC...."))).toBe(".flac");
		expect(sniffAudioExtension(Buffer.from("OggS...."))).toBe(".ogg");
		expect(sniffAudioExtension(Buffer.from("hello world!"))).toBeUndefined();
	});

	it("trusts the bytes, then the header, then the request", () => {
		expect(audioExtension(wav(0.1), "audio/mpeg", "mp3")).toBe(".wav");
		expect(
			audioExtension(Buffer.from("????????????"), "audio/mpeg", "wav"),
		).toBe(".mp3");
		expect(audioExtension(Buffer.from("????????????"), null, "pcm")).toBe(
			".pcm",
		);
	});

	it("reads a WAV's length from its header, streamed or not", () => {
		expect(wavSeconds(wav(2))).toBeCloseTo(2, 3);
		const streamed = wav(1.5);
		streamed.writeUInt32LE(0xffffffff, 40);
		expect(wavSeconds(streamed)).toBeCloseTo(1.5, 3);
		expect(wavSeconds(MP3)).toBeUndefined();
	});
});

describe("transcribe_audio", () => {
	const make = (
		fetchImpl: typeof fetch,
		extra: { maxReturnedChars?: number } = {},
	) => {
		const written: Record<string, string> = {};
		const tool = createTranscribeAudioTool({
			cwd: at(),
			getEndpoint: () => ({
				baseUrl: "http://e2g:22434/api",
				model: "mannix/whisper:large-v3-turbo",
			}),
			readFile: async (path) => {
				if (path !== at("talk.wav")) throw new Error("ENOENT");
				return wav(0.2);
			},
			writeFile: async (path, data) => {
				written[path] = data.toString("utf8");
			},
			fetchImpl,
			...extra,
		});
		return { tool, written };
	};
	const reply = (body: string) =>
		vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(body),
		);

	it("asks for JSON and hands back the text", async () => {
		const fetchImpl = reply('{"text":" Hello there. "}');
		const { tool } = make(fetchImpl as unknown as typeof fetch);
		expect(
			await tool.execute({ path: "talk.wav", language: "en" }, {} as never),
		).toBe("Hello there.");
		const [url, init] = fetchImpl.mock.calls[0] ?? [];
		expect(String(url)).toBe("http://e2g:22434/v1/audio/transcriptions");
		const form = init?.body as FormData;
		expect(form.get("model")).toBe("mannix/whisper:large-v3-turbo");
		expect(form.get("response_format")).toBe("json");
		expect(form.get("language")).toBe("en");
		const file = form.get("file") as File;
		expect([file.name, file.type]).toEqual(["talk.wav", "audio/wav"]);
	});

	it("takes subtitles as they come, on the translations route when asked", async () => {
		const srt = "1\n00:00:00,000 --> 00:00:01,000\nHello";
		const fetchImpl = reply(srt);
		const { tool } = make(fetchImpl as unknown as typeof fetch);
		expect(
			await tool.execute(
				{ path: "talk.wav", format: "srt", translate: true, language: "ru" },
				{} as never,
			),
		).toBe(srt);
		const [url, init] = fetchImpl.mock.calls[0] ?? [];
		expect(String(url)).toBe("http://e2g:22434/v1/audio/translations");
		const form = init?.body as FormData;
		expect(form.get("response_format")).toBe("srt");
		// A translation's output language is fixed; the source is detected.
		expect(form.get("language")).toBeNull();
	});

	it("saves to a file when asked, and returns only the beginning", async () => {
		const long = "word ".repeat(1_000).trim();
		const { tool, written } = make(
			reply(JSON.stringify({ text: long })) as unknown as typeof fetch,
		);
		const output = await tool.execute(
			{ path: "talk.wav", output: "notes/talk.txt" },
			{} as never,
		);
		expect(written[at("notes/talk.txt")]).toBe(`${long}\n`);
		expect(output).toContain("saved 4999 characters to `notes/talk.txt`");
		expect(output).toContain("[The rest is in the file.]");
	});

	it("cuts a long transcript and says so", async () => {
		const { tool } = make(
			reply(
				JSON.stringify({ text: "x".repeat(500) }),
			) as unknown as typeof fetch,
			{ maxReturnedChars: 100 },
		);
		const output = String(
			await tool.execute({ path: "talk.wav" }, {} as never),
		);
		expect(output.startsWith("x".repeat(100))).toBe(true);
		expect(output).toContain("500 characters and 100 are shown");
	});

	it("refuses a bad call before sending anything", async () => {
		const fetchImpl = reply("{}");
		const { tool } = make(fetchImpl as unknown as typeof fetch);
		const run = (input: object) => tool.execute(input, {} as never);
		expect(await run({})).toContain("needs a `path`");
		expect(await run({ path: "talk.wav", format: "docx" })).toContain(
			"not a transcript format",
		);
		expect(await run({ path: "../talk.wav" })).toContain(
			"outside the workspace",
		);
		expect(await run({ path: "gone.wav" })).toContain("Could not read");
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("synthesize_speech", () => {
	const make = (
		fetchImpl: typeof fetch,
		endpoint: { voice?: string; format?: string } = {},
	) => {
		const written: Record<string, Buffer> = {};
		const tool = createSynthesizeSpeechTool({
			cwd: at(),
			getEndpoint: () => ({
				baseUrl: "http://e2g:22434",
				model: "mannix/outetts:0.3",
				apiKey: "k",
				...endpoint,
			}),
			writeFile: async (path, data) => {
				written[path] = data;
			},
			fetchImpl,
		});
		return { tool, written };
	};
	const audio = (data: Buffer, type: string) =>
		vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(new Uint8Array(data), {
					headers: { "content-type": type },
				}),
		);

	it("posts the text and saves what comes back", async () => {
		const fetchImpl = audio(wav(2), "audio/wav");
		const { tool, written } = make(fetchImpl as unknown as typeof fetch, {
			voice: "nova",
		});
		const output = await tool.execute(
			{ text: "Hello there.", path: "out/hello.wav", speed: 1.25 },
			{} as never,
		);
		const [url, init] = fetchImpl.mock.calls[0] ?? [];
		expect(String(url)).toBe("http://e2g:22434/v1/audio/speech");
		expect(JSON.parse(String(init?.body))).toEqual({
			model: "mannix/outetts:0.3",
			input: "Hello there.",
			voice: "nova",
			speed: 1.25,
		});
		expect(written[at("out/hello.wav")]?.length).toBe(wav(2).length);
		expect(output).toBe(
			"Synthesized and saved to `out/hello.wav` (wav, 2.0 s, 94 KB, voice nova).",
		);
	});

	// opencoti b97 answers WAV whatever is asked. A `.mp3` holding WAV bytes is
	// a file some players refuse, so the name follows the bytes.
	it("names the file from the bytes when the engine ignores the format", async () => {
		const { tool, written } = make(
			audio(wav(1), "audio/wav") as unknown as typeof fetch,
		);
		const output = await tool.execute(
			{ text: "Hello.", path: "hello.mp3", format: "mp3" },
			{} as never,
		);
		expect(Object.keys(written)).toEqual([at("hello.wav")]);
		expect(output).toContain("saved to `hello.wav`");
		expect(output).toContain("returned wav, not the mp3 that was asked for");
		expect(output).toContain("so its name matches its contents");
	});

	// And an engine that refuses the format outright: opencoti b97 answers 400
	// to mp3. The speech is still wanted, in whatever the engine encodes.
	it("asks again without the format when the engine cannot encode it", async () => {
		const replies = [
			new Response(
				'{"error":{"code":400,"message":"response_format mp3 is not available in this server (no encoder): use wav or pcm"}}',
				{ status: 400 },
			),
			new Response(new Uint8Array(wav(1)), {
				headers: { "content-type": "audio/wav" },
			}),
		];
		const bodies: unknown[] = [];
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return replies.shift() as Response;
		}) as unknown as typeof fetch;
		const { tool, written } = make(fetchImpl);
		const output = await tool.execute(
			{ text: "Hello.", path: "hello.mp3", format: "mp3" },
			{} as never,
		);
		expect(bodies).toEqual([
			{ model: "mannix/outetts:0.3", input: "Hello.", response_format: "mp3" },
			{ model: "mannix/outetts:0.3", input: "Hello." },
		]);
		expect(Object.keys(written)).toEqual([at("hello.wav")]);
		expect(output).toContain("returned wav, not the mp3 that was asked for");
	});

	it("uses the tab's default format, and a default path under .cline", async () => {
		const fetchImpl = audio(MP3, "audio/mpeg");
		const { tool, written } = make(fetchImpl as unknown as typeof fetch, {
			format: "mp3",
		});
		await tool.execute({ text: "Good morning, everyone." }, {} as never);
		expect(
			JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).response_format,
		).toBe("mp3");
		const [saved] = Object.keys(written);
		expect(relative(at(), saved ?? "").replaceAll("\\", "/")).toMatch(
			/^\.cline\/generated-audio\/good-morning-everyone-\d+\.mp3$/,
		);
	});

	it("hands the server's refusal to the model, and refuses an empty call", async () => {
		const refuse = (async () =>
			new Response('{"error":"model does not support speech"}', {
				status: 400,
			})) as unknown as typeof fetch;
		const { tool } = make(refuse);
		expect(await tool.execute({ text: "Hi." }, {} as never)).toContain(
			"HTTP 400",
		);
		expect(await tool.execute({}, {} as never)).toContain("needs `text`");
	});
});

describe("listSpeechVoices", () => {
	const endpoint = { baseUrl: "http://host:1/v1", model: "mannix/outetts:0.3" };

	it("asks xOllama's voices route for the model, own voices before aliases", async () => {
		const fetchImpl = vi.fn(async (_url: string) =>
			Response.json({
				default: "en_female_1",
				voices: [
					{ id: "en_female_1", aliases: ["alloy", "nova"] },
					{ id: "en_male_1", aliases: ["echo"] },
				],
				response_formats: ["wav", "pcm"],
			}),
		);
		const voices = await listSpeechVoices(endpoint, "xollama", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(fetchImpl.mock.calls[0]?.[0]).toBe(
			"http://host:1/api/xollama/media/voices?model=mannix%2Foutetts%3A0.3",
		);
		expect(voices).toEqual({
			voices: ["en_female_1", "en_male_1", "alloy", "nova", "echo"],
			default: "en_female_1",
			formats: ["wav", "pcm"],
		});
	});

	it("reads opencoti's from /props", async () => {
		const fetchImpl = vi.fn(async (_url: string) =>
			Response.json({
				media: {
					tts: {
						voices: ["default", "anna"],
						response_formats: ["wav", "pcm"],
					},
				},
			}),
		);
		const voices = await listSpeechVoices(endpoint, "opencoti", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://host:1/props");
		expect(voices).toEqual({
			voices: ["default", "anna"],
			formats: ["wav", "pcm"],
		});
	});

	it("asks nothing of a server with no such route, and survives one that fails", async () => {
		const fetchImpl = vi.fn(async () => new Response("no", { status: 500 }));
		expect(
			await listSpeechVoices(endpoint, "openai", {
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).toBeUndefined();
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(
			await listSpeechVoices(endpoint, "xollama", {
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).toBeUndefined();
	});
});

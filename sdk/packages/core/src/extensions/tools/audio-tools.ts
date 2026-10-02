/**
 * Two tools that cross between text and sound.
 *
 * `transcribe_audio` turns a recording in the workspace into text, and
 * `synthesize_speech` turns text into an audio file there. A meeting recording
 * that has to become notes, a voice-over for a demo, a prompt for a phone menu:
 * each one used to leave the session, like an image did before
 * `generate_image`.
 *
 * The wire format is the OpenAI audio API -- `POST {endpoint}/audio/
 * transcriptions` (multipart) and `POST {endpoint}/audio/speech` (JSON, bytes
 * back) -- which opencoti and xOllama serve beside chat and which the hosted
 * services serve too. The two are separate endpoints because they are often
 * separate servers: a Whisper box and a TTS box.
 *
 * Audio is never re-encoded here. What the engine returns is what is written,
 * and the file is named from what came back: opencoti b97 answers WAV whatever
 * was asked, and a `.mp3` holding WAV bytes is a file some players refuse.
 */

import * as nodePath from "node:path";
import { type AgentTool, createTool } from "@cline/shared";
import { resolveInsideWorkspace } from "./image-generation";
import {
	MediaRequestTimeoutError,
	type MediaServer,
	mediaServerOrigin,
	normalizeBaseUrl,
	sendMediaRequest,
} from "./media-endpoint";

export const TRANSCRIBE_AUDIO_TOOL_NAME = "transcribe_audio";
export const SYNTHESIZE_SPEECH_TOOL_NAME = "synthesize_speech";

export const TRANSCRIBE_AUDIO_TOOL_DESCRIPTION = `Transcribe an audio file in the workspace to text. Use it to read a recording you would otherwise have to ask the user to describe: a meeting, a voice note, the audio of a demo.

Arguments:
- \`path\` — the audio file, relative to the workspace (wav, mp3, flac, ogg, m4a, webm).
- \`format\` — \`text\` (the default), \`srt\` or \`vtt\` for subtitles with timestamps, or \`verbose_json\` for segments with start and end times.
- \`language\` — the spoken language as a two-letter code, e.g. \`en\`. Optional; the model detects it when omitted.
- \`translate\` — true to get the text in English whatever language is spoken. Optional.
- \`prompt\` — names and terms the recording uses, to help spelling. Optional.
- \`output\` — a workspace path to write the transcript to. Optional. Give one for a long recording or for subtitles: the transcript is saved there and only its beginning is returned to you.

Output: the transcript as plain text. Without \`output\`, a very long transcript is cut and the cut is stated. A long recording takes minutes.`;

export const TRANSCRIBE_AUDIO_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		path: {
			type: "string",
			description: "The audio file to transcribe, relative to the workspace.",
		},
		format: {
			type: "string",
			enum: ["text", "srt", "vtt", "verbose_json"],
			description:
				"text (default), srt or vtt for subtitles, verbose_json for timed segments.",
		},
		language: {
			type: "string",
			description:
				'The spoken language as a two-letter code, e.g. "en". Optional.',
		},
		translate: {
			type: "boolean",
			description: "True to get the text in English. Optional.",
		},
		prompt: {
			type: "string",
			description:
				"Names and terms in the recording, to help spelling. Optional.",
		},
		output: {
			type: "string",
			description:
				"Workspace path to write the transcript to. Optional; use it for long recordings and subtitles.",
		},
	},
	required: ["path"],
} as const;

export const SYNTHESIZE_SPEECH_TOOL_DESCRIPTION = `Turn text into spoken audio and save it as a file in the workspace. Use it for a voice-over, a spoken prompt, or an audio version of something you wrote.

Arguments:
- \`text\` — what to say. Write it as it should be spoken: spell out abbreviations and numbers that must be read a particular way.
- \`path\` — where to save it, relative to the workspace. Optional; defaults to a file under \`.cline/generated-audio/\`. The extension is corrected to match the audio the backend returns.
- \`voice\` — the voice to use. Optional; the configured default is used when omitted. Backends name their own voices, and most accept the OpenAI names (alloy, echo, fable, onyx, nova, shimmer).
- \`speed\` — speaking rate, 1 is normal, e.g. 1.25. Optional.
- \`format\` — \`wav\`, \`mp3\`, \`flac\`, \`opus\` or \`pcm\`. Optional, and a backend that cannot encode it returns what it can; the reply says which.

Output: the saved path, the audio format and its length. You do not hear the result, so say what you asked for when reporting it. A long text takes a while.`;

export const SYNTHESIZE_SPEECH_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		text: {
			type: "string",
			description: "What to say, written as it should be spoken.",
		},
		path: {
			type: "string",
			description:
				"Where to save it, relative to the workspace. Optional; defaults to a file under .cline/generated-audio/.",
		},
		voice: {
			type: "string",
			description: "The voice. Optional; the configured default otherwise.",
		},
		speed: {
			type: "number",
			description: "Speaking rate; 1 is normal. Optional.",
		},
		format: {
			type: "string",
			enum: ["wav", "mp3", "flac", "opus", "pcm"],
			description: "The audio format to ask for. Optional.",
		},
	},
	required: ["text"],
} as const;

export interface TranscriptionEndpoint {
	/** Base URL, with or without a trailing `/v1`. */
	baseUrl: string;
	model: string;
	apiKey?: string;
}

export interface SpeechEndpoint extends TranscriptionEndpoint {
	/** Default for calls that name no voice. */
	voice?: string;
	/** Default for calls that name no format. */
	format?: string;
}

type MaybePromise<T> = T | Promise<T>;

interface AudioToolBase {
	cwd: string;
	fetchImpl?: typeof fetch;
	onError?: (message: string, error: unknown) => void;
}

export interface TranscribeAudioToolOptions extends AudioToolBase {
	getEndpoint: () => MaybePromise<TranscriptionEndpoint | undefined>;
	readFile: (absolutePath: string) => Promise<Buffer>;
	writeFile: (absolutePath: string, data: Buffer) => Promise<void>;
	/** Milliseconds one transcription may take. Defaults to 15 minutes. */
	timeoutMs?: number;
	/** Characters of transcript returned to the model. Defaults to 24,000. */
	maxReturnedChars?: number;
}

export interface SynthesizeSpeechToolOptions extends AudioToolBase {
	getEndpoint: () => MaybePromise<SpeechEndpoint | undefined>;
	writeFile: (absolutePath: string, data: Buffer) => Promise<void>;
	/** Milliseconds one synthesis may take. Defaults to 5 minutes. */
	timeoutMs?: number;
}

const AUDIO_TYPES: Record<string, string> = {
	".wav": "audio/wav",
	".mp3": "audio/mpeg",
	".flac": "audio/flac",
	".ogg": "audio/ogg",
	".opus": "audio/ogg",
	".m4a": "audio/mp4",
	".mp4": "audio/mp4",
	".webm": "audio/webm",
	".aac": "audio/aac",
};

/**
 * What the bytes are, according to the bytes, as a file extension.
 *
 * Trusted ahead of the header and the request for the image tool's reason: the
 * engine decides, and one of them answers WAV to a request for mp3.
 */
export function sniffAudioExtension(data: Buffer): string | undefined {
	const starts = (...bytes: number[]) =>
		bytes.every((byte, index) => data[index] === byte);
	const tag = (offset: number, length: number) =>
		data.subarray(offset, offset + length).toString("latin1");
	if (tag(0, 4) === "RIFF" && tag(8, 4) === "WAVE") return ".wav";
	if (tag(0, 3) === "ID3") return ".mp3";
	// An MPEG audio frame: eleven sync bits, then a layer that is not 0.
	if (data[0] === 0xff && ((data[1] ?? 0) & 0xe6) > 0xe0) return ".mp3";
	if (tag(0, 4) === "fLaC") return ".flac";
	if (tag(0, 4) === "OggS") return ".ogg";
	if (tag(4, 4) === "ftyp") return ".m4a";
	if (starts(0x1a, 0x45, 0xdf, 0xa3)) return ".webm";
	return undefined;
}

const EXTENSION_OF_CONTENT_TYPE: Record<string, string> = {
	"audio/wav": ".wav",
	"audio/x-wav": ".wav",
	"audio/wave": ".wav",
	"audio/mpeg": ".mp3",
	"audio/mp3": ".mp3",
	"audio/flac": ".flac",
	"audio/ogg": ".ogg",
	"audio/opus": ".opus",
	"audio/aac": ".aac",
	"audio/mp4": ".m4a",
	"audio/webm": ".webm",
	"audio/pcm": ".pcm",
	"audio/l16": ".pcm",
};

/** The extension the returned audio should carry. */
export function audioExtension(
	data: Buffer,
	contentType: string | null,
	requestedFormat: string | undefined,
): string {
	const sniffed = sniffAudioExtension(data);
	if (sniffed) return sniffed;
	const declared = contentType?.split(";")[0]?.trim().toLowerCase();
	if (declared && EXTENSION_OF_CONTENT_TYPE[declared]) {
		return EXTENSION_OF_CONTENT_TYPE[declared];
	}
	return requestedFormat ? `.${requestedFormat}` : ".wav";
}

/** Seconds of audio in a WAV, from its own header. Nothing for other formats. */
export function wavSeconds(data: Buffer): number | undefined {
	if (sniffAudioExtension(data) !== ".wav" || data.length < 44) {
		return undefined;
	}
	let offset = 12;
	let byteRate: number | undefined;
	while (offset + 8 <= data.length) {
		const id = data.subarray(offset, offset + 4).toString("latin1");
		const size = data.readUInt32LE(offset + 4);
		if (id === "fmt " && offset + 20 <= data.length) {
			byteRate = data.readUInt32LE(offset + 16);
		}
		if (id === "data") {
			if (!byteRate) return undefined;
			// A streamed WAV leaves the size at 0 or 0xFFFFFFFF.
			const bytes =
				size === 0 || size === 0xffffffff
					? data.length - offset - 8
					: Math.min(size, data.length - offset - 8);
			return bytes / byteRate;
		}
		offset += 8 + size + (size % 2);
	}
	return undefined;
}

/** A filename that says what was said, for the same reason an image gets one. */
export function defaultSpeechPath(text: string, now: number): string {
	const slug =
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.split("-")
			.filter(Boolean)
			.slice(0, 6)
			.join("-") || "speech";
	return nodePath.posix.join(".cline", "generated-audio", `${slug}-${now}.wav`);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
	return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Larger than this is refused before anything is sent. */
const MAX_AUDIO_BYTES = 512 * 1024 * 1024;

const TRANSCRIPT_FORMATS = new Set(["text", "srt", "vtt", "verbose_json"]);

export function createTranscribeAudioTool(
	options: TranscribeAudioToolOptions,
): AgentTool {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? 15 * 60_000;
	const maxReturnedChars = options.maxReturnedChars ?? 24_000;

	return createTool({
		name: TRANSCRIBE_AUDIO_TOOL_NAME,
		description: TRANSCRIBE_AUDIO_TOOL_DESCRIPTION,
		inputSchema: TRANSCRIBE_AUDIO_TOOL_INPUT_SCHEMA,
		execute: async (input: unknown, context): Promise<string> => {
			const request = (input ?? {}) as Record<string, unknown>;
			const relativePath = text(request.path);
			if (!relativePath) {
				return "`transcribe_audio` needs a `path`: the audio file to transcribe, relative to the workspace.";
			}
			const format = text(request.format) || "text";
			if (!TRANSCRIPT_FORMATS.has(format)) {
				return `\`${format}\` is not a transcript format. Use text, srt, vtt or verbose_json.`;
			}
			const endpoint = await options.getEndpoint();
			if (!endpoint?.baseUrl || !endpoint.model) {
				return (
					"No speech-to-text endpoint is configured, so nothing was transcribed. " +
					"The user names one on the Audio tab of the API configuration settings; " +
					"tell them that rather than trying again."
				);
			}
			const absolutePath = resolveInsideWorkspace(options.cwd, relativePath);
			if (!absolutePath) {
				return `\`${relativePath}\` is outside the workspace. Transcribe a file that is under the project.`;
			}
			const outputPath = text(request.output) || undefined;
			const absoluteOutput = outputPath
				? resolveInsideWorkspace(options.cwd, outputPath)
				: undefined;
			if (outputPath && !absoluteOutput) {
				return `\`${outputPath}\` is outside the workspace. Save the transcript somewhere under the project.`;
			}

			let audio: Buffer;
			try {
				audio = await options.readFile(absolutePath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Could not read \`${relativePath}\`: ${message}`;
			}
			if (audio.length === 0) {
				return `\`${relativePath}\` is empty.`;
			}
			if (audio.length > MAX_AUDIO_BYTES) {
				return `\`${relativePath}\` is ${Math.round(audio.length / 1048576)} MB, more than this tool sends in one request. Split it first.`;
			}
			const extension = nodePath.extname(absolutePath).toLowerCase();
			const mediaType =
				AUDIO_TYPES[extension] ??
				AUDIO_TYPES[sniffAudioExtension(audio) ?? ""] ??
				"application/octet-stream";

			const translate = request.translate === true;
			const route = translate ? "translations" : "transcriptions";
			// `text` is asked for as JSON and unwrapped here: every server
			// answers `{text}`, and not every one implements the plain format.
			const wireFormat = format === "text" ? "json" : format;
			const signal = context?.signal;

			try {
				const response = await sendMediaRequest(
					`${normalizeBaseUrl(endpoint.baseUrl)}/audio/${route}`,
					(): RequestInit => {
						const form = new FormData();
						form.append("model", endpoint.model);
						form.append("response_format", wireFormat);
						const language = text(request.language);
						if (language && !translate) form.append("language", language);
						const prompt = text(request.prompt);
						if (prompt) form.append("prompt", prompt);
						form.append(
							"file",
							new Blob([new Uint8Array(audio)], { type: mediaType }),
							nodePath.basename(absolutePath),
						);
						return {
							method: "POST",
							headers: authHeaders(endpoint.apiKey),
							body: form,
						};
					},
					{
						fetchImpl,
						signal,
						attemptTimeoutMs: timeoutMs,
						onBusy: (waitMs) =>
							context?.emitUpdate?.({
								status: `The speech-to-text engine is busy; asking again in ${Math.round(waitMs / 1000)}s.`,
							}),
					},
				);
				if (response.status === 503) {
					return "The speech-to-text engine is still busy with other requests after a long wait, so nothing was transcribed. Nothing is wrong with the request; try again later.";
				}
				const body = await response.text();
				if (!response.ok) {
					return `The speech-to-text endpoint refused the request (HTTP ${response.status}).${body ? `\n\n${body.slice(0, 400)}` : ""}`;
				}

				let transcript = body;
				if (format === "text") {
					try {
						const parsed = JSON.parse(body) as { text?: unknown };
						if (typeof parsed.text === "string") transcript = parsed.text;
					} catch {
						// A server that answered plain text to a JSON request.
					}
				}
				transcript = transcript.trim();
				if (!transcript) {
					return `The speech-to-text endpoint returned no text for \`${relativePath}\`: the recording may be silent.`;
				}

				if (absoluteOutput && outputPath) {
					await options.writeFile(
						absoluteOutput,
						Buffer.from(`${transcript}\n`, "utf8"),
					);
					const head = transcript.slice(0, 2_000);
					return (
						`Transcribed \`${relativePath}\` and saved ${transcript.length} characters to \`${outputPath}\`.` +
						`\n\n${head}${transcript.length > head.length ? "\n\n[The rest is in the file.]" : ""}`
					);
				}
				if (transcript.length > maxReturnedChars) {
					return (
						`${transcript.slice(0, maxReturnedChars)}\n\n` +
						`[Cut here: the transcript is ${transcript.length} characters and ${maxReturnedChars} are shown. ` +
						"Call again with `output` to save all of it to a file.]"
					);
				}
				return transcript;
			} catch (error) {
				if (error instanceof MediaRequestTimeoutError || signal?.aborted) {
					return `The transcription was stopped before it finished (the limit is ${Math.round(timeoutMs / 1000)}s).`;
				}
				options.onError?.("[transcribe_audio] request failed", error);
				const message = error instanceof Error ? error.message : String(error);
				return `Could not reach the speech-to-text endpoint: ${message}`;
			}
		},
	});
}

const SPEECH_FORMATS = new Set(["wav", "mp3", "flac", "opus", "pcm", "aac"]);

export function createSynthesizeSpeechTool(
	options: SynthesizeSpeechToolOptions,
): AgentTool {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? 5 * 60_000;

	return createTool({
		name: SYNTHESIZE_SPEECH_TOOL_NAME,
		description: SYNTHESIZE_SPEECH_TOOL_DESCRIPTION,
		inputSchema: SYNTHESIZE_SPEECH_TOOL_INPUT_SCHEMA,
		execute: async (input: unknown, context): Promise<string> => {
			const request = (input ?? {}) as Record<string, unknown>;
			const spoken = text(request.text);
			if (!spoken) {
				return "`synthesize_speech` needs `text`: what to say.";
			}
			const endpoint = await options.getEndpoint();
			if (!endpoint?.baseUrl || !endpoint.model) {
				return (
					"No text-to-speech endpoint is configured, so no audio was made. " +
					"The user names one on the Audio tab of the API configuration settings; " +
					"tell them that rather than trying again."
				);
			}
			const format = (text(request.format) || text(endpoint.format))
				.toLowerCase()
				.replace(/^\./, "");
			if (format && !SPEECH_FORMATS.has(format)) {
				return `\`${format}\` is not an audio format this tool asks for. Use wav, mp3, flac, opus or pcm.`;
			}
			const voice = text(request.voice) || text(endpoint.voice);
			const speed =
				typeof request.speed === "number" &&
				Number.isFinite(request.speed) &&
				request.speed > 0
					? request.speed
					: undefined;

			const askedPath = text(request.path) || undefined;
			const requestedPath = askedPath ?? defaultSpeechPath(spoken, Date.now());
			const absolutePath = resolveInsideWorkspace(options.cwd, requestedPath);
			if (!absolutePath) {
				return `\`${requestedPath}\` is outside the workspace. Save the audio somewhere under the project.`;
			}
			const signal = context?.signal;

			try {
				const send = (responseFormat: string | undefined) =>
					sendMediaRequest(
						`${normalizeBaseUrl(endpoint.baseUrl)}/audio/speech`,
						(): RequestInit => ({
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								...authHeaders(endpoint.apiKey),
							},
							body: JSON.stringify({
								model: endpoint.model,
								input: spoken,
								...(voice ? { voice } : {}),
								...(responseFormat ? { response_format: responseFormat } : {}),
								...(speed ? { speed } : {}),
							}),
						}),
						{
							fetchImpl,
							signal,
							attemptTimeoutMs: timeoutMs,
							onBusy: (waitMs) =>
								context?.emitUpdate?.({
									status: `The speech engine is busy; asking again in ${Math.round(waitMs / 1000)}s.`,
								}),
						},
					);
				let response = await send(format || undefined);
				// An engine with no encoder for the format refuses it outright
				// (opencoti b97 answers 400 to mp3: "use wav or pcm"). The speech
				// is what was wanted, so ask again for whatever it does encode;
				// the report says which format came back.
				if (format && response.status === 400) {
					const refusal = await response
						.clone()
						.text()
						.catch(() => "");
					if (/response_format|\bformat\b|encoder/i.test(refusal)) {
						response = await send(undefined);
					}
				}
				if (response.status === 503) {
					return "The speech engine is still busy with other requests after a long wait, so no audio was made. Nothing is wrong with the request; try again later.";
				}
				if (!response.ok) {
					const detail = (await response.text().catch(() => "")).slice(0, 400);
					return `The text-to-speech endpoint refused the request (HTTP ${response.status}).${detail ? `\n\n${detail}` : ""}`;
				}
				const data = Buffer.from(await response.arrayBuffer());
				if (data.length === 0) {
					return "The text-to-speech endpoint returned no audio.";
				}

				// Named from what came back. The engine decides the encoding, and
				// a file whose name disagrees with its bytes is one players refuse.
				const extension = audioExtension(
					data,
					response.headers.get("content-type"),
					format || undefined,
				);
				const current = nodePath.extname(requestedPath);
				const savedPath =
					current.toLowerCase() === extension
						? requestedPath
						: `${current ? requestedPath.slice(0, -current.length) : requestedPath}${extension}`;
				const absoluteSaved = resolveInsideWorkspace(options.cwd, savedPath);
				if (!absoluteSaved) {
					return `\`${savedPath}\` is outside the workspace. Save the audio somewhere under the project.`;
				}
				await options.writeFile(absoluteSaved, data);

				const seconds = wavSeconds(data);
				const got = extension.slice(1);
				const notes: string[] = [];
				if (format && got !== format && !(format === "opus" && got === "ogg")) {
					notes.push(
						`The backend returned ${got}, not the ${format} that was asked for.`,
					);
				}
				if (askedPath && savedPath !== askedPath) {
					notes.push(
						`The file was saved as \`${savedPath}\` so its name matches its contents.`,
					);
				}
				return (
					`Synthesized and saved to \`${savedPath}\` (${got}` +
					`${seconds !== undefined ? `, ${seconds.toFixed(1)} s` : ""}` +
					`, ${Math.max(1, Math.round(data.length / 1024))} KB` +
					`${voice ? `, voice ${voice}` : ""}).` +
					`${notes.length ? `\n\n${notes.join(" ")}` : ""}`
				);
			} catch (error) {
				if (error instanceof MediaRequestTimeoutError || signal?.aborted) {
					return `The speech synthesis was stopped before it finished (the limit is ${Math.round(timeoutMs / 1000)}s).`;
				}
				options.onError?.("[synthesize_speech] request failed", error);
				const message = error instanceof Error ? error.message : String(error);
				return `Could not reach the text-to-speech endpoint: ${message}`;
			}
		},
	});
}

/** What a speech engine says it can do, for a settings picker. */
export interface SpeechVoices {
	/** The engine's own voices first, then the OpenAI names it also answers to. */
	voices: string[];
	default?: string;
	/** The `response_format` values the engine encodes. */
	formats: string[];
}

const strings = (value: unknown): string[] =>
	Array.isArray(value)
		? value
				.map((entry) =>
					typeof entry === "string"
						? entry
						: typeof (entry as { id?: unknown })?.id === "string"
							? (entry as { id: string }).id
							: "",
				)
				.filter(Boolean)
		: [];

/**
 * The voices and formats of a speech endpoint, where the server can say.
 *
 * The OpenAI API has no route for this, so only the two servers that added one
 * answer: opencoti in `/props` (`media.tts`), xOllama at
 * `/api/xollama/media/voices`. Anything else is `undefined`, which is "type
 * the name", not "no voices".
 *
 * Call it when the user asks, not when a pane opens: xOllama starts the speech
 * engine to answer, and that is seconds of load and gigabytes of memory nobody
 * asked for.
 */
export async function listSpeechVoices(
	endpoint: TranscriptionEndpoint,
	server: MediaServer | "unknown",
	options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<SpeechVoices | undefined> {
	if (server !== "opencoti" && server !== "xollama") {
		return undefined;
	}
	const fetchImpl = options.fetchImpl ?? fetch;
	const origin = mediaServerOrigin(endpoint.baseUrl);
	const headers: Record<string, string> = {};
	if (endpoint.apiKey) {
		headers.Authorization = `Bearer ${endpoint.apiKey}`;
	}
	const url =
		server === "xollama"
			? `${origin}/api/xollama/media/voices?model=${encodeURIComponent(endpoint.model)}`
			: `${origin}/props`;
	try {
		const response = await fetchImpl(url, {
			headers,
			// An engine that has to load first is the slow case.
			signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
		});
		if (!response.ok) {
			return undefined;
		}
		const body = (await response.json()) as Record<string, unknown>;
		const source = (
			server === "xollama"
				? body
				: ((body.media as Record<string, unknown> | undefined)?.tts ?? {})
		) as Record<string, unknown>;
		const own = strings(source.voices);
		const aliases = Array.isArray(source.voices)
			? source.voices.flatMap((voice) =>
					strings((voice as { aliases?: unknown })?.aliases),
				)
			: [];
		const voices = [...new Set([...own, ...aliases])];
		const formats = strings(source.response_formats);
		if (voices.length === 0 && formats.length === 0) {
			return undefined;
		}
		return {
			voices,
			...(typeof source.default === "string" && source.default
				? { default: source.default }
				: {}),
			formats,
		};
	} catch {
		return undefined;
	}
}

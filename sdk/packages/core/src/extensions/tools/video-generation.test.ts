import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	createGenerateVideoTool,
	sniffVideoExtension,
} from "./video-generation";

/** A path under the test workspace, in the running platform's form. */
const at = (...parts: string[]) => resolve("/work", ...parts);

const MP4 = Buffer.concat([
	Buffer.from([0, 0, 0, 0x20]),
	Buffer.from("ftypisom", "latin1"),
	Buffer.alloc(2048),
]);
const AVI = Buffer.concat([
	Buffer.from("RIFF", "latin1"),
	Buffer.alloc(4),
	Buffer.from("AVI LIST", "latin1"),
	Buffer.alloc(64),
]);
const PNG = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

interface Call {
	method: string;
	url: string;
	body?: unknown;
}

/** A videos API whose job answers `polls` in turn, then serves `content`. */
function server(input: {
	create?: (call: Call, n: number) => Response;
	polls?: Array<Record<string, unknown> | Response>;
	content?: Response;
}) {
	const calls: Call[] = [];
	let creates = 0;
	const polls = [...(input.polls ?? [])];
	const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
		const method = init?.method ?? "GET";
		const body =
			typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
		const call = { method, url, body };
		calls.push(call);
		if (method === "POST") {
			creates += 1;
			return (
				input.create?.(call, creates) ??
				Response.json({ id: "video_1", status: "queued", progress: 0 })
			);
		}
		if (method === "DELETE") {
			return Response.json({ id: "video_1", deleted: true });
		}
		if (url.endsWith("/content")) {
			return (
				input.content ??
				new Response(new Uint8Array(MP4), {
					headers: { "content-type": "video/mp4" },
				})
			);
		}
		const next = polls.shift() ?? { id: "video_1", status: "completed" };
		return next instanceof Response ? next : Response.json(next);
	});
	return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function tool(
	fetchImpl: typeof fetch,
	extra: Partial<Parameters<typeof createGenerateVideoTool>[0]> = {},
	endpoint: Record<string, unknown> = {},
) {
	const written: Array<{ path: string; data: Buffer }> = [];
	const updates: unknown[] = [];
	const created = createGenerateVideoTool({
		cwd: at(),
		getEndpoint: () => ({
			baseUrl: "http://host:1",
			model: "wan2.1",
			apiKey: "sk-v",
			...endpoint,
		}),
		readFile: async () => PNG,
		writeFile: async (path, data) => {
			written.push({ path, data });
		},
		fetchImpl,
		sleep: async () => {},
		...extra,
	});
	const run = (input: unknown, signal?: AbortSignal) =>
		created.execute(input, {
			signal,
			emitUpdate: (update: unknown) => updates.push(update),
		} as never) as Promise<string>;
	return { run, written, updates };
}

describe("what the bytes are", () => {
	it("tells mp4, avi and webm apart", () => {
		expect(sniffVideoExtension(MP4)).toBe(".mp4");
		expect(sniffVideoExtension(AVI)).toBe(".avi");
		expect(
			sniffVideoExtension(
				Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]),
			),
		).toBe(".webm");
		expect(sniffVideoExtension(Buffer.from("hello world!"))).toBeUndefined();
	});
});

describe("generate_video", () => {
	it("creates a job, waits for it, and saves the clip", async () => {
		const { calls, fetchImpl } = server({
			polls: [
				{ id: "video_1", status: "queued", queue_position: 1 },
				{ id: "video_1", status: "in_progress", progress: 45 },
				{
					id: "video_1",
					status: "completed",
					progress: 100,
					seconds: "2",
					size: "832x480",
					fps: 16,
				},
			],
		});
		const { run, written, updates } = tool(fetchImpl);
		const result = await run({
			prompt: "A lighthouse at dusk",
			path: "out/clip.mp4",
			size: "832x480",
			seconds: 2,
			seed: 7,
		});

		expect(calls[0]).toEqual({
			method: "POST",
			url: "http://host:1/v1/videos",
			body: {
				model: "wan2.1",
				prompt: "A lighthouse at dusk",
				size: "832x480",
				seconds: "2",
				seed: 7,
			},
		});
		expect(calls.slice(1).map((call) => `${call.method} ${call.url}`)).toEqual([
			"GET http://host:1/v1/videos/video_1",
			"GET http://host:1/v1/videos/video_1",
			"GET http://host:1/v1/videos/video_1",
			"GET http://host:1/v1/videos/video_1/content",
		]);
		expect(written).toHaveLength(1);
		expect(written[0]?.path).toBe(at("out/clip.mp4"));
		expect(written[0]?.data.equals(MP4)).toBe(true);
		expect(result).toContain(
			"saved to `out/clip.mp4` (mp4, 832x480, 2 s, 16 fps, 2 KB)",
		);
		expect(updates).toEqual([
			{ status: "Waiting for the video engine." },
			{ status: "Waiting for the video engine (position 1 in its queue)." },
			{ status: "Rendering the clip: 45%." },
		]);
	});

	it("names the file from the bytes, and says so", async () => {
		const { fetchImpl } = server({
			content: new Response(new Uint8Array(AVI), {
				headers: { "content-type": "video/x-msvideo" },
			}),
		});
		const { run, written } = tool(fetchImpl);
		const result = await run({ prompt: "x", path: "clip.mp4" });
		expect(written[0]?.path).toBe(at("clip.avi"));
		expect(result).toContain(
			"saved as `clip.avi` so its name matches its contents",
		);
	});

	it("sends a start image as multipart input_reference", async () => {
		const { calls, fetchImpl } = server({});
		const { run } = tool(fetchImpl);
		await run({ prompt: "the fox turns its head", image: "art/fox.png" });
		const form = calls[0]?.body as FormData;
		expect(form).toBeInstanceOf(FormData);
		expect(form.get("model")).toBe("wan2.1");
		expect(form.get("prompt")).toBe("the fox turns its head");
		expect((form.get("input_reference") as File).name).toBe("fox.png");
	});

	it("asks again without the container an engine refuses", async () => {
		const { calls, fetchImpl } = server({
			create: (_call, n) =>
				n === 1
					? Response.json(
							{
								error: {
									message: "output_format mp4 needs the codec sidecar: use avi",
								},
							},
							{ status: 501 },
						)
					: Response.json({ id: "video_1", status: "completed" }),
		});
		const { run, written } = tool(fetchImpl, {}, { format: "mp4" });
		await run({ prompt: "x" });
		const posts = calls.filter((call) => call.method === "POST");
		expect((posts[0]?.body as { output_format?: string }).output_format).toBe(
			"mp4",
		);
		expect(posts[1]?.body).not.toHaveProperty("output_format");
		expect(written).toHaveLength(1);
	});

	it("reports a failed job with the engine's reason, and saves nothing", async () => {
		const { calls, fetchImpl } = server({
			polls: [
				{
					id: "video_1",
					status: "failed",
					error: { code: "generation_failed", message: "out of memory" },
				},
			],
		});
		const { run, written } = tool(fetchImpl);
		expect(await run({ prompt: "x" })).toBe(
			"The video engine failed the clip: out of memory",
		);
		expect(written).toHaveLength(0);
		// A job that ended needs no cancel.
		expect(calls.some((call) => call.method === "DELETE")).toBe(false);
	});

	it("survives a dropped poll: the job runs on the server regardless", async () => {
		const { fetchImpl } = server({
			polls: [
				new Response("bad gateway", { status: 502 }),
				{ id: "video_1", status: "in_progress", progress: 80 },
			],
		});
		const { run, written } = tool(fetchImpl);
		expect(await run({ prompt: "x" })).toContain("Generated and saved");
		expect(written).toHaveLength(1);
	});

	it("deletes its job when the caller stops", async () => {
		const stop = new AbortController();
		const { calls, fetchImpl } = server({
			polls: [{ id: "video_1", status: "in_progress", progress: 10 }],
		});
		const { run, written } = tool(fetchImpl, {
			sleep: async () => stop.abort(),
		});
		expect(await run({ prompt: "x" }, stop.signal)).toBe(
			"The video generation was stopped before it finished, and its job was cancelled.",
		);
		await Promise.resolve();
		expect(written).toHaveLength(0);
		expect(calls.at(-1)).toMatchObject({
			method: "DELETE",
			url: "http://host:1/v1/videos/video_1",
		});
	});

	it("says what the endpoint said when it refuses", async () => {
		const { fetchImpl } = server({
			create: () =>
				Response.json(
					{ error: { message: "this video model generates from text only" } },
					{ status: 400 },
				),
		});
		const { run } = tool(fetchImpl);
		expect(await run({ prompt: "x", image: "a.png" })).toBe(
			"The video endpoint refused the request (HTTP 400).\n\nthis video model generates from text only",
		);
	});

	it("refuses paths outside the workspace and a missing prompt before any request", async () => {
		const { calls, fetchImpl } = server({});
		const { run } = tool(fetchImpl);
		expect(await run({ prompt: "x", path: "../clip.mp4" })).toContain(
			"outside the workspace",
		);
		expect(await run({ prompt: "x", image: "../../secret.png" })).toContain(
			"outside the workspace",
		);
		expect(await run({})).toContain("needs a `prompt`");
		expect(calls).toHaveLength(0);
	});
});

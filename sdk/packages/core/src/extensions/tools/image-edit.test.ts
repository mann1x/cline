import { describe, expect, it, vi } from "vitest";
import { createEditImageTool, parseImagePaths } from "./image-edit";

/** The smallest thing the sniffer calls a PNG. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const RESULT = PNG.toString("base64");

function makeTool(
	fetchImpl: typeof fetch,
	files: Record<string, Buffer> = { "/ws/icon.png": PNG, "/ws/ref.jpg": JPEG },
) {
	const written: Record<string, Buffer> = {};
	const tool = createEditImageTool({
		cwd: "/ws",
		getEndpoint: async () => ({
			baseUrl: "http://e2g:22434",
			model: "mannix/flux2-klein:4b",
			apiKey: "key",
		}),
		readFile: async (path) => {
			const data = files[path];
			if (!data) throw new Error("ENOENT");
			return data;
		},
		writeFile: async (path, data) => {
			written[path] = data;
		},
		fetchImpl,
	});
	return { tool, written };
}

const ok = () =>
	vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) =>
			new Response(JSON.stringify({ data: [{ b64_json: RESULT }] })),
	);

describe("edit_image", () => {
	it("posts the images as image[] with the instruction, as multipart", async () => {
		const fetchImpl = ok();
		const { tool, written } = makeTool(fetchImpl as unknown as typeof fetch);
		const output = await tool.execute(
			{
				prompt: "make the background transparent",
				images: ["icon.png", "ref.jpg"],
				path: "out/icon.png",
				size: "512x512",
			},
			{ metadata: { modelSupportsImages: true } } as never,
		);

		const [url, init] = fetchImpl.mock.calls[0] ?? [];
		expect(String(url)).toBe("http://e2g:22434/v1/images/edits");
		expect(init?.headers).toEqual({ Authorization: "Bearer key" });
		const form = init?.body as FormData;
		expect(form.get("model")).toBe("mannix/flux2-klein:4b");
		expect(form.get("prompt")).toBe("make the background transparent");
		expect(form.get("size")).toBe("512x512");
		expect(form.get("response_format")).toBe("b64_json");
		const images = form.getAll("image[]") as File[];
		expect(images.map((image) => [image.name, image.type])).toEqual([
			["icon.png", "image/png"],
			["ref.jpg", "image/jpeg"],
		]);
		expect(form.get("mask")).toBeNull();

		expect(written["/ws/out/icon.png"]).toEqual(PNG);
		expect(output).toEqual([
			{
				type: "text",
				text: "Edited and saved to `out/icon.png` (512x512).",
			},
			{ type: "image", data: RESULT, mediaType: "image/png" },
		]);
	});

	it("sends a mask when one is named, and accepts a single path as a string", async () => {
		const fetchImpl = ok();
		const { tool } = makeTool(fetchImpl as unknown as typeof fetch, {
			"/ws/icon.png": PNG,
			"/ws/mask.png": PNG,
		});
		await tool.execute(
			{ prompt: "remove the door", images: "icon.png", mask: "mask.png" },
			{} as never,
		);
		const form = fetchImpl.mock.calls[0]?.[1]?.body as FormData;
		expect((form.getAll("image[]") as File[]).length).toBe(1);
		expect((form.get("mask") as File).name).toBe("mask.png");
	});

	it("builds the body again for each attempt on a busy engine", async () => {
		const replies = [
			new Response("busy", { status: 503, headers: { "retry-after": "1" } }),
			new Response(JSON.stringify({ data: [{ b64_json: RESULT }] })),
		];
		const bodies: unknown[] = [];
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			bodies.push(init?.body);
			return replies.shift() as Response;
		}) as unknown as typeof fetch;
		const { tool } = makeTool(fetchImpl);
		vi.useFakeTimers();
		const run = tool.execute(
			{ prompt: "p", images: ["icon.png"] },
			{} as never,
		);
		await vi.advanceTimersByTimeAsync(1_500);
		const output = await run;
		vi.useRealTimers();
		expect(bodies).toHaveLength(2);
		expect(bodies[0]).not.toBe(bodies[1]);
		expect(String(output)).toContain("Edited and saved to");
	});

	it("refuses what it cannot send, before calling anything", async () => {
		const fetchImpl = ok();
		const { tool } = makeTool(fetchImpl as unknown as typeof fetch, {
			"/ws/icon.png": PNG,
			"/ws/notes.txt": Buffer.from("hello"),
		});
		const run = (input: object) => tool.execute(input, {} as never);
		expect(await run({ images: ["icon.png"] })).toContain("needs a `prompt`");
		expect(await run({ prompt: "p" })).toContain("needs `images`");
		expect(await run({ prompt: "p", images: ["../x.png"] })).toContain(
			"outside the workspace",
		);
		expect(await run({ prompt: "p", images: ["gone.png"] })).toContain(
			"Could not read `gone.png`",
		);
		expect(await run({ prompt: "p", images: ["notes.txt"] })).toContain(
			"is not an image",
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("hands the server's refusal to the model as it is", async () => {
		const fetchImpl = (async () =>
			new Response(
				'{"error":{"message":"model does not support image edits"}}',
				{
					status: 400,
				},
			)) as unknown as typeof fetch;
		const { tool } = makeTool(fetchImpl);
		expect(
			await tool.execute({ prompt: "p", images: ["icon.png"] }, {} as never),
		).toContain("HTTP 400");
	});
});

describe("parseImagePaths", () => {
	it("takes a list or one path, and drops what is not a path", () => {
		expect(parseImagePaths([" a.png ", "", 3, "b.png"])).toEqual([
			"a.png",
			"b.png",
		]);
		expect(parseImagePaths("a.png")).toEqual(["a.png"]);
		expect(parseImagePaths(undefined)).toEqual([]);
	});
});

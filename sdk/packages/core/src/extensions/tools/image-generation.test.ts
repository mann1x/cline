import { describe, expect, it, vi } from "vitest";
import {
	createGenerateImageTool,
	defaultImagePath,
	type ImageGenerationEndpoint,
	normalizeBaseUrl,
	parseSize,
	readGeneratedImage,
	resolveInsideWorkspace,
} from "./image-generation";

const PNG_BASE64 = Buffer.from("not really a png").toString("base64");

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

interface RunOptions {
	/** `null` means "configured with nothing", which is not the same as omitted. */
	endpoint?: ImageGenerationEndpoint | null;
	fetchImpl?: typeof fetch;
	modelSupportsImages?: boolean;
	writeFile?: (path: string, data: Buffer) => Promise<void>;
}

function run(input: Record<string, unknown>, options: RunOptions = {}) {
	const tool = createGenerateImageTool({
		cwd: "/workspace",
		getEndpoint: () =>
			options.endpoint === undefined
				? { baseUrl: "http://localhost:8080", model: "z-image" }
				: (options.endpoint ?? undefined),
		writeFile: options.writeFile ?? (async () => {}),
		fetchImpl:
			options.fetchImpl ??
			(vi.fn(async () =>
				jsonResponse({ data: [{ b64_json: PNG_BASE64 }] }),
			) as unknown as typeof fetch),
	});
	return tool.execute(input, {
		metadata: { modelSupportsImages: options.modelSupportsImages ?? true },
	} as never);
}

describe("normalizeBaseUrl", () => {
	it("adds the version segment the user did not type", () => {
		expect(normalizeBaseUrl("http://localhost:8080")).toBe(
			"http://localhost:8080/v1",
		);
		expect(normalizeBaseUrl("http://localhost:8080/")).toBe(
			"http://localhost:8080/v1",
		);
	});

	it("leaves one that is already there", () => {
		expect(normalizeBaseUrl("https://api.example.com/v1")).toBe(
			"https://api.example.com/v1",
		);
		expect(normalizeBaseUrl("https://api.example.com/v2/")).toBe(
			"https://api.example.com/v2",
		);
	});
});

describe("defaultImagePath", () => {
	it("names the file after the prompt", () => {
		expect(defaultImagePath("A flat vector rocket icon", 1700)).toBe(
			".cline/generated-images/a-flat-vector-rocket-icon-1700.png",
		);
	});

	it("still produces a name for a prompt with nothing nameable in it", () => {
		expect(defaultImagePath("!!! ???", 1700)).toBe(
			".cline/generated-images/image-1700.png",
		);
	});
});

describe("resolveInsideWorkspace", () => {
	it("accepts a path under the workspace", () => {
		expect(resolveInsideWorkspace("/workspace", "assets/icon.png")).toBe(
			"/workspace/assets/icon.png",
		);
	});

	// The path comes from the model, and this is the only thing standing
	// between it and writing anywhere on the disk.
	it("refuses a path that climbs out", () => {
		expect(
			resolveInsideWorkspace("/workspace", "../../.ssh/authorized_keys"),
		).toBeUndefined();
		expect(resolveInsideWorkspace("/workspace", "/etc/passwd")).toBeUndefined();
	});

	// `/workspace-other` starts with `/workspace` and is not inside it.
	it("is not fooled by a sibling with the same prefix", () => {
		expect(
			resolveInsideWorkspace("/workspace", "../workspace-other/x.png"),
		).toBeUndefined();
	});
});

describe("parseSize", () => {
	it("takes a WxH and normalizes it", () => {
		expect(parseSize("1024x1024")).toBe("1024x1024");
		expect(parseSize(" 512 × 768 ")).toBe("512x768");
	});

	it("rejects anything else rather than passing it on", () => {
		expect(parseSize("big")).toBeUndefined();
		expect(parseSize("1024")).toBeUndefined();
		expect(parseSize(undefined)).toBeUndefined();
	});
});

describe("readGeneratedImage", () => {
	const neverFetched = vi.fn() as unknown as typeof fetch;

	it("reads inline base64", async () => {
		const result = await readGeneratedImage(
			{ data: [{ b64_json: PNG_BASE64 }] },
			neverFetched,
			undefined,
		);
		expect(result).toMatchObject({ mediaType: "image/png" });
		expect(neverFetched).not.toHaveBeenCalled();
	});

	// Plenty of local servers ignore `response_format` and answer with a URL.
	it("fetches a URL when that is what came back", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(Buffer.from("bytes"), {
					headers: { "Content-Type": "image/webp; charset=binary" },
				}),
		) as unknown as typeof fetch;

		const result = await readGeneratedImage(
			{ data: [{ url: "http://localhost:8080/out/1.webp" }] },
			fetchImpl,
			undefined,
		);

		expect(result).toMatchObject({ mediaType: "image/webp" });
	});

	it("reads a data URL without going back to the network", async () => {
		const result = await readGeneratedImage(
			{ data: [{ url: `data:image/jpeg;base64,${PNG_BASE64}` }] },
			neverFetched,
			undefined,
		);
		expect(result).toMatchObject({ mediaType: "image/jpeg" });
	});

	it("names the endpoint's error rather than writing an empty file", async () => {
		expect(
			await readGeneratedImage(
				{ error: { message: "model not loaded" } },
				neverFetched,
				undefined,
			),
		).toEqual({
			error: "The image endpoint returned an error: model not loaded",
		});
	});
});

describe("createGenerateImageTool", () => {
	it("saves the image and returns it to a model that can see", async () => {
		const writeFile = vi.fn(async () => {});
		const output = await run(
			{ prompt: "a rocket icon", path: "assets/icon.png", size: "512x512" },
			{ writeFile },
		);

		expect(writeFile).toHaveBeenCalledWith(
			"/workspace/assets/icon.png",
			expect.any(Buffer),
		);
		expect(Array.isArray(output)).toBe(true);
		const parts = output as Array<{ type: string; text?: string }>;
		expect(parts[0].text).toContain("assets/icon.png");
		expect(parts[1]).toMatchObject({ type: "image", mediaType: "image/png" });
	});

	// Same rule the browser tool applies to screenshots: an image is worth
	// nothing to a model that cannot read it, and costs the context window.
	it("does not send the image to a text-only model", async () => {
		const output = await run(
			{ prompt: "a rocket icon" },
			{ modelSupportsImages: false },
		);

		expect(typeof output).toBe("string");
		expect(output as string).toContain("cannot see images");
	});

	it("posts to the images endpoint with the configured model", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ data: [{ b64_json: PNG_BASE64 }] }),
		) as unknown as typeof fetch;

		await run(
			{ prompt: "a rocket icon", size: "768x768" },
			{
				endpoint: {
					baseUrl: "http://localhost:8080",
					model: "z-image",
					apiKey: "sk-test",
				},
				fetchImpl,
			},
		);

		const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, RequestInit];
		expect(url).toBe("http://localhost:8080/v1/images/generations");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer sk-test",
		);
		expect(JSON.parse(init.body as string)).toMatchObject({
			model: "z-image",
			prompt: "a rocket icon",
			size: "768x768",
			n: 1,
		});
	});

	// The setting can be cleared while a session is running, and the model
	// deserves the reason rather than a stack trace.
	it("explains itself when no endpoint is configured", async () => {
		const writeFile = vi.fn(async () => {});
		const output = await run(
			{ prompt: "a rocket icon" },
			{ endpoint: null, writeFile },
		);

		expect(output as string).toContain("cline.imageGeneration.endpoint");
		expect(writeFile).not.toHaveBeenCalled();
	});

	it("refuses to write outside the workspace", async () => {
		const writeFile = vi.fn(async () => {});
		const output = await run(
			{ prompt: "a rocket icon", path: "../escape.png" },
			{ writeFile },
		);

		expect(output as string).toContain("outside the workspace");
		expect(writeFile).not.toHaveBeenCalled();
	});

	it("reports an HTTP failure with what the server said", async () => {
		const fetchImpl = vi.fn(
			async () => new Response("no such model", { status: 404 }),
		) as unknown as typeof fetch;

		const output = await run({ prompt: "a rocket icon" }, { fetchImpl });

		expect(output as string).toContain("HTTP 404");
		expect(output as string).toContain("no such model");
	});

	it("asks for a prompt rather than generating nothing", async () => {
		expect((await run({ prompt: "   " })) as string).toContain(
			"needs a `prompt`",
		);
	});
});

import { describe, expect, it } from "vitest";
import {
	buildIconPrompt,
	buildProposalSheet,
	createGenerateIconTool,
} from "./icon-generation";
import type { RenderRequest } from "./render-image";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);

function harness(
	config: { endpoint?: boolean; refuseAfter?: number; missing?: string[] } = {},
) {
	const prompts: string[] = [];
	const sizes: string[] = [];
	const renders: RenderRequest[] = [];
	const written = new Map<string, Buffer>();
	const tool = createGenerateIconTool({
		cwd: "/work",
		now: () => 42,
		getEndpoint: () =>
			config.endpoint === false
				? undefined
				: { baseUrl: "http://images.test/v1", model: "flux", size: "1344x768" },
		fetchImpl: (async (_url: unknown, init?: { body?: string }) => {
			const body = JSON.parse(init?.body ?? "{}");
			prompts.push(body.prompt);
			sizes.push(body.size);
			if (
				config.refuseAfter !== undefined &&
				prompts.length > config.refuseAfter
			) {
				return new Response("no", { status: 400 });
			}
			return new Response(
				JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as never,
		createDriver: () => ({
			render: async (request) => {
				renders.push(request);
				const asked = /"width":(\d+),"height":(\d+)/.exec(request.html);
				const side = asked ? Number(asked[1]) : 560;
				return {
					data: Buffer.from(`${request.format ?? "png"}:${side}`),
					width: side,
					height: side,
				};
			},
		}),
		fileExists: async (path) => !(config.missing ?? []).includes(path),
		writeFile: async (path, data) => {
			written.set(path, data);
		},
	});
	const run = (input: Record<string, unknown>, sees = false) =>
		tool.execute(input, {
			metadata: { modelSupportsImages: sees },
		} as never) as Promise<unknown>;
	return { run, prompts, sizes, renders, written };
}

describe("what an icon is drawn from", () => {
	it("adds the rules of an icon to the subject, and no number", () => {
		const first = buildIconPrompt("a paper plane.", "flat vector", 0);
		const second = buildIconPrompt("a paper plane.", "flat vector", 1);
		expect(first).toContain("a paper plane. An app icon in flat vector style");
		expect(first).toContain("no text");
		expect(second).not.toBe(first);
		expect(second.slice(first.length)).not.toMatch(/\d/);
		expect(second.startsWith(first)).toBe(true);
	});

	it("numbers the proposals on the sheet from one", () => {
		const sheet = buildProposalSheet(["file:///a.png", "file:///b.png"]);
		expect(sheet).toContain(
			'<img src="file:///a.png" alt=""><figcaption>1</figcaption>',
		);
		expect(sheet).toContain("<figcaption>2</figcaption>");
		expect(sheet).toContain("repeat(2, 256px)");
	});
});

describe("generate_icon", () => {
	it("draws four square proposals and shows them on one sheet", async () => {
		const h = harness();
		const out = (await h.run({ prompt: "a paper plane" }, true)) as Array<{
			type: string;
			text?: string;
		}>;
		expect(h.prompts).toHaveLength(4);
		expect(new Set(h.prompts).size).toBe(4);
		// Square, whatever shape the tab's default has.
		expect(h.sizes).toEqual(["768x768", "768x768", "768x768", "768x768"]);
		expect([...h.written.keys()]).toEqual([
			"/work/.cline/generated-images/icons/a-paper-plane-42-1.png",
			"/work/.cline/generated-images/icons/a-paper-plane-42-2.png",
			"/work/.cline/generated-images/icons/a-paper-plane-42-3.png",
			"/work/.cline/generated-images/icons/a-paper-plane-42-4.png",
		]);
		expect(h.renders).toHaveLength(1);
		expect(h.renders[0]?.html).toContain(
			"file:///work/.cline/generated-images/icons/a-paper-plane-42-3.png",
		);
		expect(out.map((part) => part.type)).toEqual(["text", "image"]);
		expect(out[0]?.text).toContain(
			"4. `.cline/generated-images/icons/a-paper-plane-42-4.png`",
		);
		expect(out[0]?.text).toContain("ask which one they want");
	});

	it("keeps what was drawn when the endpoint stops answering", async () => {
		const h = harness({ refuseAfter: 2 });
		const out = String(await h.run({ prompt: "a fox", count: 3 }));
		expect(h.written.size).toBe(2);
		expect(out).toContain("Drew 2 icon proposals");
		expect(out).toContain("1 of the 3 asked for could not be drawn");
		expect(out).toContain("You cannot see images");
	});

	it("stops at the first refusal when nothing was drawn", async () => {
		const h = harness({ refuseAfter: 0 });
		const out = String(await h.run({ prompt: "a fox" }));
		expect(h.prompts).toHaveLength(1);
		expect(out).toContain("refused the request (HTTP 400)");
		expect(h.renders).toHaveLength(0);
	});

	it("says where the endpoint is named when there is none", async () => {
		const h = harness({ endpoint: false });
		expect(String(await h.run({ prompt: "a fox" }))).toContain("Images tab");
	});

	it("writes the chosen one in every format", async () => {
		const h = harness();
		const out = String(
			await h.run({
				pick: ".cline/generated-images/icons/fox-1.png",
				path: "assets/icon",
			}),
		);
		const names = [...h.written.keys()].map((path) =>
			path.replace("/work/assets/", ""),
		);
		expect(names).toEqual([
			"icon.ico",
			"icon.icns",
			"icon.png",
			"icon-16.png",
			"icon-32.png",
			"icon-48.png",
			"icon-64.png",
			"icon-128.png",
			"icon-180.png",
			"icon-192.png",
			"icon-256.png",
			"icon-512.png",
		]);
		const ico = h.written.get("/work/assets/icon.ico") as Buffer;
		expect(ico.readUInt16LE(4)).toBe(7);
		expect(
			h.written.get("/work/assets/icon.icns")?.subarray(0, 4).toString(),
		).toBe("icns");
		expect(h.written.get("/work/assets/icon.png")?.toString()).toBe("png:1024");
		expect(h.written.get("/work/assets/icon-180.png")?.toString()).toBe(
			"png:180",
		);
		// One render per size, each size once.
		expect(h.renders).toHaveLength(11);
		expect(out).toContain(
			"- `assets/icon.ico` (Windows and favicons; holds 16, 24, 32, 48, 64, 128, 256)",
		);
		// No endpoint is asked for anything.
		expect(h.prompts).toHaveLength(0);
	});

	it("writes only what was asked for", async () => {
		const h = harness({ endpoint: false });
		await h.run({
			pick: "logo.png",
			path: "public/favicon.ico",
			formats: "ico,webp",
		});
		expect([...h.written.keys()]).toEqual([
			"/work/public/favicon.ico",
			"/work/public/favicon.webp",
		]);
	});

	it("refuses what it cannot do", async () => {
		const h = harness({ missing: ["/work/gone.png"] });
		expect(String(await h.run({}))).toContain("needs a `prompt`");
		expect(String(await h.run({ pick: "gone.png", path: "a" }))).toContain(
			"no file at",
		);
		expect(String(await h.run({ pick: "../x.png", path: "a" }))).toContain(
			"outside the workspace",
		);
		expect(String(await h.run({ pick: "x.png" }))).toContain("needs `path`");
		expect(
			String(await h.run({ pick: "x.png", path: "a", formats: "gif" })),
		).toContain("none of them");
		expect(String(await h.run({ pick: "x.png", path: "../a" }))).toContain(
			"outside the workspace",
		);
		expect(
			String(await h.run({ pick: "icon.png", path: "icon", formats: "png" })),
		).toContain("over the image");
		expect(h.written.size).toBe(0);
	});
});

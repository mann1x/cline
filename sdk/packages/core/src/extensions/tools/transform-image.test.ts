import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";
import type { RenderRequest } from "./render-image";
import {
	buildTransformDocument,
	createTransformImageTool,
	encodeIcns,
	encodeIco,
	parseIconSizes,
	planTransform,
} from "./transform-image";

// The workspace is "/work" as this platform resolves it: `D:\\work` on a
// Windows runner, and a `file:///D:/work/` URL to match.
const WORK = nodePath.resolve("/work");
const at = (relative: string) => nodePath.join(WORK, ...relative.split("/"));

describe("where a source goes in a result", () => {
	it("keeps the source as it is when nothing is asked", () => {
		expect(planTransform(800, 600, null, null, null, "inside")).toMatchObject({
			sx: 0,
			sy: 0,
			sw: 800,
			sh: 600,
			width: 800,
			height: 600,
		});
	});

	it("follows the proportions from one side", () => {
		expect(planTransform(800, 600, null, 400, null, "inside")).toMatchObject({
			width: 400,
			height: 300,
		});
		expect(planTransform(800, 600, null, null, 150, "inside")).toMatchObject({
			width: 200,
			height: 150,
		});
	});

	it("fits within a box, keeping the proportions", () => {
		expect(planTransform(800, 600, null, 200, 200, "inside")).toMatchObject({
			width: 200,
			height: 150,
			dw: 200,
			dh: 150,
		});
	});

	it("fills a box and cuts the overflow evenly", () => {
		expect(planTransform(800, 600, null, 200, 200, "cover")).toMatchObject({
			sx: 100,
			sy: 0,
			sw: 600,
			sh: 600,
			width: 200,
			height: 200,
		});
	});

	it("pads to exactly the box", () => {
		expect(planTransform(800, 600, null, 200, 200, "pad")).toMatchObject({
			width: 200,
			height: 200,
			dx: 0,
			dy: 25,
			dw: 200,
			dh: 150,
		});
	});

	it("stretches when told to", () => {
		expect(planTransform(800, 600, null, 200, 200, "stretch")).toMatchObject({
			sw: 800,
			sh: 600,
			dw: 200,
			dh: 200,
		});
	});

	it("takes the crop first, and only what the source has", () => {
		expect(
			planTransform(
				800,
				600,
				{ x: 700, y: 500, width: 400, height: 400 },
				50,
				null,
				"inside",
			),
		).toMatchObject({
			sx: 700,
			sy: 500,
			sw: 100,
			sh: 100,
			width: 50,
			height: 50,
		});
		expect(
			planTransform(
				800,
				600,
				{ x: 900, y: 0, width: 10, height: 10 },
				null,
				null,
				"inside",
			),
		).toBeNull();
		// A source that did not load has no size.
		expect(planTransform(0, 0, null, 100, 100, "inside")).toBeNull();
	});

	it("is the text the page runs", () => {
		const page = buildTransformDocument("file:///work/a%20b.png", {
			fit: "pad",
			width: 64,
			height: 64,
			background: "</script>",
		});
		expect(page).toContain('src="file:///work/a%20b.png"');
		expect(page).not.toContain('"</script>"');
		// The function is carried whole, and nothing in it reaches outside it.
		const text = /<script>\n([\s\S]*?)\naddEventListener/.exec(page)?.[1] ?? "";
		const carried = new Function(
			`${text}; return planTransform;`,
		)() as typeof planTransform;
		expect(carried(800, 600, null, 200, 200, "cover")).toEqual(
			planTransform(800, 600, null, 200, 200, "cover"),
		);
	});
});

describe("icon files", () => {
	const png = (n: number) => Buffer.alloc(n, n);

	it("writes an .ico directory with 256 as zero", () => {
		const ico = encodeIco([
			{ size: 16, png: png(10) },
			{ size: 256, png: png(20) },
		]);
		expect(ico.readUInt16LE(2)).toBe(1);
		expect(ico.readUInt16LE(4)).toBe(2);
		expect(ico.readUInt8(6)).toBe(16);
		expect(ico.readUInt8(6 + 16)).toBe(0);
		expect(ico.readUInt32LE(6 + 8)).toBe(10);
		expect(ico.readUInt32LE(6 + 12)).toBe(38);
		expect(ico.readUInt32LE(6 + 16 + 12)).toBe(48);
		expect(ico.length).toBe(38 + 30);
	});

	it("writes an .icns with a name per size", () => {
		const icns = encodeIcns([
			{ size: 128, png: png(10) },
			{ size: 1024, png: png(20) },
		]);
		expect(icns.subarray(0, 4).toString()).toBe("icns");
		expect(icns.readUInt32BE(4)).toBe(icns.length);
		expect(icns.subarray(8, 12).toString()).toBe("ic07");
		expect(icns.readUInt32BE(12)).toBe(18);
		expect(icns.subarray(26, 30).toString()).toBe("ic10");
	});

	it("knows what each kind can hold", () => {
		expect(parseIconSizes(undefined, "ico")).toEqual([
			16, 24, 32, 48, 64, 128, 256,
		]);
		expect(parseIconSizes("48, 16,16", "ico")).toEqual([16, 48]);
		expect(parseIconSizes("512", "ico")).toHaveProperty("error");
		expect(parseIconSizes("48", "icns")).toHaveProperty("error");
		expect(parseIconSizes("a", "ico")).toHaveProperty("error");
	});
});

describe("transform_image", () => {
	function harness(missingRelative: string[] = []) {
		const missing = missingRelative.map(at);
		const requests: RenderRequest[] = [];
		const written = new Map<string, Buffer>();
		const tool = createTransformImageTool({
			cwd: "/work",
			createDriver: () => ({
				render: async (request) => {
					requests.push(request);
					const asked = /"width":(\d+|null),"height":(\d+|null)/.exec(
						request.html,
					);
					const width = Number(asked?.[1]) || 800;
					const height = Number(asked?.[2]) || 600;
					return {
						data: Buffer.from(`${request.format}:${width}`),
						width,
						height,
					};
				},
			}),
			fileExists: async (path) => !missing.includes(path),
			writeFile: async (path, data) => {
				written.set(path, data);
			},
		});
		const run = (input: Record<string, unknown>) =>
			tool.execute(input, { metadata: {} } as never) as Promise<unknown>;
		return { run, requests, written };
	}

	it("names the result by its size when no path is given", async () => {
		const h = harness();
		const out = String(
			await h.run({ image: "docs/shot.png", width: 400, height: 300 }),
		);
		expect([...h.written.keys()]).toEqual([at("docs/shot-400x300.png")]);
		expect(out).toContain("docs/shot-400x300.png");
		expect(h.requests[0]).toMatchObject({
			format: "png",
			scale: 1,
			fitContent: true,
			transparent: true,
		});
	});

	it("takes the format from the path, and gives JPEG a ground", async () => {
		const h = harness();
		await h.run({ image: "a.png", path: "out/a.jpg", quality: 70 });
		expect(h.requests[0]).toMatchObject({
			format: "jpeg",
			quality: 70,
			transparent: false,
		});
		expect(h.requests[0]?.html).toContain('"background":"#ffffff"');
		await h.run({ image: "a.png", path: "a.webp" });
		expect(h.requests[1]).toMatchObject({
			format: "webp",
			quality: 90,
			transparent: true,
		});
	});

	it("packs an .ico from one render per size", async () => {
		const h = harness();
		const out = String(
			await h.run({ image: "logo.png", path: "app.ico", sizes: "16,32" }),
		);
		expect(h.requests).toHaveLength(2);
		const ico = h.written.get(at("app.ico")) as Buffer;
		expect(ico.readUInt16LE(4)).toBe(2);
		expect(out).toContain("holds 16, 32");
	});

	it("refuses what it cannot do, before any browser", async () => {
		const h = harness(["gone.png"]);
		expect(String(await h.run({}))).toContain("needs `image`");
		expect(String(await h.run({ image: "../a.png" }))).toContain(
			"outside the workspace",
		);
		expect(String(await h.run({ image: "gone.png" }))).toContain("no file at");
		expect(String(await h.run({ image: "a.png", path: "a.tiff" }))).toContain(
			"none of them",
		);
		expect(String(await h.run({ image: "a.png", fit: "fill" }))).toContain(
			"`fit` is",
		);
		expect(String(await h.run({ image: "a.png", crop: "1,2" }))).toContain(
			"`crop` is",
		);
		expect(h.requests).toHaveLength(0);
		expect(String(await h.run({ image: "a.png", path: "a.png" }))).toContain(
			"over the source",
		);
		expect(h.written.size).toBe(0);
	});
});

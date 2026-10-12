import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildRenderDocument,
	createRenderImageTool,
	detectRenderKind,
	parseCrop,
	RENDER_ROOT_ID,
	type RenderRequest,
	unfence,
} from "./render-image";

// The workspace is "/work" as this platform resolves it: `D:\\work` on a
// Windows runner, and a `file:///D:/work/` URL to match.
const WORK = nodePath.resolve("/work");
const at = (relative: string) => nodePath.join(WORK, ...relative.split("/"));
const urlOf = (relative: string) =>
	relative === ""
		? pathToFileURL(`${WORK}${nodePath.sep}`).href
		: pathToFileURL(at(relative)).href;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

function harness(
	result: { width?: number; height?: number; svg?: string } = {},
) {
	const requests: RenderRequest[] = [];
	const written = new Map<string, Buffer>();
	let drivers = 0;
	const tool = createRenderImageTool({
		cwd: "/work",
		createDriver: () => {
			drivers += 1;
			return {
				render: async (request) => {
					requests.push(request);
					return {
						data: PNG,
						width: result.width ?? 1180,
						height: result.height ?? 370,
						...(result.svg ? { svg: result.svg } : {}),
					};
				},
			};
		},
		writeFile: async (path, data) => {
			written.set(path, data);
		},
	});
	const run = (input: Record<string, unknown>, sees = false) =>
		tool.execute(input, {
			metadata: { modelSupportsImages: sees },
		} as never) as Promise<unknown>;
	return { run, requests, written, drivers: () => drivers };
}

describe("what a source is", () => {
	it("reads the kind from the source", () => {
		expect(
			detectRenderKind('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
		).toBe("svg");
		expect(
			detectRenderKind('<?xml version="1.0"?>\n<svg width="4"></svg>'),
		).toBe("svg");
		expect(detectRenderKind("flowchart LR\n  A --> B")).toBe("mermaid");
		expect(
			detectRenderKind("%%{init: {}}%%\nsequenceDiagram\n  A->>B: hi"),
		).toBe("mermaid");
		expect(detectRenderKind("stateDiagram-v2\n  [*] --> Idle")).toBe("mermaid");
		expect(detectRenderKind('<div class="card">Graph of sales</div>')).toBe(
			"html",
		);
		// A page that holds a drawing is a page.
		expect(detectRenderKind("<main><svg></svg></main>")).toBe("html");
	});

	it("takes a source that arrives in a fenced block", () => {
		expect(unfence("```mermaid\nflowchart LR\n  A --> B\n```")).toBe(
			"flowchart LR\n  A --> B",
		);
		expect(unfence("<p>``` is not a fence here</p>")).toBe(
			"<p>``` is not a fence here</p>",
		);
	});

	it("reads a crop as four numbers and nothing else", () => {
		expect(parseCrop("0,40,1180,370")).toEqual({
			x: 0,
			y: 40,
			width: 1180,
			height: 370,
		});
		expect(parseCrop([10, 20, 30, 40])).toEqual({
			x: 10,
			y: 20,
			width: 30,
			height: 40,
		});
		expect(parseCrop("0,0,100")).toBeUndefined();
		expect(parseCrop("0,0,0,100")).toBeUndefined();
		expect(parseCrop("a,b,c,d")).toBeUndefined();
	});
});

describe("the page a source is rendered as", () => {
	it("sets a fragment in a measured inline block, with no margin", () => {
		const page = buildRenderDocument({
			kind: "html",
			source: "<h1>Sign in</h1>",
		});
		expect(page).toContain(
			`<div id="${RENDER_ROOT_ID}"><h1>Sign in</h1></div>`,
		);
		expect(page).toContain("margin: 0");
		expect(page).toContain("display: inline-block");
	});

	it("leaves a whole document as it was written", () => {
		const whole = "<!doctype html><html><body><p>x</p></body></html>";
		expect(buildRenderDocument({ kind: "html", source: whole })).toBe(whole);
	});

	it("resolves relative URLs in the workspace", () => {
		const app = at("app");
		const base = `<base href="${pathToFileURL(`${app}${nodePath.sep}`).href}">`;
		expect(
			buildRenderDocument({
				kind: "html",
				source: "<p>x</p>",
				baseDir: app,
			}),
		).toContain(`<meta charset="utf-8">${base}`);
		expect(
			buildRenderDocument({
				kind: "html",
				source:
					'<!doctype html><html><head lang="en"><title>t</title></head><body></body></html>',
				baseDir: app,
			}),
		).toContain(`<head lang="en">${base}<title>`);
		expect(
			buildRenderDocument({
				kind: "html",
				source: "<html><body><p>x</p></body></html>",
				baseDir: app,
			}),
		).toBe(`<html><head>${base}</head><body><p>x</p></body></html>`);
		// A base the page set itself is kept.
		const own = '<html><head><base href="https://example.test/"></head></html>';
		expect(
			buildRenderDocument({ kind: "html", source: own, baseDir: app }),
		).toBe(own);
	});

	it("writes a diagram as text, never as markup", () => {
		const page = buildRenderDocument({
			kind: "mermaid",
			source: 'flowchart LR\n  A["a < b"] --> B',
		});
		expect(page).toContain(
			'<pre class="mermaid">flowchart LR\n  A["a &lt; b"] --&gt; B</pre>',
		);
	});
});

describe("render_image", () => {
	it("captures what was drawn when no size is asked for", async () => {
		const h = harness();
		const out = await h.run({ source: "<h1>Sign in</h1>" });
		expect(h.requests[0]).toMatchObject({
			fitContent: true,
			width: 1280,
			scale: 2,
			baseDir: "/work",
		});
		expect(h.requests[0]?.html).toContain(`<base href="${urlOf("")}">`);
		expect(h.requests[0]?.height).toBeUndefined();
		const [path] = [...h.written.keys()];
		expect(nodePath.dirname(path as string)).toBe(at(".cline/rendered-images"));
		expect(nodePath.basename(path as string)).toMatch(/^html-sign-\d+\.png$/);
		// The size reported is the file's, in pixels.
		expect(String(out)).toContain("(2360x740)");
	});

	it("keeps a width as the wrap width and still fits the height", async () => {
		const h = harness();
		await h.run({ source: "<p>x</p>", width: 800 });
		expect(h.requests[0]).toMatchObject({ width: 800, fitContent: true });
	});

	it("captures the page as sized when a height or a crop is given", async () => {
		const h = harness();
		await h.run({ source: "<p>x</p>", width: 800, height: 600, scale: 1 });
		expect(h.requests[0]).toMatchObject({
			width: 800,
			height: 600,
			fitContent: false,
			scale: 1,
		});
		await h.run({ source: "<p>x</p>", crop: "0,0,400,200" });
		expect(h.requests[1]).toMatchObject({
			fitContent: false,
			crop: { x: 0, y: 0, width: 400, height: 200 },
		});
	});

	it("asks the browser to draw a diagram, in the theme named", async () => {
		const h = harness();
		await h.run({
			source: "flowchart LR\n  A --> B",
			theme: "dark",
			path: "docs/flow.png",
		});
		expect(h.requests[0]?.mermaid).toEqual({ theme: "dark" });
		expect(h.written.has(at("docs/flow.png"))).toBe(true);
	});

	it("saves a diagram as vectors when the path says so", async () => {
		const h = harness({ svg: '<svg id="d"></svg>' });
		const out = await h.run({
			source: "flowchart LR\n  A --> B",
			path: "docs/flow.svg",
		});
		expect(h.requests[0]?.wantSvg).toBe(true);
		expect(h.written.get(at("docs/flow.svg"))?.toString()).toBe(
			'<svg id="d"></svg>',
		);
		expect(h.written.size).toBe(1);
		expect(String(out)).toContain("docs/flow.svg");
	});

	it("saves an SVG source as it was written", async () => {
		const h = harness();
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>';
		await h.run({ source: svg, path: "icon.svg" });
		expect(h.written.get(at("icon.svg"))?.toString()).toBe(svg);
	});

	it("returns the picture to a model that can see it", async () => {
		const h = harness();
		const out = (await h.run({ source: "<p>x</p>" }, true)) as Array<{
			type: string;
		}>;
		expect(out.map((part) => part.type)).toEqual(["text", "image"]);
	});

	it("starts one browser for the session, and none for a refused call", async () => {
		const h = harness();
		expect(String(await h.run({ source: "  " }))).toContain("needs a `source`");
		expect(
			String(await h.run({ source: "<p>x</p>", path: "../out.png" })),
		).toContain("outside the workspace");
		expect(
			String(await h.run({ source: "<p>x</p>", path: "a.jpg" })),
		).toContain("neither");
		expect(
			String(await h.run({ source: "<p>x</p>", path: "a.svg" })),
		).toContain("not a vector drawing");
		expect(
			String(await h.run({ source: "<p>x</p>", crop: "1,2,3" })),
		).toContain("`crop` is");
		expect(
			String(await h.run({ source: "<p>x</p>", background: "red;}body{" })),
		).toContain("one CSS colour");
		expect(h.drivers()).toBe(0);
		await h.run({ source: "<p>x</p>" });
		await h.run({ source: "<p>y</p>" });
		expect(h.drivers()).toBe(1);
	});

	it("says so when nothing was drawn", async () => {
		const h = harness({ width: 0, height: 0 });
		expect(String(await h.run({ source: "<div></div>" }))).toContain(
			"Nothing was drawn",
		);
		expect(h.written.size).toBe(0);
	});
});

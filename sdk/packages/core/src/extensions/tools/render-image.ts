/**
 * A tool that draws what the model writes.
 *
 * `generate_image` paints pixels, and pixels that look like an interface are
 * not one: asked for "rendered images showing the workflow of the
 * application", a model on xOllama produced two dashboards whose tabs read
 * "Dasihorad" and "Documets" (2026-10-12). No prompt mends that. The models
 * that cannot draw a word can write one, and they write HTML, CSS, SVG and
 * diagram notation well. So this tool takes the source and a real browser
 * renders it: every label is the text that was typed, and a screen can be
 * built from the application's own markup and stylesheet.
 *
 * The picture is as large as what was drawn unless a size is asked for. The
 * first diagram rendered the other way was 1180 by 370 pixels in a fixed 1280
 * by 800 capture, a third of it empty.
 */

import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { type AgentTool, createTool } from "@cline/shared";
import {
	resolveInsideWorkspace,
	saveAndReportImage,
	type ToolOutput,
} from "./image-generation";

export const RENDER_IMAGE_TOOL_NAME = "render_image";

export const RENDER_IMAGE_TOOL_DESCRIPTION = `Render HTML, SVG or a Mermaid diagram that you write into an image file in the workspace. Use it for anything with text or structure in it: application screens and mockups, workflow and architecture diagrams, charts, annotated figures. An image model cannot write legible text or draw a real interface; this draws exactly what you write.

The image is saved and, if you can see images, returned to you, so you can check the layout and render again.

- \`source\` — what to draw: HTML with its CSS (a fragment or a whole document), an SVG document, or Mermaid notation (\`flowchart LR\`, \`sequenceDiagram\`, ...). Relative URLs resolve against the workspace root, so a screen of the application can link the project's own stylesheet and images: reuse its markup and class names with sample data and the picture is the real interface.
- \`kind\` — \`html\`, \`svg\` or \`mermaid\`. Optional; read from the source.
- \`path\` — where to save, relative to the workspace: \`.png\`, or \`.svg\` to keep an SVG or Mermaid drawing as vectors. Optional; defaults to a PNG under \`.cline/rendered-images/\`.
- \`width\`, \`height\` — page size in CSS pixels. Optional. Leave both out and the image is exactly as large as what was drawn; \`width\` alone fixes where the layout wraps.
- \`scale\` — pixel density, 1 to 4, default 2.
- \`crop\` — \`"x,y,width,height"\` in CSS pixels, to keep one region of the page.
- \`background\` — a CSS colour, or \`transparent\`.
- \`theme\` — Mermaid only: \`default\`, \`dark\`, \`neutral\` or \`forest\`.

A README on GitHub renders a \`\`\`mermaid block as it is; render a diagram to a file when it must show somewhere that does not. Remote fonts, scripts and images load only if the machine reaches them quickly: inline what matters.`;

export const RENDER_IMAGE_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		source: {
			type: "string",
			description:
				"HTML (with its CSS), an SVG document, or Mermaid notation, written out in full.",
		},
		kind: {
			type: "string",
			enum: ["html", "svg", "mermaid"],
			description: "Optional; read from the source when left out.",
		},
		path: {
			type: "string",
			description:
				"Where to save, relative to the workspace (.png, or .svg for an SVG or Mermaid drawing). Optional.",
		},
		width: {
			type: "number",
			description: "Page width in CSS pixels. Optional.",
		},
		height: {
			type: "number",
			description:
				"Page height in CSS pixels. Optional; without it the height is what was drawn.",
		},
		scale: {
			type: "number",
			description: "Pixel density, 1 to 4. Optional, default 2.",
		},
		crop: {
			type: "string",
			description: '"x,y,width,height" in CSS pixels. Optional.',
		},
		background: {
			type: "string",
			description: 'A CSS colour, or "transparent". Optional.',
		},
		theme: {
			type: "string",
			description: "Mermaid only: default, dark, neutral or forest.",
		},
	},
	required: ["source"],
} as const;

export type RenderKind = "html" | "svg" | "mermaid";

export interface RenderRegion {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** One render, as the host's browser is asked for it. */
export interface RenderRequest {
	/** A whole HTML document. */
	html: string;
	/** The folder relative URLs in it resolve against. */
	baseDir: string;
	/** Present for a diagram: the browser draws it before the capture. */
	mermaid?: { theme: string };
	/** The page's width; what a layout wraps at. */
	width: number;
	/** The page's height. Absent: as tall as what was drawn. */
	height?: number;
	/** No size was asked for: capture what was drawn and nothing around it. */
	fitContent: boolean;
	scale: number;
	crop?: RenderRegion;
	transparent: boolean;
	/** Also hand back the drawing as SVG text, where the page holds one. */
	wantSvg: boolean;
	/** What the capture is encoded as. Absent: PNG. */
	format?: "png" | "jpeg" | "webp";
	/** 1 to 100, for the two formats that have one. */
	quality?: number;
	signal?: AbortSignal;
}

export interface RenderResult {
	/** The capture, in the format asked for. */
	data: Buffer;
	/** The captured region, in CSS pixels. */
	width: number;
	height: number;
	svg?: string;
}

/** The host's browser. Structural, as the browser tool's driver is. */
export interface RenderDriver {
	render(request: RenderRequest): Promise<RenderResult>;
}

export interface RenderImageToolOptions {
	cwd: string;
	/** Built on first use: a session that never renders never starts a browser. */
	createDriver: () => RenderDriver | Promise<RenderDriver>;
	writeFile: (absolutePath: string, data: Buffer) => Promise<void>;
	onError?: (message: string, error: unknown) => void;
}

interface RenderImageToolInput {
	source?: unknown;
	kind?: unknown;
	path?: unknown;
	width?: unknown;
	height?: unknown;
	scale?: unknown;
	crop?: unknown;
	background?: unknown;
	theme?: unknown;
}

/** The id of the element a fragment is measured by. */
export const RENDER_ROOT_ID = "cerebriline-render-root";

const DEFAULT_WIDTH = 1280;
const MAX_SIDE = 8_000;
const DEFAULT_SCALE = 2;
const MERMAID_THEMES = ["default", "dark", "neutral", "forest", "base"];

const MERMAID_OPENERS =
	/^\s*(?:%%\{[\s\S]*?\}%%\s*)?(?:---[\s\S]*?---\s*)?(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|sankey(?:-beta)?|xychart(?:-beta)?|block(?:-beta)?|architecture(?:-beta)?|kanban|packet(?:-beta)?)\b/;

/** What a source is, when the call does not say. */
export function detectRenderKind(source: string): RenderKind {
	const trimmed = source.trimStart();
	if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(trimmed)) {
		return "svg";
	}
	if (MERMAID_OPENERS.test(source)) {
		return "mermaid";
	}
	return "html";
}

/** A fenced block's contents, when the source arrives wrapped in one. */
export function unfence(source: string): string {
	const match = /^\s*```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```\s*$/.exec(source);
	return match ? (match[1] as string) : source;
}

function positiveNumber(value: unknown): number | undefined {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim() !== ""
				? Number(value)
				: Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** `"x,y,width,height"`, or the same four as a list. */
export function parseCrop(value: unknown): RenderRegion | undefined {
	const parts = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(/[\s,x]+/).filter(Boolean)
			: [];
	if (parts.length !== 4) {
		return undefined;
	}
	const [x, y, width, height] = parts.map((part) => Number(part));
	if (
		![x, y, width, height].every((part) => Number.isFinite(part)) ||
		(x as number) < 0 ||
		(y as number) < 0 ||
		(width as number) <= 0 ||
		(height as number) <= 0
	) {
		return undefined;
	}
	return {
		x: x as number,
		y: y as number,
		width: width as number,
		height: height as number,
	};
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * The page a source is rendered as.
 *
 * A whole document goes in as it is. Anything else is set in a page with no
 * margin, inside one inline block the capture is measured by: a block-level
 * wrapper would be as wide as the page whatever it held.
 */
export function buildRenderDocument(input: {
	kind: RenderKind;
	source: string;
	background?: string;
	/** The folder relative URLs resolve against: the workspace. */
	baseDir?: string;
}): string {
	const { kind, source } = input;
	const base = input.baseDir
		? `<base href="${pathToFileURL(`${input.baseDir}${nodePath.sep}`).href}">`
		: "";
	if (kind === "html" && /<html[\s>]|<!doctype\s+html/i.test(source)) {
		// The page's own `<base>` wins: it was written on purpose.
		if (!base || /<base[\s>]/i.test(source)) {
			return source;
		}
		const head = /<head(?:\s[^>]*)?>/i.exec(source);
		if (head) {
			const at = head.index + head[0].length;
			return `${source.slice(0, at)}${base}${source.slice(at)}`;
		}
		const html = /<html(?:\s[^>]*)?>/i.exec(source);
		const at = html ? html.index + html[0].length : 0;
		return `${source.slice(0, at)}<head>${base}</head>${source.slice(at)}`;
	}
	const background = input.background
		? `background:${input.background};`
		: kind === "mermaid"
			? "background:#ffffff;"
			: "";
	const body =
		kind === "mermaid"
			? `<pre class="mermaid">${escapeHtml(source)}</pre>`
			: source;
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">${base}
<style>
html, body { margin: 0; padding: 0; ${background} }
#${RENDER_ROOT_ID} { display: inline-block; vertical-align: top; }
#${RENDER_ROOT_ID} > svg { display: block; }
pre.mermaid { margin: 0; font-family: inherit; }
</style>
</head>
<body><div id="${RENDER_ROOT_ID}">${body}</div></body>
</html>`;
}

function slugFor(kind: RenderKind, source: string): string {
	const words =
		source
			.replace(
				/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]+>/g,
				" ",
			)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.split("-")
			.filter((word) => word.length > 2)
			.slice(0, 4)
			.join("-") || "image";
	return `${kind}-${words}`;
}

/** Create the `render_image` tool. */
export function createRenderImageTool(
	options: RenderImageToolOptions,
): AgentTool {
	let driver: RenderDriver | undefined;

	return createTool({
		name: RENDER_IMAGE_TOOL_NAME,
		description: RENDER_IMAGE_TOOL_DESCRIPTION,
		inputSchema: RENDER_IMAGE_TOOL_INPUT_SCHEMA,
		execute: async (input: unknown, context): Promise<ToolOutput> => {
			const request = (input ?? {}) as RenderImageToolInput;
			const written =
				typeof request.source === "string" ? unfence(request.source) : "";
			if (!written.trim()) {
				return "`render_image` needs a `source`: the HTML, SVG or Mermaid text to draw.";
			}
			const named =
				typeof request.kind === "string"
					? request.kind.trim().toLowerCase()
					: "";
			if (named && named !== "html" && named !== "svg" && named !== "mermaid") {
				return `\`kind\` is \`html\`, \`svg\` or \`mermaid\`; \`${named}\` is none of them. Leave it out to have it read from the source.`;
			}
			const kind = (named || detectRenderKind(written)) as RenderKind;

			const askedPath =
				typeof request.path === "string" && request.path.trim()
					? request.path.trim()
					: undefined;
			const requestedPath =
				askedPath ??
				nodePath.posix.join(
					".cline",
					"rendered-images",
					`${slugFor(kind, written)}-${Date.now()}.png`,
				);
			const extension = nodePath.extname(requestedPath).toLowerCase();
			if (extension !== ".png" && extension !== ".svg") {
				return `\`render_image\` writes \`.png\`, or \`.svg\` for an SVG or Mermaid drawing; \`${requestedPath}\` is neither.`;
			}
			if (extension === ".svg" && kind === "html") {
				return "An HTML page cannot be saved as `.svg`: it is not a vector drawing. Save it as `.png`, or write the drawing as SVG.";
			}
			const absolutePath = resolveInsideWorkspace(options.cwd, requestedPath);
			if (!absolutePath) {
				return `\`${requestedPath}\` is outside the workspace. Save the image somewhere under the project.`;
			}

			const width = positiveNumber(request.width);
			const height = positiveNumber(request.height);
			if ((width ?? 0) > MAX_SIDE || (height ?? 0) > MAX_SIDE) {
				return `The page can be at most ${MAX_SIDE} pixels on a side.`;
			}
			const scale = Math.min(
				4,
				Math.max(1, positiveNumber(request.scale) ?? DEFAULT_SCALE),
			);
			const crop =
				request.crop === undefined || request.crop === ""
					? undefined
					: parseCrop(request.crop);
			if (request.crop !== undefined && request.crop !== "" && !crop) {
				return '`crop` is `"x,y,width,height"` in CSS pixels, all four numbers, with a width and a height above zero.';
			}
			const background =
				typeof request.background === "string" && request.background.trim()
					? request.background.trim()
					: undefined;
			if (background && /[;{}<>]/.test(background)) {
				return "`background` is one CSS colour (`#0d1117`, `white`, `rgb(0 0 0 / 50%)`) or `transparent`.";
			}
			const theme =
				typeof request.theme === "string" &&
				MERMAID_THEMES.includes(request.theme.trim().toLowerCase())
					? request.theme.trim().toLowerCase()
					: "default";

			const signal = context?.signal;
			try {
				driver ??= await options.createDriver();
				const result = await driver.render({
					html: buildRenderDocument({
						kind,
						source: written,
						background,
						baseDir: options.cwd,
					}),
					baseDir: options.cwd,
					...(kind === "mermaid" ? { mermaid: { theme } } : {}),
					width: Math.round(width ?? DEFAULT_WIDTH),
					...(height !== undefined ? { height: Math.round(height) } : {}),
					// A width alone fixes where the layout wraps and nothing more.
					fitContent: height === undefined && crop === undefined,
					scale,
					...(crop ? { crop } : {}),
					transparent: background?.toLowerCase() === "transparent",
					wantSvg: extension === ".svg",
					...(signal ? { signal } : {}),
				});
				if (result.width <= 0 || result.height <= 0) {
					return "Nothing was drawn: the source rendered to an empty page. Check that it has visible content and that its markup is closed.";
				}
				const size = `${Math.round(result.width * scale)}x${Math.round(result.height * scale)}`;
				if (extension === ".svg") {
					const svg = kind === "svg" ? written : (result.svg ?? "").trim();
					if (!svg) {
						return "The diagram was drawn but its SVG could not be read back. Save it as `.png` instead.";
					}
					await options.writeFile(absolutePath, Buffer.from(svg, "utf8"));
					// Shown as the PNG of the same drawing: an SVG is not an image a
					// model or a tool row is sent.
					const shown = await saveAndReportImage({
						image: { data: result.data, mediaType: "image/png" },
						verb: "Rendered",
						askedPath: requestedPath,
						requestedPath,
						absolutePath,
						size: `${Math.round(result.width)}x${Math.round(result.height)}, vector`,
						writeFile: async () => undefined,
						context,
					});
					return shown;
				}
				return await saveAndReportImage({
					image: { data: result.data, mediaType: "image/png" },
					verb: "Rendered",
					askedPath: requestedPath,
					requestedPath,
					absolutePath,
					size,
					writeFile: options.writeFile,
					context,
				});
			} catch (error) {
				if (signal?.aborted) {
					return "The render was stopped before it finished.";
				}
				options.onError?.("[render_image] render failed", error);
				const message = error instanceof Error ? error.message : String(error);
				return kind === "mermaid"
					? `The diagram could not be drawn: ${message}\n\nThis is usually a mistake in the Mermaid notation. Fix the line it names and render again.`
					: `The page could not be rendered: ${message}`;
			}
		},
	});
}

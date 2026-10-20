/**
 * Tool results as the model reads them, when they are read as text.
 *
 * Under `json` -- the format every session ran on until this existed, and the
 * default -- a structured tool result reaches the model as `JSON.stringify` of
 * whatever the tool returned. The file a `read_files` call shows then has no
 * line breaks in it, only `\n` escapes, its backslashes doubled and its quotes
 * escaped, and a model copying code out of it writes those escapes back into
 * the edit: on pandorum (2026-10-20) an `editor` call carried 28 literal `\n`
 * and no real one, and the line it wrote was the escapes.
 *
 * Under `text` the same result is rendered in the vocabulary the compaction
 * record already uses for it -- the query on a line of its own, then the result
 * as written -- so what the model reads live and what it reads after a
 * compaction are the same shape. Nothing upstream of the request changes: the
 * tools, the transcript on disk, the message builder and every guard keep
 * reading the structured value they read today. This is the last step before a
 * provider is handed the message, and it is the only place the two formats
 * differ.
 */

import type { ImageContent } from "./messages";

export type ToolResultFormat = "json" | "text";

export const TOOL_RESULT_FORMATS: readonly ToolResultFormat[] = [
	"json",
	"text",
];

/**
 * `json`, so a session that names no format is the session it always was. The
 * other one is chosen, and stays chosen for the life of the conversation: a
 * transcript that reads half one way and half the other is worse than either.
 */
export const DEFAULT_TOOL_RESULT_FORMAT: ToolResultFormat = "json";

export function isToolResultFormat(value: unknown): value is ToolResultFormat {
	return value === "json" || value === "text";
}

/**
 * What the transcript codec writes on a tool result it had to serialize.
 *
 * An object that is not an array is stored as its `JSON.stringify`, so by the
 * time the request is built a single `editor` entry and a tool that genuinely
 * answered with JSON text are both just strings. Only this mark tells them
 * apart, and only a marked string is ever parsed back: a program's own JSON
 * output is what it printed and is left exactly as it printed it.
 */
export const TOOL_RESULT_SERIALIZED_JSON = "json";

/**
 * The tool outputs that carry no `type` discriminator: `{query, result,
 * success, error?}`, from `read_files`, `run_commands`, `editor` and the rest.
 */
export interface StructuredToolResultEntry {
	query?: unknown;
	result?: unknown;
	success?: unknown;
	error?: unknown;
}

export function asStructuredToolResultEntry(
	block: unknown,
): StructuredToolResultEntry | undefined {
	if (typeof block !== "object" || block === null || "type" in block) {
		return undefined;
	}
	return "result" in block || "error" in block || "query" in block
		? (block as StructuredToolResultEntry)
		: undefined;
}

function isImageBlock(value: unknown): value is ImageContent {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { type?: unknown }).type === "image" &&
		typeof (value as { data?: unknown }).data === "string"
	);
}

function entryFieldText(value: unknown): string {
	if (value === undefined || value === null) {
		return "";
	}
	return typeof value === "string" ? value : renderToolResultText(value);
}

/**
 * One entry, laid out as the compaction record lays it out: the query, then
 * `→ ` and the result, `→ failed: ` and the error, or `→ (no output)` for an
 * answer that is empty -- a search that matched nothing is an answer, not a
 * failure.
 */
export function renderStructuredToolResultEntry(
	entry: StructuredToolResultEntry,
): string {
	const lines: string[] = [];
	const query = entryFieldText(entry.query);
	if (query) {
		lines.push(query);
	}
	const error = entryFieldText(entry.error);
	if (error) {
		lines.push(`→ failed: ${error}`);
	}
	const result = entryFieldText(entry.result);
	if (result) {
		lines.push(`→ ${result}`);
	} else if (!error) {
		lines.push(entry.success === false ? "→ failed" : "→ (no output)");
	}
	return lines.join("\n");
}

/** An MCP `CallToolResult`: `{content: [{type: "text", text}, …], isError?}`. */
function asMcpToolResult(
	value: Record<string, unknown>,
): readonly unknown[] | undefined {
	const content = value.content;
	if (!Array.isArray(content) || content.length === 0) {
		return undefined;
	}
	const others = Object.keys(value).filter(
		(key) => key !== "content" && key !== "isError",
	);
	if (others.length > 0) {
		return undefined;
	}
	return content.every(
		(block) =>
			typeof block === "object" &&
			block !== null &&
			typeof (block as { type?: unknown }).type === "string",
	)
		? content
		: undefined;
}

function scalarText(value: unknown): string | undefined {
	if (value === null) {
		return "null";
	}
	switch (typeof value) {
		case "string":
			return value;
		case "number":
		case "boolean":
		case "bigint":
			return String(value);
		default:
			return undefined;
	}
}

/**
 * Anything else a tool returns -- a team tool's `{agentId, status}`, a
 * sub-agent's report and its usage -- as `key: value` lines. Text is written as
 * it is, never re-indented: a report or a file excerpt that gained two spaces
 * on every line would no longer be what the tool returned.
 */
function renderObjectLines(
	value: Record<string, unknown> | readonly unknown[],
	depth: number,
): string[] {
	const pad = "  ".repeat(depth);
	const lines: string[] = [];
	const entries: [string, unknown][] = Array.isArray(value)
		? value.map((item) => ["-", item])
		: Object.entries(value);
	for (const [key, item] of entries) {
		if (item === undefined) {
			continue;
		}
		const label = Array.isArray(value) ? `${pad}-` : `${pad}${key}:`;
		const scalar = scalarText(item);
		if (scalar !== undefined) {
			if (scalar.includes("\n")) {
				lines.push(label, scalar);
			} else {
				lines.push(`${label} ${scalar}`);
			}
			continue;
		}
		if (typeof item !== "object" || item === null) {
			continue;
		}
		const entry = asStructuredToolResultEntry(item);
		if (entry) {
			lines.push(label, renderStructuredToolResultEntry(entry));
			continue;
		}
		if (isImageBlock(item)) {
			lines.push(`${label} [image:${item.mediaType}]`);
			continue;
		}
		lines.push(
			label,
			...renderObjectLines(
				item as Record<string, unknown> | readonly unknown[],
				depth + 1,
			),
		);
	}
	return lines;
}

function renderBlock(block: unknown): string {
	const scalar = scalarText(block);
	if (scalar !== undefined) {
		return scalar;
	}
	if (typeof block !== "object" || block === null) {
		return "";
	}
	const entry = asStructuredToolResultEntry(block);
	if (entry) {
		return renderStructuredToolResultEntry(entry);
	}
	const typed = block as {
		type?: unknown;
		text?: unknown;
		path?: unknown;
		content?: unknown;
		mediaType?: unknown;
	};
	if (typed.type === "text" && typeof typed.text === "string") {
		return typed.text;
	}
	if (typed.type === "file" && typeof typed.content === "string") {
		return `<file path="${String(typed.path ?? "")}">\n${typed.content}\n</file>`;
	}
	if (typed.type === "image") {
		return `[image:${String(typed.mediaType ?? "")}]`;
	}
	return renderToolResultText(block);
}

/**
 * Any tool output as text. Entries are joined the way the compaction record
 * joins them, one per line block.
 */
export function renderToolResultText(value: unknown): string {
	const scalar = scalarText(value);
	if (scalar !== undefined) {
		return scalar;
	}
	if (Array.isArray(value)) {
		return value.map(renderBlock).join("\n");
	}
	if (typeof value !== "object" || value === null) {
		return "";
	}
	const entry = asStructuredToolResultEntry(value);
	if (entry) {
		return renderStructuredToolResultEntry(entry);
	}
	const mcp = asMcpToolResult(value as Record<string, unknown>);
	if (mcp) {
		return mcp.map(renderBlock).join("\n");
	}
	return renderObjectLines(value as Record<string, unknown>, 0).join("\n");
}

/** The JSON a marked string was written from, or `undefined` if it is not JSON. */
function parseSerialized(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function collectImages(value: unknown, images: ImageContent[]): unknown {
	if (isImageBlock(value)) {
		images.push(value);
		return { type: "text", text: `[image:${value.mediaType}]` };
	}
	if (Array.isArray(value)) {
		return value.map((item) => collectImages(item, images));
	}
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			out[key] = collectImages(item, images);
		}
		return out;
	}
	return value;
}

/**
 * A tool output as the model is sent it under `text`.
 *
 * A string the codec marked is parsed back first; an unmarked one, or one
 * that no longer parses, is sent as it stands. Images are lifted out from
 * wherever they sit -- a `read_files` image is nested inside its entry's
 * `result` -- and follow the text as image blocks, so the request's media
 * budget still sees them; their place in the text keeps a placeholder. With
 * no image the result is a plain string.
 */
export function renderToolOutputForModel(
	output: unknown,
	options?: { serialized?: string },
): string | Array<{ type: "text"; text: string } | ImageContent> {
	let value = output;
	if (
		typeof output === "string" &&
		options?.serialized === TOOL_RESULT_SERIALIZED_JSON
	) {
		const parsed = parseSerialized(output);
		if (parsed === undefined) {
			return output;
		}
		value = parsed;
	}
	if (typeof value === "string") {
		return value;
	}
	const images: ImageContent[] = [];
	const stripped = collectImages(value, images);
	const text = renderToolResultText(stripped);
	return images.length > 0 ? [{ type: "text", text }, ...images] : text;
}

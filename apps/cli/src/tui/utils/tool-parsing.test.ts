import { describe, expect, it } from "vitest";
import {
	buildReadFilesKeys,
	extractFullOutputText,
	formatSpawnSwarmSummary,
	parseReadFilesInput,
	parseSpawnSwarmInput,
} from "./tool-parsing";

describe("buildReadFilesKeys", () => {
	it("produces unique keys when the same path is read twice", () => {
		const info = parseReadFilesInput({
			files: [{ path: "/a/SKILL.md" }, { path: "/a/SKILL.md" }],
		});
		const keys = buildReadFilesKeys(info?.files ?? []);

		expect(keys).toHaveLength(2);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("produces unique keys for duplicate paths from the file_paths shape", () => {
		const info = parseReadFilesInput({
			file_paths: ["/a/SKILL.md", "/a/SKILL.md", "/b/SKILL.md"],
		});
		const keys = buildReadFilesKeys(info?.files ?? []);

		expect(keys).toHaveLength(3);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("keeps distinct paths in unique keys", () => {
		const keys = buildReadFilesKeys([{ path: "/a.ts" }, { path: "/b.ts" }]);

		expect(new Set(keys).size).toBe(2);
	});

	it("returns no keys for an empty list", () => {
		expect(buildReadFilesKeys([])).toEqual([]);
	});
});

describe("extractFullOutputText", () => {
	it("extracts text with real newlines from the MCP CallToolResult shape", () => {
		const raw = {
			content: [
				{ type: "text", text: "# Memory\n\nline one" },
				{ type: "text", text: "line two" },
			],
		};
		expect(extractFullOutputText(raw)).toBe("# Memory\n\nline one\nline two");
	});

	it("keeps binary payloads behind placeholders in mixed MCP content", () => {
		const raw = {
			content: [
				{ type: "text", text: "before" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				{
					type: "resource",
					resource: { uri: "file:///a.md", blob: "d29ybGQ=" },
				},
				{ type: "resource_link", uri: "file:///b.md", name: "b.md" },
				{ type: "text", text: "after" },
			],
		};
		expect(extractFullOutputText(raw)).toBe(
			"before\n[image: image/png]\naGVsbG8=\n[resource: file:///a.md]\nd29ybGQ=\n[resource_link: file:///b.md]\nafter",
		);
	});

	it("chunks base64 payloads into 76-char lines so collapse stays compact", () => {
		const raw = {
			content: [
				{ type: "image", data: "A".repeat(160), mimeType: "image/png" },
			],
		};
		expect(extractFullOutputText(raw)?.split("\n")).toEqual([
			"[image: image/png]",
			"A".repeat(76),
			"A".repeat(76),
			"A".repeat(8),
		]);
	});

	it("extracts embedded resource text from MCP content", () => {
		const raw = {
			content: [
				{
					type: "resource",
					resource: { uri: "file:///memory.md", text: "resource body\nline 2" },
				},
			],
		};
		expect(extractFullOutputText(raw)).toBe("resource body\nline 2");
	});

	it("falls back to pretty JSON for objects without text content", () => {
		const raw = { structuredContent: { ok: true } };
		expect(extractFullOutputText(raw)).toBe(JSON.stringify(raw, null, 2));
	});
});

describe("parseSpawnSwarmInput", () => {
	it("reads a fan-out of one task across a count", () => {
		expect(parseSpawnSwarmInput({ task: "search the repo", count: 4 })).toEqual(
			{
				task: "search the repo",
				count: 4,
				workers: 4,
			},
		);
	});

	it('keeps "max" as itself, since the number is the server\'s to pick', () => {
		expect(
			parseSpawnSwarmInput({ task: "try an approach", count: "max" }),
		).toEqual({
			task: "try an approach",
			count: "max",
		});
	});

	it("counts a per-worker task list even when no count was given", () => {
		// `tasks` is the arm where the workers do different things, so its
		// length is the worker count -- the model does not repeat it in
		// `count`, and a renderer that only reads `count` shows nothing.
		expect(
			parseSpawnSwarmInput({
				tasks: [
					{ name: "a", task: "check the parser" },
					{ task: "check the renderer" },
				],
			}),
		).toEqual({
			task: "check the parser; check the renderer",
			workers: 2,
		});
	});

	it("returns nothing when neither arm carries a task", () => {
		expect(parseSpawnSwarmInput({ count: 4 })).toBeUndefined();
		expect(parseSpawnSwarmInput({ tasks: [] })).toBeUndefined();
		expect(parseSpawnSwarmInput("nope")).toBeUndefined();
	});
});

describe("formatSpawnSwarmSummary", () => {
	it("leads with the worker count, which is the thing spawn_swarm adds", () => {
		expect(
			formatSpawnSwarmSummary(
				{ task: "search the repo", count: 4, workers: 4 },
				60,
			),
		).toBe("4 workers: search the repo");
	});

	it("says max rather than inventing a number the engine has not picked", () => {
		expect(
			formatSpawnSwarmSummary({ task: "try an approach", count: "max" }, 60),
		).toBe("max workers: try an approach");
	});

	it("agrees with itself about one worker", () => {
		expect(formatSpawnSwarmSummary({ task: "check it", workers: 1 }, 60)).toBe(
			"1 worker: check it",
		);
	});

	it("truncates the task, never the count", () => {
		// The prefix is the part a narrow row must keep: a truncated task still
		// says what kind of call this was, a truncated count does not.
		const out = formatSpawnSwarmSummary(
			{ task: "x".repeat(200), workers: 3 },
			30,
		);
		expect(out.startsWith("3 workers: ")).toBe(true);
		expect(out.endsWith("...")).toBe(true);
		expect(out.length).toBeLessThanOrEqual(33);
	});
});

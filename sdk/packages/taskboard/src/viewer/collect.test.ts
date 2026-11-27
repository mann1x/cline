import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvePipeline, savePipeline } from "../pipelines";
import { collectViewerData, focusForFile } from "./collect";

describe("what the board viewer reads from the workspace", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "board-viewer-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const journal = (id: string, events: object[], mtime: number) => {
		const dir = join(root, ".cerebriline", "pipeline-runs");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${id}.jsonl`);
		writeFileSync(
			path,
			`${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
		);
		utimesSync(path, mtime, mtime);
	};

	it("is empty, not an error, for a workspace with no pipelines", () => {
		expect(collectViewerData({ workspace: root })).toEqual({
			workspace: root,
			pipelines: [],
			runs: [],
		});
	});

	it("lists the pipelines, and the runs newest first with their nodes folded", () => {
		const dir = join(root, ".cerebriline", "pipelines");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "build.pipeline.json"),
			JSON.stringify({
				name: "build",
				nodes: [
					{ id: "compile", type: "command", command: "echo hi" },
					{ id: "tag", type: "set", after: ["compile"], fields: { ok: true } },
				],
			}),
		);
		journal(
			"build-1",
			[
				{
					t: "run",
					ts: 1000,
					run: "build-1",
					pipeline: "build",
					hash: "h1",
					inputs: {},
					task: "t3",
				},
				{ t: "start", ts: 1001, node: "compile", attempt: 1 },
				{ t: "fail", ts: 1002, node: "compile", error: "exit 2" },
				{ t: "done", ts: 1003, status: "failed", error: "compile failed" },
			],
			100,
		);
		journal(
			"build-2",
			[
				{
					t: "run",
					ts: 2000,
					run: "build-2",
					pipeline: "build",
					hash: "h1",
					inputs: { a: 1 },
					from: "build-1",
				},
				{ t: "start", ts: 2001, node: "compile", attempt: 1 },
				{
					t: "end",
					ts: 2002,
					node: "compile",
					output: { items: [{ x: 1 }], port: "out" },
				},
			],
			200,
		);
		const data = collectViewerData({
			workspace: root,
			boardText: '{"tasks":[],"layers":[]}',
			maxEvents: 2,
		});
		expect(data.boardText).toBe('{"tasks":[],"layers":[]}');
		expect(
			data.pipelines.map((pipeline) => [
				pipeline.slug,
				pipeline.valid,
				pipeline.isApproved,
			]),
		).toEqual([["build", true, false]]);
		expect(data.pipelines[0].definition?.nodes.map((node) => node.id)).toEqual([
			"compile",
			"tag",
		]);
		expect(data.runs.map((run) => [run.id, run.status])).toEqual([
			["build-2", "running"],
			["build-1", "failed"],
		]);
		const [newer, older] = data.runs;
		expect(newer.from).toBe("build-1");
		expect(newer.inputs).toEqual({ a: 1 });
		expect(newer.nodes.compile).toMatchObject({
			status: "done",
			attempts: 1,
			output: { port: "out" },
		});
		// Only the tail is sent; the count says how much there is.
		expect(newer.events.map((event) => event.t)).toEqual(["start", "end"]);
		expect(newer.eventCount).toBe(3);
		expect(older).toMatchObject({ task: "t3", error: "compile failed" });
		expect(older.nodes.compile).toMatchObject({
			status: "failed",
			error: "exit 2",
		});
	});

	it("keeps only the newest runs", () => {
		for (let i = 1; i <= 3; i++) {
			journal(
				`p-${i}`,
				[
					{
						t: "run",
						ts: i,
						run: `p-${i}`,
						pipeline: "p",
						hash: "h",
						inputs: {},
					},
				],
				i * 100,
			);
		}
		expect(
			collectViewerData({ workspace: root, maxRuns: 2 }).runs.map(
				(run) => run.id,
			),
		).toEqual(["p-3", "p-2"]);
	});

	it("focuses the pipeline or run a file belongs to", () => {
		expect(
			focusForFile("/w/.cerebriline/pipelines/build.pipeline.json"),
		).toEqual({ pipeline: "build" });
		expect(
			focusForFile("/w/.cerebriline/pipelines/approved.json"),
		).toBeUndefined();
		expect(
			focusForFile("C:\\w\\.cerebriline\\pipeline-runs\\build-2.jsonl"),
		).toEqual({ run: "build-2" });
		expect(focusForFile("/w/src/index.ts")).toBeUndefined();
		expect(focusForFile(undefined)).toBeUndefined();
	});

	it("gives a proposal its author, the approved text to compare against and the kept versions", () => {
		const first = savePipeline(root, {
			name: "deploy",
			nodes: [{ id: "up", type: "command", command: "make up" }],
		});
		if (!first.ok) throw new Error("not saved");
		approvePipeline(root, "deploy");
		const next = savePipeline(
			root,
			{
				name: "deploy",
				nodes: [{ id: "up", type: "command", command: "make up --force" }],
			},
			first.file.hash,
		);
		if (!next.ok) throw new Error("not saved");
		const [pipeline] = collectViewerData({ workspace: root }).pipelines;
		expect(pipeline).toMatchObject({
			isApproved: false,
			author: "model",
			approvedText: first.file.text,
		});
		expect(pipeline?.versions?.map((version) => version.hash)).toContain(
			first.file.hash,
		);
		expect(pipeline?.versions?.every((version) => !("text" in version))).toBe(
			true,
		);
		approvePipeline(root, "deploy");
		expect(
			collectViewerData({ workspace: root }).pipelines[0],
		).not.toHaveProperty("approvedText");
	});
});

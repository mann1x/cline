import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopCutRecord } from "@cline/shared";
import { afterEach, describe, expect, it } from "vitest";
import { appendLoopCut } from "./loop-cut-log";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true })));
});

const cut = (text: string): LoopCutRecord => ({
	agentId: "agent_1",
	iteration: 19,
	channel: "reasoning",
	cause: "reasoning_loop",
	verdict: {
		kind: "block-cycle",
		chars: 71744,
		period: 12,
		cycles: 3,
		sample: "a / b",
	},
	text,
});

describe("appendLoopCut", () => {
	it("appends one line per cut, with the text whole", async () => {
		const dir = await mkdtemp(join(tmpdir(), "loop-cut-"));
		dirs.push(dir);
		const path = join(dir, "s1", "s1.cuts.jsonl");
		const at = () => new Date("2026-10-21T14:56:00.000Z");

		await appendLoopCut(path, cut("line one\nline two\n"), at);
		await appendLoopCut(path, cut("again"), at);

		const lines = (await readFile(path, "utf8")).split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[2]).toBe("");
		expect(JSON.parse(lines[0] as string)).toEqual({
			at: "2026-10-21T14:56:00.000Z",
			...cut("line one\nline two\n"),
			chars: 18,
		});
		expect(JSON.parse(lines[1] as string).text).toBe("again");
	});
});

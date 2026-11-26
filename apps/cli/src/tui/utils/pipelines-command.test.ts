import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PIPELINES_USAGE, pipelinesCommand } from "./pipelines-command";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cli-pipelines-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writePipeline(slug: string, body: unknown) {
	const dir = join(root, ".cerebriline", "pipelines");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${slug}.pipeline.json`),
		typeof body === "string" ? body : JSON.stringify(body),
	);
}

const hello = {
	name: "Say hello",
	nodes: [{ id: "greet", type: "command", command: "echo hello" }],
};

describe("/pipelines", () => {
	it("says so when there are none", () => {
		expect(pipelinesCommand("/pipelines", root)).toContain(
			"No pipelines in .cerebriline",
		);
	});

	it("lists each file with what to do about it, and approves by name", () => {
		writePipeline("say-hello", hello);
		writePipeline(
			"broken",
			'{"name":"broken","nodes":[{"id":"a","type":"nope"}]}',
		);
		const before = pipelinesCommand("/pipelines list", root);
		expect(before).toContain("- Say hello (say-hello): not approved, version");
		expect(before).toContain("/pipelines approve say-hello");
		expect(before).toContain("- broken (broken): does not validate");

		expect(pipelinesCommand("/pipelines approve Say hello", root)).toMatch(
			/^Approved Say hello at version \w+\./,
		);
		expect(pipelinesCommand("/pipelines", root)).toContain(
			"- Say hello (say-hello): approved, version",
		);
		expect(pipelinesCommand("/pipelines approve broken", root)).toContain(
			"does not validate",
		);
		expect(pipelinesCommand("/pipelines approve nope", root)).toContain(
			'no pipeline "nope"',
		);
	});

	it("reads the runs from their journals", () => {
		expect(pipelinesCommand("/pipelines runs", root)).toBe(
			"No pipeline runs in this workspace yet.",
		);
		const dir = join(root, ".cerebriline", "pipeline-runs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "say-hello-1.jsonl"),
			[
				{
					t: "run",
					ts: 1,
					run: "say-hello-1",
					pipeline: "Say hello",
					hash: "h",
					inputs: {},
				},
				{ t: "done", ts: 2, status: "failed", error: "greet: exit 1" },
			]
				.map((event) => JSON.stringify(event))
				.join("\n"),
		);
		expect(pipelinesCommand("/pipelines runs", root)).toContain(
			"- say-hello-1 (Say hello): failed: greet: exit 1",
		);
	});

	it("prints the usage for anything else", () => {
		expect(pipelinesCommand("/pipelines approve", root)).toBe(PIPELINES_USAGE);
		expect(pipelinesCommand("/pipelines frobnicate", root)).toBe(
			PIPELINES_USAGE,
		);
	});
});

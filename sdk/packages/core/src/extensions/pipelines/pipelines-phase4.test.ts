/**
 * Pipelines phase 4: versions and approval, board → pipeline and
 * pipeline → template.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	expandTaskTemplate,
	readTaskTemplate,
	saveTaskTemplate,
} from "../tools/task-graph/templates";
import {
	acceptanceCommand,
	boardToPipeline,
	pipelineToTemplate,
} from "./convert";
import type { PipelineDefinition } from "./model";
import { validatePipeline } from "./validate";
import {
	approvePipeline,
	findPipeline,
	listPipelineVersions,
	readPipelineVersion,
	rejectPipeline,
	savePipeline,
} from "./workspace";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pipelines-p4-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const hello: PipelineDefinition = {
	name: "Say hello",
	nodes: [{ id: "hi", type: "command", command: "echo hi" }],
};
const changed = (command: string): PipelineDefinition => ({
	...hello,
	nodes: [{ id: "hi", type: "command", command }],
});

describe("versions and approval", () => {
	it("keeps each saved version with its author", () => {
		const first = savePipeline(root, hello);
		if (!first.ok) throw new Error("not saved");
		expect(first.file.author).toBe("model");
		approvePipeline(root, "say-hello");
		const second = savePipeline(root, changed("echo bye"), first.file.hash);
		if (!second.ok) throw new Error("not saved");
		const versions = listPipelineVersions(root, "say-hello");
		expect(versions.map((version) => version.hash).sort()).toEqual(
			[first.file.hash, second.file.hash].sort(),
		);
		expect(
			readPipelineVersion(root, "say-hello", second.file.hash),
		).toMatchObject({
			by: "model",
			base: first.file.hash,
		});
		// The model's proposal stays the model's after approval.
		expect(readPipelineVersion(root, "say-hello", first.file.hash)?.by).toBe(
			"model",
		);
	});

	it("approves the person's own save, and not a conversion they have not read", () => {
		const mine = savePipeline(root, hello, undefined, { by: "person" });
		expect(mine.ok && mine.file.isApproved).toBe(true);
		expect(mine.ok && mine.file.author).toBe("person");
		const converted = savePipeline(
			root,
			{ ...hello, name: "From board" },
			undefined,
			{ by: "person", approve: false },
		);
		expect(converted.ok && converted.file.isApproved).toBe(false);
	});

	it("rejects a proposal back to the approved version and marks it rejected", () => {
		const first = savePipeline(root, hello);
		if (!first.ok) throw new Error("not saved");
		approvePipeline(root, "say-hello");
		const proposal = savePipeline(
			root,
			changed("rm -rf build"),
			first.file.hash,
		);
		if (!proposal.ok) throw new Error("not saved");
		const back = rejectPipeline(root, "say-hello");
		expect(back.isApproved).toBe(true);
		expect(back.hash).toBe(first.file.hash);
		expect(
			readPipelineVersion(root, "say-hello", proposal.file.hash)?.rejected,
		).toBeDefined();
		expect(() => rejectPipeline(root, "say-hello")).toThrow(
			/nothing to reject/,
		);
	});

	it("keeps a hand edit made outside the viewer before the model replaces it", () => {
		const first = savePipeline(root, hello);
		if (!first.ok) throw new Error("not saved");
		approvePipeline(root, "say-hello");
		const path = first.file.path;
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace("echo hi", "echo by hand"),
		);
		const edited = findPipeline(root, "say-hello");
		if (!edited) throw new Error("gone");
		const next = savePipeline(root, changed("echo model"), edited.hash);
		expect(next.ok).toBe(true);
		expect(readPipelineVersion(root, "say-hello", edited.hash)?.by).toBe(
			"person",
		);
	});

	it("cannot reject what was never approved", () => {
		savePipeline(root, hello);
		expect(() => rejectPipeline(root, "say-hello")).toThrow(
			/no approved version/,
		);
	});
});

describe("board → pipeline", () => {
	it("recognises an acceptance item that is only a command", () => {
		expect(acceptanceCommand("`bun test` passes")).toBe("bun test");
		expect(acceptanceCommand("`make lint`")).toBe("make lint");
		expect(
			acceptanceCommand("`bun test` passes and the docs say so"),
		).toBeUndefined();
	});

	it("turns tasks into agent nodes, commands into checks and human gates into waits", () => {
		const { definition, notes } = boardToPipeline(
			[
				{
					id: "T1",
					title: "Build the parser",
					description: "In src/parse.ts",
					acceptance: [
						{ text: "`bun test` passes" },
						{ text: "handles empty input" },
					],
				},
				{
					id: "T2",
					title: "Ship it",
					depends: ["T1"],
					gates: [{ spec: "human:Ship now?" }, { spec: "run:abc123" }],
				},
				{ id: "T3", title: "Dropped", status: "cancelled" },
			],
			"Parser",
		);
		const checked = validatePipeline(definition);
		expect(checked.errors).toEqual([]);
		expect(definition.nodes.map((node) => `${node.id}:${node.type}`)).toEqual([
			"t1:agent",
			"t1-check:check",
			"t2-gate:wait",
			"t2:agent",
		]);
		expect(definition.nodes[0]).toMatchObject({
			task: expect.stringContaining(
				"Done when:\n- `bun test` passes\n- handles empty input",
			),
		});
		expect(definition.nodes[1]).toMatchObject({
			command: "bun test",
			after: ["t1"],
		});
		expect(definition.nodes[2]).toMatchObject({
			gate: "human:Ship now?",
			after: ["t1-check"],
		});
		expect(definition.nodes[3]).toMatchObject({ after: ["t2-gate"] });
		expect(notes.join("\n")).toContain("run:abc123");
	});

	it("lets subtasks stand for their container", () => {
		const { definition } = boardToPipeline(
			[
				{ id: "T1", title: "Setup" },
				{ id: "T2", title: "Feature", depends: ["T1"] },
				{ id: "T2.1", title: "Part A", parent: "T2" },
				{ id: "T2.2", title: "Part B", parent: "T2" },
				{ id: "T3", title: "Release", depends: ["T2"] },
			],
			"Feature",
		);
		expect(validatePipeline(definition).errors).toEqual([]);
		const byId = Object.fromEntries(
			definition.nodes.map((node) => [node.id, node]),
		);
		expect(byId.t2).toBeUndefined();
		expect(byId["t2-1"]?.after).toEqual(["t1"]);
		expect(byId.t3?.after?.sort()).toEqual(["t2-1", "t2-2"]);
	});
});

describe("pipeline → template", () => {
	const review: PipelineDefinition = {
		name: "review-and-ship",
		description: "Review {{ $vars.branch }} and ship it",
		inputs: { branch: { type: "string" } },
		nodes: [
			{
				id: "review",
				type: "agent",
				agent: "reviewer",
				task: "Review {{ $vars.branch }}",
			},
			{ id: "test", type: "command", command: "bun test", after: ["review"] },
			{ id: "green", type: "check", command: "bun run lint", after: ["test"] },
			{
				id: "ok",
				type: "if",
				when: "{{ $node.test.exit == 0 }}",
				after: ["green"],
			},
			{
				id: "ask",
				type: "approval",
				message: "Ship {{ $vars.branch }}?",
				after: ["ok.true"],
			},
			{
				id: "ship",
				type: "command",
				command: "git push origin {{ $vars.branch }}",
				after: ["ask.approve"],
			},
		],
	};

	it("keeps the work as tasks in order, with checks as acceptance and approvals as gates", () => {
		expect(validatePipeline(review).errors).toEqual([]);
		const template = pipelineToTemplate(review);
		expect(template.tasks).toEqual([
			{
				title: "agent review",
				description: "Agent reviewer: Review {{branch}}",
			},
			{
				title: "command test",
				description: "Run `bun test`.",
				acceptance: ["`bun run lint` passes"],
				depends: ["#1"],
			},
			{
				title: "command ship",
				description: "Run `git push origin {{branch}}`.",
				depends: ["#2"],
				gate: ["human:Ship {{branch}}?"],
			},
		]);
		expect(template.description).toBe("Review {{branch}} and ship it");
	});

	it("is a template the task graph reads, asking for the pipeline's inputs", () => {
		const dir = join(root, "templates");
		const path = saveTaskTemplate(dir, pipelineToTemplate(review));
		const read = readTaskTemplate(path);
		expect(read?.vars).toEqual(["branch"]);
		const { tasks, missing } = expandTaskTemplate(
			read as NonNullable<typeof read>,
			{ branch: "main" },
		);
		expect(missing).toEqual([]);
		expect(tasks[2]).toMatchObject({ gate: ["human:Ship main?"] });
	});
});

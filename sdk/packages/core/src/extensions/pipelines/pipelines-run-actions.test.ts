import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTool, createTool } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { foldJournal, PIPELINE_RUNS_DIR, readJournal } from "./journal";
import type { PipelineDefinition } from "./model";
import { PipelineSession } from "./session";
import { approvePipeline, savePipeline } from "./workspace";

/**
 * The person's actions on a run from the board viewer (ol-177): Retry,
 * Skip, Re-run from a node, and Stop, through `PipelineSession.act`.
 */

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pipelines-act-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const echoTool = createTool<unknown, unknown>({
	name: "echo_tool",
	description: "echo",
	inputSchema: { type: "object" },
	execute: async (input) => ({ echoed: input }),
});

const session = (sessionId = "s1") =>
	new PipelineSession({
		workspaceRoot: root,
		sessionId,
		tools: () => [echoTool as AgentTool],
		pollMs: 5,
	});

/** Fails until `ok.txt` is in the workspace: a fault the person can fix. */
const CHECK = `node -e "process.exit(require('fs').existsSync('ok.txt') ? 0 : 1)"`;

const ship: PipelineDefinition = {
	name: "Ship",
	nodes: [
		{ id: "gen", type: "set", fields: { version: "1.2.3" } },
		{ id: "check", type: "command", after: ["gen"], command: CHECK },
		{
			id: "ship",
			type: "tool",
			after: ["check"],
			tool: "echo_tool",
			input: { line: "shipped" },
		},
	],
};

function approved(definition: PipelineDefinition): void {
	const saved = savePipeline(root, definition);
	if (!saved.ok) throw new Error(saved.errors.join("; "));
	approvePipeline(root, definition.name, "person");
}

const fold = (run: string) =>
	foldJournal(readJournal(join(root, PIPELINE_RUNS_DIR, `${run}.jsonl`)));

async function failedRun(s: PipelineSession): Promise<string> {
	approved(ship);
	const run = s.run("ship");
	const result = await run.result();
	expect(result.status).toBe("failed");
	expect(result.failedNode).toBe("check");
	return run.id;
}

async function settled(s: PipelineSession, run: string | undefined) {
	const live = run ? s.get(run) : undefined;
	if (!live) throw new Error(`${run} is not live`);
	return live.result();
}

describe("the person's actions on a run", () => {
	it("Retry runs the failed node again and the run goes on from it", async () => {
		const s = session();
		const run = await failedRun(s);
		writeFileSync(join(root, "ok.txt"), "");
		const outcome = s.act({ op: "retry", run, node: "check" });
		expect(outcome).toMatchObject({ ok: true, run });
		expect(outcome.tell).toContain("retried node check");
		expect((await settled(s, outcome.run)).status).toBe("done");
		const after = fold(run);
		expect(after.status).toBe("done");
		const check = after.nodes.get("check");
		expect(check).toMatchObject({ status: "done", attempts: 2 });
		// It ran again and passed: the old failure is not shown on it.
		expect(check?.error).toBeUndefined();
		expect(after.nodes.get("ship")?.status).toBe("done");
	});

	it("Skip counts the failed node done, passes its input on, and keeps what it failed with", async () => {
		const s = session();
		const run = await failedRun(s);
		const outcome = s.act({ op: "skip", run, node: "check" });
		expect(outcome).toMatchObject({ ok: true, run });
		expect(outcome.tell).toContain("skipped node check");
		expect((await settled(s, outcome.run)).status).toBe("done");
		const after = fold(run);
		const check = after.nodes.get("check");
		expect(check).toMatchObject({ status: "done", bypassed: true });
		expect(check?.error).toContain("exited 1");
		expect(check?.output?.items).toEqual(after.nodes.get("gen")?.output?.items);
		expect(after.nodes.get("ship")?.status).toBe("done");
	});

	it("Skip refuses a node that picks an output, and a node that did not fail", async () => {
		const s = session();
		approved({
			name: "Branch",
			nodes: [
				{ id: "pick", type: "if", when: '{{ parse("not json") }}' },
				{
					id: "yes",
					type: "tool",
					after: ["pick.true"],
					tool: "echo_tool",
					input: {},
				},
			],
		});
		const run = s.run("branch");
		expect((await run.result()).status).toBe("failed");
		const branch = s.act({ op: "skip", run: run.id, node: "pick" });
		expect(branch.ok).toBe(false);
		expect(branch.lines[0]).toMatch(/an if: it picks one of true, false/);
		expect(fold(run.id).status).toBe("failed");

		const shipped = await failedRun(s);
		const notFailed = s.act({ op: "skip", run: shipped, node: "gen" });
		expect(notFailed).toMatchObject({ ok: false });
		expect(notFailed.lines[0]).toContain("gen did not fail (it is done)");
	});

	it("Re-run from a node starts a new run that reuses what came before it", async () => {
		const s = session();
		const run = await failedRun(s);
		writeFileSync(join(root, "ok.txt"), "");
		const outcome = s.act({ op: "rerun", run, node: "check" });
		expect(outcome.ok).toBe(true);
		expect(outcome.run).not.toBe(run);
		expect((await settled(s, outcome.run)).status).toBe("done");
		const next = fold(outcome.run as string);
		expect(next.run?.from).toBe(run);
		expect(next.nodes.get("gen")?.reused).toBe(run);
		// A finished run is re-run, not retried.
		const retry = s.act({
			op: "retry",
			run: outcome.run as string,
			node: "check",
		});
		expect(retry.ok).toBe(false);
		expect(retry.lines[0]).toContain("finished. Re-run it from check");
	});

	it("Stop ends a live run; nothing else acts on a run that is still going", async () => {
		const s = session();
		approved({
			name: "Slow",
			nodes: [
				{
					id: "nap",
					type: "command",
					command: `node -e "setTimeout(() => {}, 20000)"`,
				},
			],
		});
		const run = s.run("slow");
		const busy = s.act({ op: "rerun", run: run.id, node: "nap" });
		expect(busy).toMatchObject({
			ok: false,
			lines: [`${run.id} is still running. Stop it first.`],
		});
		expect(s.act({ op: "stop", run: run.id })).toMatchObject({ ok: true });
		expect((await run.result()).status).toBe("stopped");
		const again = s.act({ op: "stop", run: run.id });
		expect(again.ok).toBe(false);
		expect(again.lines[0]).toContain("is not running (it is stopped)");
		// A stopped node failed as stopped: Retry picks it up.
		const retry = s.act({ op: "retry", run: run.id, node: "nap" });
		expect(retry.ok).toBe(true);
		s.stop(run.id);
		await settled(s, retry.run).catch(() => undefined);
	});

	it("refuses another conversation's run and a run that is not there", async () => {
		const run = await failedRun(session("s1"));
		const other = session("s2").act({ op: "retry", run, node: "check" });
		expect(other.ok).toBe(false);
		expect(other.lines[0]).toContain("belongs to another conversation");
		expect(fold(run).status).toBe("failed");
		expect(
			session("s1").act({ op: "retry", run: "nope-1", node: "x" }),
		).toMatchObject({
			ok: false,
			lines: ["There is no run nope-1 in this workspace."],
		});
	});
});

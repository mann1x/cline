import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWork } from "../tools/task-graph/model";
import { TaskGraphStore } from "../tools/task-graph/store";
import { fill, fillString, parseExpression, test as truth } from "./expr";
import { foldJournal, readJournal } from "./journal";
import type { PipelineDefinition } from "./model";
import { type PipelineHost, PipelineRun } from "./runner";
import { validatePipeline } from "./validate";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pipelines-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A host whose commands are answered from a table, and that records what ran. */
function fakeHost(
	answers: Record<
		string,
		| { exit?: number; stdout?: string; stderr?: string }
		| (() => Promise<{ exit: number; stdout: string; stderr: string }>)
	> = {},
	more: Partial<PipelineHost> = {},
) {
	const ran: string[] = [];
	const tools: { name: string; input: unknown }[] = [];
	const host: PipelineHost = {
		async callTool(name, input) {
			tools.push({ name, input });
			return { tool: name, input };
		},
		async runCommand(command) {
			ran.push(command);
			const answer = answers[command];
			if (typeof answer === "function") return answer();
			return {
				exit: answer?.exit ?? 0,
				stdout: answer?.stdout ?? `ran ${command}`,
				stderr: answer?.stderr ?? "",
			};
		},
		async waitGate() {
			return { open: true };
		},
		async approve() {
			return true;
		},
		...more,
	};
	return { host, ran, tools };
}

function start(
	definition: PipelineDefinition,
	host: PipelineHost,
	extra: Partial<Parameters<typeof PipelineRun.start>[0]> = {},
) {
	const checked = validatePipeline(definition);
	expect(checked.errors).toEqual([]);
	return PipelineRun.start({
		definition,
		hash: "h",
		host,
		journalDir: dir,
		...extra,
	});
}

const never = () =>
	new Promise<{ exit: number; stdout: string; stderr: string }>(() => {});

describe("expressions", () => {
	const scope = {
		$vars: { n: 2, s: "x", list: [1, 2, 3], obj: { a: { b: "deep" } } },
		$node: { test: { exit: 0, items: [{ v: 5 }] } },
	};

	it("a lone expression keeps its type; text in a string gives text", () => {
		expect(fillString("{{ $vars.n + 1 }}", scope)).toBe(3);
		expect(fillString("{{ $vars.list }}", scope)).toEqual([1, 2, 3]);
		expect(fillString("n is {{ $vars.n }}, s is {{ $vars.s }}", scope)).toBe(
			"n is 2, s is x",
		);
		expect(fillString("{{ $vars.obj }}!", scope)).toBe('{"a":{"b":"deep"}}!');
		expect(fill({ a: ["{{ $vars.s }}", 1] }, scope)).toEqual({ a: ["x", 1] });
	});

	it("reads fields, indexes, lists, conditions and the functions", () => {
		expect(fillString("{{ $vars.obj.a.b }}", scope)).toBe("deep");
		expect(fillString("{{ $node.test.items[0].v * 2 }}", scope)).toBe(10);
		expect(fillString("{{ $vars.list[-1] }}", scope)).toBe(3);
		expect(
			fillString("{{ len($vars.list) > 2 ? 'many' : 'few' }}", scope),
		).toBe("many");
		expect(fillString("{{ join(['a', 'b'], '-') }}", scope)).toBe("a-b");
		expect(
			fillString(
				"{{ contains($vars.list, 2) && !contains($vars.list, 9) }}",
				scope,
			),
		).toBe(true);
		expect(
			fillString(
				"{{ $vars.missing ?? default($vars.empty, 'fallback') }}",
				scope,
			),
		).toBe("fallback");
		expect(truth("$node.test.exit == 0", scope)).toBe(true);
		expect(truth("{{ '1' == 1 }}", scope)).toBe(true);
	});

	it("cannot reach a prototype, call a function it does not know, or name what is not in scope", () => {
		expect(fillString("{{ $vars.constructor }}", scope)).toBeUndefined();
		expect(fillString("{{ $vars.__proto__ }}", scope)).toBeUndefined();
		expect(() => parseExpression("eval('1')")).toThrow(
			/unknown function "eval"/,
		);
		expect(() => fillString("{{ process }}", scope)).toThrow(
			/unknown name "process"/,
		);
		expect(() => parseExpression("$vars.n +")).toThrow();
		expect(() => parseExpression("'open")).toThrow(/unclosed string/);
	});
});

describe("validatePipeline", () => {
	it("accepts a pipeline and lists every problem of a bad one at once", () => {
		expect(
			validatePipeline({
				name: "ok",
				nodes: [
					{ id: "a", type: "command", command: "true" },
					{
						id: "b",
						type: "if",
						after: ["a"],
						when: "{{ $node.a.exit == 0 }}",
					},
					{ id: "c", type: "set", after: ["b.true"], fields: { x: 1 } },
				],
			}).ok,
		).toBe(true);
		const bad = validatePipeline({
			name: "bad",
			nodes: [
				{ id: "a", type: "nope" },
				{ id: "b", type: "command" },
				{ id: "c", type: "if", when: "x", after: ["ghost"] },
				{ id: "d", type: "set", after: ["c"] },
				{ id: "e", type: "set", after: ["c.maybe"] },
				{ id: "f", type: "set", after: ["g"], fields: { v: "{{ 1 + }}" } },
				{ id: "g", type: "set", after: ["f"] },
				{ id: "h", type: "http", onError: "shrug", retry: { max: 0 } },
				{ id: "h2", type: "swarm", instructions: "r" },
				{
					id: "i",
					type: "loop",
					over: "[1]",
					body: { type: "approval", message: "m" },
				},
				{ id: "i", type: "set" },
			],
		});
		expect(bad.ok).toBe(false);
		const text = bad.errors.join("\n");
		expect(text).toContain('node "a": type "nope" is not a node type');
		expect(text).toContain('node "b": a command node needs "command"');
		expect(text).toContain('node "c": after "ghost", which is no node');
		expect(text).toContain(
			'node "d": after "c" must name which output: "c.true" or "c.false"',
		);
		expect(text).toContain('"c" has no output "maybe"');
		expect(text).toContain("{{ 1 + }}");
		expect(text).toContain("the nodes run in a circle");
		expect(text).toContain('node "h": a http node needs "url"');
		expect(text).toContain(
			'node "h": onError "shrug" is not one of stop, continue, route',
		);
		expect(text).toContain('node "h": "retry" is {max: retries (at least 1)');
		expect(text).toContain('node "h2": a swarm node needs "tasks"');
		expect(text).toContain("a loop body is one");
		expect(text).toContain('node "i": the id is used twice');
	});

	it("reads JSON text and says when it is not JSON", () => {
		expect(
			validatePipeline('{"name":"x","nodes":[{"id":"a","type":"merge"}]}').ok,
		).toBe(true);
		expect(validatePipeline("{nope").errors[0]).toMatch(/^not JSON/);
	});
});

describe("running a pipeline", () => {
	it("runs nodes in order, passes items, and journals and boards every step", async () => {
		const { host, ran, tools } = fakeHost({
			"make dist": { stdout: "built 3 files" },
		});
		const run = start(
			{
				name: "Build and report",
				inputs: { target: { type: "string", default: "dist" } },
				nodes: [
					{ id: "build", type: "command", command: "make {{ $vars.target }}" },
					{
						id: "shape",
						type: "set",
						after: ["build"],
						fields: { line: "{{ $item.stdout }}", ok: "{{ $item.exit == 0 }}" },
					},
					{
						id: "report",
						type: "tool",
						after: ["shape"],
						tool: "write_note",
						input: { text: "{{ $node.shape.items[0].line }}" },
					},
				],
			},
			host,
		);
		expect(run.id).toBe("build-and-report-1");
		const result = await run.result();
		expect(result.status).toBe("done");
		expect(ran).toEqual(["make dist"]);
		expect(tools).toEqual([
			{ name: "write_note", input: { text: "built 3 files" } },
		]);
		const fold = foldJournal(readJournal(run.journalPath));
		expect(fold.status).toBe("done");
		expect(fold.nodes.get("shape")?.output?.items).toEqual([
			{ line: "built 3 files", ok: true },
		]);
		const board = run.board.snapshot();
		expect(board.tasks.map((task) => [task.title, task.status])).toEqual([
			["build (command)", "done"],
			["shape (set)", "done"],
			["report (tool)", "done"],
		]);
		expect(board.tasks[1]?.depends).toEqual(["T1"]);
	});

	it("a branch not taken skips what is after it, and everything after that", async () => {
		const { host, ran } = fakeHost({ test: { exit: 1 } });
		const run = start(
			{
				name: "branch",
				nodes: [
					{ id: "test", type: "command", command: "test", allowFailure: true },
					{
						id: "ok",
						type: "if",
						after: ["test"],
						when: "$node.test.exit == 0",
					},
					{ id: "ship", type: "command", after: ["ok.true"], command: "ship" },
					{
						id: "announce",
						type: "command",
						after: ["ship"],
						command: "announce",
					},
					{ id: "fix", type: "command", after: ["ok.false"], command: "fix" },
				],
			},
			host,
		);
		expect((await run.result()).status).toBe("done");
		expect(ran).toEqual(["test", "fix"]);
		const view = run.view();
		expect(view.nodes.find((node) => node.id === "ship")?.status).toBe(
			"skipped",
		);
		expect(view.nodes.find((node) => node.id === "announce")?.reason).toBe(
			"ship did not run",
		);
		expect(view.nodes.find((node) => node.id === "ok")?.port).toBe("false");
	});

	it("switch picks the case named by the value, or default", async () => {
		const { host, ran } = fakeHost();
		const run = start(
			{
				name: "switch",
				inputs: { env: { type: "string" } },
				nodes: [
					{
						id: "where",
						type: "switch",
						on: "$vars.env",
						cases: ["prod", "staging"],
					},
					{
						id: "p",
						type: "command",
						after: ["where.prod"],
						command: "deploy prod",
					},
					{
						id: "d",
						type: "command",
						after: ["where.default"],
						command: "deploy dev",
					},
				],
			},
			host,
			{ inputs: { env: "laptop" } },
		);
		await run.result();
		expect(ran).toEqual(["deploy dev"]);
	});

	it("merge: all waits for every input, append takes what ran, first the first", async () => {
		const { host } = fakeHost();
		const run = start(
			{
				name: "merges",
				nodes: [
					{ id: "a", type: "set", fields: { from: "a", k: 1 } },
					{ id: "b", type: "set", fields: { from: "b", k: 1, extra: true } },
					{ id: "gate", type: "if", when: "false" },
					{ id: "c", type: "set", after: ["gate.true"], fields: { from: "c" } },
					{ id: "all", type: "merge", after: ["a", "c"] },
					{
						id: "append",
						type: "merge",
						mode: "append",
						after: ["a", "b", "c"],
					},
					{ id: "first", type: "merge", mode: "first", after: ["a", "c"] },
					{
						id: "keyed",
						type: "merge",
						mode: "by-key",
						key: "k",
						after: ["a", "b"],
					},
				],
			},
			host,
		);
		await run.result();
		const nodes = Object.fromEntries(
			run.view().nodes.map((node) => [node.id, node]),
		);
		expect(nodes.all?.status).toBe("skipped");
		const fold = foldJournal(readJournal(run.journalPath));
		expect(fold.nodes.get("append")?.output?.items).toEqual([
			{ from: "a", k: 1 },
			{ from: "b", k: 1, extra: true },
		]);
		expect(fold.nodes.get("first")?.output?.items).toEqual([
			{ from: "a", k: 1 },
		]);
		expect(fold.nodes.get("keyed")?.output?.items).toEqual([
			{ from: "b", k: 1, extra: true },
		]);
	});

	it("a loop runs its body per item, at most `parallel` at a time, keeping the order", async () => {
		let live = 0;
		let peak = 0;
		const host = fakeHost().host;
		host.runCommand = async (command) => {
			live++;
			peak = Math.max(peak, live);
			await new Promise((resolve) => setTimeout(resolve, 5));
			live--;
			return { exit: 0, stdout: command, stderr: "" };
		};
		const run = start(
			{
				name: "loop",
				nodes: [
					{
						id: "each",
						type: "loop",
						over: "['a','b','c','d','e']",
						parallel: 2,
						body: {
							type: "command",
							command: "lint {{ $item }} #{{ $index }}",
						},
					},
				],
			},
			host,
		);
		await run.result();
		const items = foldJournal(readJournal(run.journalPath)).nodes.get("each")
			?.output?.items as { stdout: string }[];
		expect(items.map((item) => item.stdout)).toEqual([
			"lint a #0",
			"lint b #1",
			"lint c #2",
			"lint d #3",
			"lint e #4",
		]);
		expect(peak).toBe(2);
	});

	it("independent nodes run side by side up to maxParallel", async () => {
		let live = 0;
		let peak = 0;
		const host = fakeHost().host;
		host.runCommand = async () => {
			live++;
			peak = Math.max(peak, live);
			await new Promise((resolve) => setTimeout(resolve, 5));
			live--;
			return { exit: 0, stdout: "", stderr: "" };
		};
		const nodes = ["a", "b", "c", "d", "e"].map((id) => ({
			id,
			type: "command" as const,
			command: id,
		}));
		await start({ name: "wide", maxParallel: 3, nodes }, host).result();
		expect(peak).toBe(3);
	});

	it("a failing command stops the run; what is after it is not reached", async () => {
		const { host, ran } = fakeHost({ test: { exit: 2, stderr: "1 failed" } });
		const run = start(
			{
				name: "fails",
				nodes: [
					{ id: "test", type: "command", command: "test" },
					{ id: "ship", type: "command", after: ["test"], command: "ship" },
				],
			},
			host,
		);
		const result = await run.result();
		expect(result.status).toBe("failed");
		expect(result.error).toBe('node "test" failed: exited 2: 1 failed');
		expect(ran).toEqual(["test"]);
		expect(run.view().nodes[1]?.status).toBe("pending");
		expect(run.board.snapshot().tasks[1]?.notes.at(-1)).toBe(
			"not reached: the run failed",
		);
	});

	it("check fails on a false condition; a timeout fails the node", async () => {
		const { host } = fakeHost({ slow: never });
		const checked = start(
			{
				name: "c",
				nodes: [{ id: "c", type: "check", when: "1 > 2", message: "math" }],
			},
			host,
		);
		expect((await checked.result()).error).toContain("math: 1 > 2 is false");
		const timed = start(
			{
				name: "t",
				nodes: [{ id: "s", type: "command", command: "slow", timeout: 0.02 }],
			},
			host,
		);
		expect((await timed.result()).error).toBe(
			'node "s" failed: timed out after 0.02 s',
		);
	});

	it("waits on a gate through the host, and an approval routes by the answer", async () => {
		const gates: string[] = [];
		const asked: string[] = [];
		const { host, ran } = fakeHost(
			{},
			{
				async waitGate(spec) {
					gates.push(spec);
					return { open: true };
				},
				async approve(message) {
					asked.push(message);
					return false;
				},
			},
		);
		const run = start(
			{
				name: "gated",
				nodes: [
					{ id: "later", type: "wait", gate: "timer:+5m" },
					{
						id: "ask",
						type: "approval",
						after: ["later"],
						message: "Ship {{ $run.pipeline }}?",
					},
					{
						id: "ship",
						type: "command",
						after: ["ask.approve"],
						command: "ship",
					},
					{
						id: "drop",
						type: "command",
						after: ["ask.reject"],
						command: "drop",
					},
				],
			},
			host,
		);
		await run.result();
		expect(gates).toEqual(["timer:+5m"]);
		expect(asked).toEqual(["Ship gated?"]);
		expect(ran).toEqual(["drop"]);
	});

	it("a failed gate fails the node", async () => {
		const { host } = fakeHost(
			{},
			{ waitGate: async () => ({ failed: "the PR was closed" }) },
		);
		const run = start(
			{ name: "g", nodes: [{ id: "w", type: "wait", gate: "gh-pr:o/r#1" }] },
			host,
		);
		expect((await run.result()).error).toBe(
			'node "w" failed: gh-pr:o/r#1 can no longer open: the PR was closed',
		);
	});

	it("a test run returns pinned items instead of running the node", async () => {
		const { host, ran } = fakeHost();
		const run = start(
			{
				name: "pinned",
				nodes: [
					{
						id: "fetch",
						type: "command",
						command: "curl api",
						pin: [{ id: 7 }],
					},
					{
						id: "use",
						type: "set",
						after: ["fetch"],
						fields: { got: "{{ $item.id }}" },
					},
				],
			},
			host,
			{ usePins: true },
		);
		await run.result();
		expect(ran).toEqual([]);
		expect(
			foldJournal(readJournal(run.journalPath)).nodes.get("use")?.output?.items,
		).toEqual([{ got: 7 }]);
	});

	it("inputs: defaults are filled, a missing or mistyped one is refused before anything runs", () => {
		const { host } = fakeHost();
		const definition: PipelineDefinition = {
			name: "in",
			inputs: { branch: { type: "string" }, n: { type: "number", default: 1 } },
			nodes: [{ id: "a", type: "set" }],
		};
		expect(() =>
			PipelineRun.start({ definition, hash: "h", host, journalDir: dir }),
		).toThrow('inputs: "branch" is required');
		expect(() =>
			PipelineRun.start({
				definition,
				hash: "h",
				host,
				journalDir: dir,
				inputs: { branch: 3 },
			}),
		).toThrow('"branch" is a string, not a number');
	});

	it("stop, then resume: the stopped node runs again and the run finishes", async () => {
		let calls = 0;
		const { host } = fakeHost({
			slow: () => {
				calls++;
				return calls === 1
					? never()
					: Promise.resolve({ exit: 0, stdout: "second time", stderr: "" });
			},
		});
		const definition: PipelineDefinition = {
			name: "stoppable",
			nodes: [
				{ id: "first", type: "command", command: "first" },
				{ id: "slow", type: "command", after: ["first"], command: "slow" },
			],
		};
		const run = start(definition, host);
		await new Promise((resolve) => setTimeout(resolve, 10));
		run.stop("the person stopped it");
		const stopped = await run.result();
		expect(stopped.status).toBe("stopped");
		const again = PipelineRun.resume({
			definition,
			hash: "h",
			host,
			journalDir: dir,
			run: run.id,
		});
		expect((await again.result()).status).toBe("done");
		const fold = foldJournal(readJournal(run.journalPath));
		expect(fold.nodes.get("slow")?.output?.stdout).toBe("second time");
		expect(fold.nodes.get("first")?.attempts).toBe(1);
	});

	it("after a reload, an idempotent node in flight runs again; another fails as interrupted", async () => {
		const definition = (idempotent: boolean): PipelineDefinition => ({
			name: idempotent ? "safe" : "unsafe",
			nodes: [{ id: "push", type: "command", command: "push", idempotent }],
		});
		for (const idempotent of [true, false]) {
			const hung = fakeHost({ push: never }).host;
			const first = start(definition(idempotent), hung);
			await new Promise((resolve) => setTimeout(resolve, 5));
			const { host, ran } = fakeHost();
			const recovered = PipelineRun.recover({
				definition: definition(idempotent),
				hash: "h",
				host,
				journalDir: dir,
				run: first.id,
			});
			const result = await recovered?.result();
			if (idempotent) {
				expect(result?.status).toBe("done");
				expect(ran).toEqual(["push"]);
			} else {
				expect(result?.status).toBe("failed");
				expect(ran).toEqual([]);
				expect(recovered?.view().nodes[0]?.error).toMatch(/^interrupted/);
			}
		}
	});
});

describe("a run on the conversation's board", () => {
	it("is one task held by the run: refused to the model, no block to its auto-start or close-out", async () => {
		const board = new TaskGraphStore();
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { host } = fakeHost({
			slow: async () => {
				await gate;
				return { exit: 0, stdout: "", stderr: "" };
			},
		});
		const run = start(
			{
				name: "Nightly",
				nodes: [{ id: "slow", type: "command", command: "slow" }],
			},
			host,
			{ board },
		);
		const task = board.snapshot().tasks[0];
		expect(task?.title).toBe("▶ Nightly #1");
		expect(task?.status).toBe("active");
		expect(task?.claimedBy).toBe("pipeline:nightly-1");
		// The model's change is refused while the run is live.
		const refused = board.update(
			{ updates: [{ id: "T1", status: "done" }] },
			{ by: "model" },
		);
		expect(refused.lines.join(" ")).toContain("held by pipeline:nightly-1");
		// Its own work starts beside the run, and the close-out does not ask for the run.
		board.plan({
			tasks: [
				{ title: "Review the docs" },
				{ title: "Ship", gate: ["pipeline:nightly-1"] },
			],
		});
		expect(
			board.snapshot().tasks.find((entry) => entry.id === "T2")?.status,
		).toBe("active");
		expect(openWork(board.getState()).map((entry) => entry.id)).toEqual(["T2"]);
		release();
		const result = await run.result();
		expect(board.snapshot().tasks[0]?.status).toBe("done");
		expect(board.snapshot().tasks[0]?.outcome).toBe("1 node done");
		expect(
			board.snapshot().tasks.find((entry) => entry.id === "T3")?.gates[0]?.open,
		).toBe(true);
		expect(result.boardLines.join(" ")).toContain(
			"T3: pipeline:nightly-1 opened.",
		);
	});

	it("a failed run fails the gate that waited on it", async () => {
		const board = new TaskGraphStore();
		const { host } = fakeHost({ boom: { exit: 1 } });
		board.plan({ tasks: [{ title: "Busy", start: true }] });
		board.plan({ tasks: [{ title: "After", gate: ["pipeline:fragile-1"] }] });
		const run = start(
			{
				name: "Fragile",
				nodes: [{ id: "x", type: "command", command: "boom" }],
			},
			host,
			{ board },
		);
		await run.result();
		const after = board
			.snapshot()
			.tasks.find((entry) => entry.title === "After");
		expect(after?.gates[0]?.failed).toContain("the run failed");
		expect(
			board.snapshot().tasks.find((entry) => entry.title.startsWith("▶"))
				?.status,
		).toBe("cancelled");
	});
});

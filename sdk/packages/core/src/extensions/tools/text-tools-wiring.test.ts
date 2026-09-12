/**
 * The wiring, not the tools.
 *
 * `grep.test.ts`, `sed.test.ts` and `awk.test.ts` prove the three executors
 * behave like the binaries they are named after. These tests prove the far
 * cheaper thing to get wrong: that a host calling `createDefaultExecutors` and
 * `createDefaultTools` the ordinary way actually ends up with them, that they
 * search the directory the host named rather than the process's, and that they
 * share one read registry with the reader and the editor.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolContext } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_DEFAULT_TOOL_NAMES } from "./constants";
import { createDefaultTools } from "./definitions";
import { createDefaultExecutors } from "./executors/index";
import type { ToolOperationResult } from "./types";

const CONTEXT = {} as AgentToolContext;

describe("grep / sed / awk reach a host that asks for the defaults", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), "text-tools-wiring-"));
		await fs.writeFile(join(dir, "data.txt"), "alpha 1\nbeta 2\ngamma 3\n");
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	function build() {
		const executors = createDefaultExecutors();
		const tools = createDefaultTools({ executors, cwd: dir });
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		return { executors, tools, byName };
	}

	/** One-result tools: grep and awk. */
	async function callOne(
		tool: { execute: (input: never, context: AgentToolContext) => unknown },
		input: unknown,
	): Promise<ToolOperationResult> {
		return (await tool.execute(input as never, CONTEXT)) as ToolOperationResult;
	}

	/** sed, which answers once per file. */
	async function callSed(
		tool: { execute: (input: never, context: AgentToolContext) => unknown },
		input: unknown,
	): Promise<ToolOperationResult[]> {
		return (await tool.execute(
			input as never,
			CONTEXT,
		)) as ToolOperationResult[];
	}

	it("registers all three by default", () => {
		const { byName } = build();
		expect([...byName.keys()]).toEqual(
			expect.arrayContaining(["grep", "sed", "awk"]),
		);
	});

	it("leaves them out when the host disables them", () => {
		const executors = createDefaultExecutors();
		const tools = createDefaultTools({
			executors,
			cwd: dir,
			enableGrep: false,
			enableSed: false,
			enableAwk: false,
		});
		const names = tools.map((tool) => tool.name);
		expect(names).not.toContain("grep");
		expect(names).not.toContain("sed");
		expect(names).not.toContain("awk");
		// Disabling these says nothing about the rest.
		expect(names).toContain("read_files");
	});

	it("names them in ALL_DEFAULT_TOOL_NAMES", () => {
		// Not compiler-enforced — the array is typed, not exhaustive — so a tool
		// added to the union and forgotten here would go unnoticed.
		expect(ALL_DEFAULT_TOOL_NAMES).toEqual(
			expect.arrayContaining(["grep", "sed", "awk"]),
		);
	});

	it("resolves paths against the cwd the host gave the tools", async () => {
		// The executors were built without a cwd of their own. If the tool layer
		// did not pass one per call they would search the process's directory,
		// find nothing, and say so — which reads exactly like a correct search.
		const { byName } = build();
		const result = await callOne(byName.get("grep") as never, {
			pattern: "beta",
			paths: ["data.txt"],
		});
		expect(result.success).toBe(true);
		expect(result.result).toContain("data.txt:2:beta 2");
	});

	it("runs an awk program through the tool layer", async () => {
		const { byName } = build();
		const result = await callOne(byName.get("awk") as never, {
			program: "{sum += $2} END {print sum}",
			files: ["data.txt"],
		});
		expect(result.success).toBe(true);
		expect(String(result.result).trim()).toBe("6");
	});

	it("shares one read registry: grep counts as the read sed -i requires", async () => {
		const { byName } = build();
		const file = join(dir, "data.txt");

		// Unread, so an in-place rewrite is refused — and the refusal has to
		// reach the model as `success: false`, not as prose inside a successful
		// result, or a blocked write reads exactly like a completed one.
		const [refused] = await callSed(byName.get("sed") as never, {
			script: "s/beta/BETA/",
			files: ["data.txt"],
			in_place: true,
		});
		expect(refused.success).toBe(false);
		expect(refused.error).toContain("Read before editing");
		expect(await fs.readFile(file, "utf8")).toContain("beta 2");

		// grep it, and the same call goes through.
		await callOne(byName.get("grep") as never, {
			pattern: "beta",
			paths: ["data.txt"],
		});
		const [allowed] = await callSed(byName.get("sed") as never, {
			script: "s/beta/BETA/",
			files: ["data.txt"],
			in_place: true,
		});
		expect(allowed.success).toBe(true);
		expect(await fs.readFile(file, "utf8")).toContain("BETA 2");
	});

	it("reports a bad pattern as a failed call rather than throwing", async () => {
		const { byName } = build();
		const result = await callOne(byName.get("grep") as never, {
			pattern: "a\\(b",
			paths: ["data.txt"],
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain("grep failed");
	});
});

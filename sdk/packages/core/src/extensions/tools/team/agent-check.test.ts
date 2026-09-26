import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { OracleSpawnWrapper } from "../../../runtime/atomic/oracle";
import {
	AGENT_CHECK_MAX_IDENTICAL_FAILS,
	createDelegatedAgentCheck,
	describeAgentCheck,
	readAgentCheck,
} from "./agent-check";

/** A launcher stand-in: runs the command as given, and records that it did. */
function recordingLauncher(): { wrap: OracleSpawnWrapper; calls: number } {
	const state = {
		calls: 0,
		wrap: ((spec) => {
			state.calls += 1;
			return spec;
		}) as OracleSpawnWrapper,
	};
	return state;
}

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-check-"));
	try {
		return await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("reading the lead's check", () => {
	it("takes the schema's shape as written", () => {
		expect(
			readAgentCheck({ command: "node t.js", expect: "ok", must: "match" }),
		).toEqual({ command: "node t.js", expect: "ok" });
	});

	it("takes the shapes a model sends instead", () => {
		expect(
			readAgentCheck(
				'{"cmd": "node t.js", "pattern": "/FAIL/", "must": "not-match"}',
			),
		).toEqual({ command: "node t.js", expect: "FAIL", must: "not_match" });
	});

	it("reads no check as none", () => {
		expect(readAgentCheck(undefined)).toBeUndefined();
		expect(readAgentCheck("")).toBeUndefined();
	});

	it("refuses a check it cannot run, and says why", () => {
		expect(() => readAgentCheck({ expect: "ok" })).toThrow(/no `command`/);
		expect(() => readAgentCheck({ command: "x", expect: "(" })).toThrow(
			/not a valid regular expression/,
		);
		expect(() =>
			readAgentCheck({ command: "x", expect: "y", must: "maybe" }),
		).toThrow(/"match" or "not_match"/);
	});
});

describe("telling the agent its check", () => {
	it("states the command and the pattern up front", () => {
		const text = describeAgentCheck(
			{ command: "node run_game.js", expect: '"ok":true' },
			true,
		);
		expect(text).toContain("`node run_game.js`");
		expect(text).toContain('/"ok":true/');
		expect(text).toContain("run_commands");
	});

	it("says it will not be run where there is no sandboxed shell", () => {
		const text = describeAgentCheck(
			{ command: "node t.js", expect: "ERR", must: "not_match" },
			false,
		);
		expect(text).toContain("must NOT match");
		expect(text).toContain("will not be run");
	});
});

describe("the check at the agent's completion attempt", () => {
	it("keeps a failing agent working, and shows it the output", async () => {
		await withDir(async (dir) => {
			const launcher = recordingLauncher();
			const check = createDelegatedAgentCheck({
				check: { command: "echo BROKEN; exit 0", expect: "^fixed" },
				cwd: dir,
				wrapSpawn: launcher.wrap,
			});
			const message = await check.onCompletionAttempt({ text: "done" });
			expect(message).toContain("Your check did not pass");
			expect(message).toContain("BROKEN");
			expect(launcher.calls).toBe(1);
			expect(check.result()).toMatchObject({
				status: "fail",
				exitCode: 0,
				runs: 1,
			});
		});
	});

	it("lets a passing agent finish, and records the pass", async () => {
		await withDir(async (dir) => {
			const launcher = recordingLauncher();
			const check = createDelegatedAgentCheck({
				check: { command: "echo fixed", expect: "^fixed" },
				cwd: dir,
				wrapSpawn: launcher.wrap,
			});
			expect(await check.onCompletionAttempt({ text: "done" })).toBeUndefined();
			expect(check.result()).toMatchObject({
				status: "pass",
				exitCode: 0,
				output: "fixed",
			});
		});
	});

	// Every delegated command runs sandboxed. With no launcher the check is
	// reported as not run -- running it on the host would read the lead's
	// files, not the agent's, and could write the real workspace.
	it("does not run on the host when there is no command sandbox", async () => {
		let ran = false;
		const check = createDelegatedAgentCheck({
			check: { command: "echo x", expect: "x" },
			cwd: "/nowhere",
			run: async () => {
				ran = true;
				return { passed: true, exitCode: 0, output: "", timedOut: false };
			},
		});
		expect(await check.onCompletionAttempt({})).toBeUndefined();
		expect(ran).toBe(false);
		expect(check.result()).toMatchObject({
			status: "not_run",
			reason: "no command sandbox",
		});
	});

	it("lets the agent finish once the failure has stopped moving", async () => {
		const check = createDelegatedAgentCheck({
			check: { command: "x", expect: "never" },
			cwd: "/w",
			wrapSpawn: (spec) => spec,
			run: async () => ({
				passed: false,
				exitCode: 1,
				output: "same error",
				timedOut: false,
			}),
		});
		const replies: Array<string | undefined> = [];
		for (let i = 0; i < AGENT_CHECK_MAX_IDENTICAL_FAILS; i += 1) {
			replies.push(await check.onCompletionAttempt({}));
		}
		expect(replies.slice(0, -1).every((reply) => reply !== undefined)).toBe(
			true,
		);
		expect(replies.at(-1)).toBeUndefined();
		expect(check.result()).toMatchObject({
			status: "fail",
			runs: AGENT_CHECK_MAX_IDENTICAL_FAILS,
		});
		expect(check.result()?.reason).toContain("same failing output");
	});

	it("judges nothing once closed: the lead's summary is not an attempt", async () => {
		let runs = 0;
		const check = createDelegatedAgentCheck({
			check: { command: "x", expect: "y" },
			cwd: "/w",
			wrapSpawn: (spec) => spec,
			run: async () => {
				runs += 1;
				return { passed: false, exitCode: 1, output: "", timedOut: false };
			},
		});
		check.close();
		expect(await check.onCompletionAttempt({})).toBeUndefined();
		expect(runs).toBe(0);
	});

	it("passes must: not_match through to the runner", async () => {
		await withDir(async (dir) => {
			const check = createDelegatedAgentCheck({
				check: { command: "echo all good", expect: "ERROR", must: "not_match" },
				cwd: dir,
				wrapSpawn: (spec) => spec,
			});
			expect(await check.onCompletionAttempt({})).toBeUndefined();
			expect(check.result()?.status).toBe("pass");
		});
	});
});

import { describe, expect, it, vi } from "vitest";
import type { Oracle, OracleVerdict } from "./oracle";
import type { CheckApprover } from "./proposal";
import { createProposeCheckTool } from "./propose-check-tool";

const ROOT = "/work";

/** A base the candidate check fails on, which is what makes it a check. */
const FAILS_ON_BASE: OracleVerdict = {
	passed: false,
	exitCode: 1,
	output: "still broken",
	timedOut: false,
};

function adopter(existing?: Oracle, base: OracleVerdict = FAILS_ON_BASE) {
	const adopted: Oracle[] = [];
	const tried: Oracle[] = [];
	return {
		adopted,
		tried,
		async judgeAgainstBase(oracle: Oracle) {
			tried.push(oracle);
			return base;
		},
		get canAdoptOracle() {
			return existing === undefined && adopted.length === 0;
		},
		adoptOracle(oracle: Oracle) {
			if (!this.canAdoptOracle) {
				throw new Error("frozen");
			}
			adopted.push(oracle);
		},
	};
}

function toolWith(approve: CheckApprover, controller = adopter()) {
	const tool = createProposeCheckTool({
		workspaceRoot: ROOT,
		controller,
		approve,
	});
	const run = (input: unknown) =>
		(tool.execute as (input: unknown, context: unknown) => Promise<string>)(
			input,
			{} as never,
		);
	return { tool, run, controller };
}

const PAGE = {
	kind: "page",
	path: "game.html",
	reason: "the task is this page",
};

describe("propose_check", () => {
	it("adopts a check the user approves", async () => {
		const { run, controller } = toolWith(async () => ({ approved: true }));

		const output = await run(PAGE);

		expect(controller.adopted).toHaveLength(1);
		expect(controller.adopted[0].kind).toBe("page");
		expect(output).toContain("Approved");
	});

	// Four proposals across one ten-run arm named `path` or `command` and no
	// `kind`. Each was rejected for saying nothing the proposal had not
	// already said, and in the run that failed outright the rejection is what
	// pushed the model on to the check that could never pass.
	describe("kind it did not name", () => {
		it("reads a page from `path` alone", async () => {
			const { run, controller } = toolWith(async () => ({ approved: true }));

			const output = await run({
				path: "game.html",
				reason: "the task is this page",
			});

			expect(output).toContain("Approved");
			expect(controller.adopted[0].kind).toBe("page");
		});

		it("reads a command from `command` alone", async () => {
			const { run, controller } = toolWith(async () => ({ approved: true }));

			const output = await run({
				command: "node run.js",
				expect: '"ok":true',
				reason: "it prints the verdict",
			});

			expect(output).toContain("Approved");
			expect(controller.adopted[0].kind).toBeUndefined();
			expect(controller.adopted[0].label).toBe("node run.js");
		});

		// Both fields and no `kind` is two different checks, and it used to
		// take the command and drop the path without saying so.
		it("asks which one, rather than dropping a field", async () => {
			const approve = vi.fn(async () => ({ approved: true as const }));
			const { run, controller } = toolWith(approve);

			const output = await run({
				path: "game.html",
				command: "node run.js",
				reason: "both, somehow",
			});

			expect(output).toContain("both `path` and `command`");
			expect(controller.adopted).toHaveLength(0);
			// Not a spent round: the user was never asked anything.
			expect(approve).not.toHaveBeenCalled();
		});

		it("still refuses a `kind` that is neither", async () => {
			const { run, controller } = toolWith(async () => ({ approved: true }));

			const output = await run({
				kind: "browser",
				path: "game.html",
				reason: "the task is this page",
			});

			expect(output).toContain("`browser` is neither");
			expect(controller.adopted).toHaveLength(0);
		});
	});

	// A command with no `expect` is judged on its exit code alone. Three
	// proposals in the same arm were that, against a runner that prints its
	// verdict and exits zero either way, and all three were told only that the
	// check "already passes" -- true, and not the thing to fix.
	it("names the missing `expect` when the check passed on the base", async () => {
		const passesOnBase: OracleVerdict = {
			passed: true,
			exitCode: 0,
			output: '{"ok":false,"error":"SyntaxError"}',
			timedOut: false,
		};
		const { run } = toolWith(
			async () => ({ approved: true }),
			adopter(undefined, passesOnBase),
		);

		const output = await run({
			kind: "command",
			command: "node run_game.js game.html",
			reason: "it runs the game",
		});

		expect(output).toContain("`expect`");
		expect(output).toContain("exit code is the whole verdict");
		expect(output).toContain('{"ok":false,"error":"SyntaxError"}');
	});

	// With an `expect` set, passing on the base is the plain problem it always
	// was and the message should not start guessing.
	it("keeps the plain message when `expect` was given", async () => {
		const passesOnBase: OracleVerdict = {
			passed: true,
			exitCode: 0,
			output: "ok",
			timedOut: false,
		};
		const { run } = toolWith(
			async () => ({ approved: true }),
			adopter(undefined, passesOnBase),
		);

		const output = await run({
			kind: "command",
			command: "node run_game.js game.html",
			expect: "ok",
			reason: "it runs the game",
		});

		expect(output).toContain("cannot tell a fix from no fix");
		expect(output).not.toContain("exit code is the whole verdict");
	});

	// "The command found a problem" and "the command is itself broken" both
	// arrive as ran-and-failed, and one of them is not a check. Measured: a run
	// froze `node -e "try{...}catch(e){...}&&node run_game.js ..."`, which is
	// not JavaScript, so node died on its own argument identically whatever the
	// workspace held -- and then failed every attempt for six transactions.
	describe("a check that is itself broken", () => {
		const nodeSyntaxError: OracleVerdict = {
			passed: false,
			exitCode: 1,
			output: [
				"[eval]:1",
				"try{readFileSync('x')}catch(e){process.exit(1)}&&node run_game.js",
				"                                               ^^",
				"",
				"SyntaxError: Unexpected token '&&'",
			].join("\n"),
			timedOut: false,
		};

		it("refuses a program the interpreter could not parse", async () => {
			const { run, controller } = toolWith(
				async () => ({ approved: true }),
				adopter(undefined, nodeSyntaxError),
			);

			const output = await run({
				kind: "command",
				command: 'node -e "try{}catch(e){}&&node run_game.js"',
				reason: "it parses and runs the game",
			});

			expect(output).toContain("did not run");
			expect(output).toContain("fail on any files at all");
			expect(controller.adopted).toHaveLength(0);
		});

		// 127 is the shell saying it never found the program. Same class as a
		// spawn that failed, and it used to read as a check that found a bug.
		it("refuses a command that was never found", async () => {
			const notFound: OracleVerdict = {
				passed: false,
				exitCode: 127,
				output: "sh: 1: pytest: not found",
				timedOut: false,
			};
			const { run, controller } = toolWith(
				async () => ({ approved: true }),
				adopter(undefined, notFound),
			);

			const output = await run({
				kind: "command",
				command: "pytest -q",
				reason: "the suite passes",
			});

			expect(output).toContain("not found on this machine");
			expect(controller.adopted).toHaveLength(0);
		});

		// The check reporting a SyntaxError *in a workspace file* is the check
		// working. Node prints that file's path where `[eval]` would be, which
		// is the whole reason the signature matches on the location.
		it("adopts a check that found a syntax error in the code", async () => {
			const foundIt: OracleVerdict = {
				passed: false,
				exitCode: 1,
				output: [
					"/work/game.js:12",
					"  function draw( {",
					"                 ^",
					"",
					"SyntaxError: Unexpected token '{'",
				].join("\n"),
				timedOut: false,
			};
			const { run, controller } = toolWith(
				async () => ({ approved: true }),
				adopter(undefined, foundIt),
			);

			const output = await run({
				kind: "command",
				command: "node --check game.js",
				reason: "the file parses",
			});

			expect(output).toContain("Approved");
			expect(controller.adopted).toHaveLength(1);
		});
	});

	// The one crack in the freeze, and it brings its own round: the measured
	// run that needed it had a single proposal left by luck, and a user who
	// declines once would have closed it.
	describe("replacing a check that has never passed", () => {
		/** A controller that freezes on adoption and can be reopened once. */
		function reconsiderable() {
			const adopted: Oracle[] = [];
			const tried: Oracle[] = [];
			let reopened = false;
			return {
				adopted,
				tried,
				reopen(): void {
					reopened = true;
				},
				async judgeAgainstBase(oracle: Oracle) {
					tried.push(oracle);
					return FAILS_ON_BASE;
				},
				get canAdoptOracle() {
					return adopted.length === 0 || reopened;
				},
				get checkIsUnderReconsideration() {
					return reopened;
				},
				adoptOracle(oracle: Oracle) {
					adopted.push(oracle);
					reopened = false;
				},
			};
		}

		it("grants a round the proposal budget had already spent", async () => {
			const controller = reconsiderable();
			let approves = false;
			const { run } = toolWith(
				async () => (approves ? { approved: true } : { approved: false }),
				controller,
			);

			// Both ordinary rounds gone, and nothing adopted.
			await run({ kind: "page", path: "a.html", reason: "one" });
			await run({ kind: "page", path: "b.html", reason: "two" });
			expect(
				await run({ kind: "page", path: "c.html", reason: "three" }),
			).toContain("Do not propose again");

			// Nothing was ever adopted, so this is the budget being reopened by
			// reconsideration rather than by a fresh check.
			controller.reopen();
			approves = true;
			const output = await run({
				kind: "page",
				path: "d.html",
				reason: "the old one never passed",
			});

			expect(output).toContain("Approved");
			expect(controller.adopted).toHaveLength(1);
		});

		it("refuses the same check offered back unchanged", async () => {
			const controller = reconsiderable();
			const { run } = toolWith(async () => ({ approved: true }), controller);
			await run({ kind: "page", path: "game.html", reason: "the page" });
			expect(controller.adopted).toHaveLength(1);

			controller.reopen();
			const output = await run({
				kind: "page",
				path: "game.html",
				reason: "the page, again",
			});

			expect(output).toContain("the check this run already has");
			expect(controller.adopted).toHaveLength(1);
		});

		// Without reconsideration open, the freeze says what it always said.
		it("still refuses a second check while frozen", async () => {
			const controller = reconsiderable();
			const { run } = toolWith(async () => ({ approved: true }), controller);
			await run({ kind: "page", path: "game.html", reason: "the page" });

			const output = await run({
				kind: "page",
				path: "other.html",
				reason: "something easier",
			});

			expect(output).toContain("frozen for the rest of the run");
			expect(controller.adopted).toHaveLength(1);
		});
	});

	// The user is shown the exact thing that will run, because that is what
	// they are approving.
	it("shows the user the command as written", async () => {
		const approve = vi.fn(async (_proposal: unknown, _described: string) => ({
			approved: true as const,
		}));
		const { run } = toolWith(approve);

		await run({
			kind: "command",
			command: "node run.js | tee out.log",
			reason: "it prints the verdict",
		});

		expect(approve.mock.calls[0][1]).toContain("node run.js | tee out.log");
	});

	it("adopts nothing when the user declines, and says what they asked for", async () => {
		const { run, controller } = toolWith(async () => ({
			approved: false,
			feedback: "use the vitest suite instead",
		}));

		const output = await run(PAGE);

		expect(controller.adopted).toHaveLength(0);
		expect(output).toContain("use the vitest suite instead");
		expect(output).toContain("Propose one more");
	});

	// Bounded, then the protocol moves on. A model that keeps asking is worse
	// than no check at all: it spends the run negotiating.
	it("stops asking after two declined rounds", async () => {
		const { run } = toolWith(async () => ({ approved: false }));

		await run(PAGE);
		const second = await run(PAGE);
		const third = await run(PAGE);

		expect(second).toContain("last round");
		expect(third).toContain("Do not propose again");
	});

	// A malformed proposal never reached the user, so it cannot have spent one
	// of their rounds.
	it("does not spend a round on a proposal it could not read", async () => {
		const approve = vi.fn(async (_proposal: unknown, _described: string) => ({
			approved: false as const,
		}));
		const { run } = toolWith(approve);

		const output = await run({ kind: "page", reason: "no path given" });

		expect(approve).not.toHaveBeenCalled();
		expect(output).toContain("`path` is missing");
	});

	it("refuses to propose anything once the run has a check", async () => {
		const existing: Oracle = {
			label: "npm test",
			command: "npm",
			args: ["test"],
			cwd: ROOT,
			reason: "package.json",
		};
		const { run } = toolWith(
			async () => ({ approved: true }),
			adopter(existing),
		);

		expect(await run(PAGE)).toContain("frozen for the rest of the run");
	});

	// A host with nobody to ask must not hang or throw: the run continues on
	// the weaker verdict, which is what it would have had anyway.
	it("carries on when the user cannot be asked", async () => {
		const { run, controller } = toolWith(async () => {
			throw new Error("no window");
		});

		const output = await run(PAGE);

		expect(controller.adopted).toHaveLength(0);
		expect(output).toContain("continues without one");
	});

	// The property that separates this from theatre: a check that already
	// passes on the unmodified files would have kept the transaction before a
	// line was edited.
	it("refuses a check that already passes before the change", async () => {
		const controller = adopter(undefined, {
			passed: true,
			exitCode: 0,
			output: "ok",
			timedOut: false,
		});
		const { run } = toolWith(async () => ({ approved: true }), controller);

		const output = await run(PAGE);

		expect(controller.adopted).toHaveLength(0);
		expect(output).toContain("already passes");
		expect(output).toContain("Propose one more");
	});

	// "Not installed" and "found a problem" arrive here looking the same, and
	// only one of them is the check working.
	it("refuses a check that could not be run at all", async () => {
		const controller = adopter(undefined, {
			passed: false,
			exitCode: null,
			output: "spawn pytest ENOENT",
			timedOut: false,
		});
		const { run } = toolWith(async () => ({ approved: true }), controller);

		const output = await run({
			kind: "command",
			command: "pytest",
			reason: "the suite covers it",
		});

		expect(controller.adopted).toHaveLength(0);
		expect(output).toContain("could not be run here");
	});

	it("tries the candidate before taking it on, never after", async () => {
		const controller = adopter();
		const { run } = toolWith(async () => ({ approved: true }), controller);

		await run(PAGE);

		expect(controller.tried).toHaveLength(1);
		expect(controller.adopted).toHaveLength(1);
	});

	// The user approved it. A validation that could not be performed is a
	// weaker guarantee, not a reason to refuse what they asked for.
	it("takes the check on anyway when it cannot be tried", async () => {
		const controller = {
			...adopter(),
			judgeAgainstBase: async () => {
				throw new Error("no snapshot");
			},
		};
		const { run } = toolWith(async () => ({ approved: true }), controller);

		expect(await run(PAGE)).toContain("Approved");
		expect(controller.adopted).toHaveLength(1);
	});
});

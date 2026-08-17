import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The thing that decides whether a transaction is kept.
 *
 * The harness this protocol comes from runs its oracle from the shell and
 * reads only the exit code, deliberately: a model asked whether its own edit
 * worked answers about the edit it meant to make. Measured across the atomic
 * campaign, transactions that reported success and failed the oracle were
 * routine — the model had fixed the error it was looking at and not the one
 * the program still had.
 *
 * So the verdict is a command's exit status wherever a command can be found,
 * and the model's own word only where none can.
 */
export interface Oracle {
	/** Shown to the model, and to the user, as what will judge the change. */
	label: string;
	/** The executable and its arguments. Never a shell string. */
	command: string;
	args: string[];
	/** Where it runs. */
	cwd: string;
	/** Why this one was chosen, for the log. */
	reason: string;
	/**
	 * A pattern the output must match, on top of exiting zero.
	 *
	 * For the large class of checks that report their verdict and exit zero
	 * anyway. The harness's own oracle is one: `run_game.js` prints
	 * `{"ok":false,"error":"…"}` and exits 0 whether the game runs or not, so a
	 * protocol reading only the exit status would keep every transaction it was
	 * ever pointed at. Read as a regular expression against stdout and stderr
	 * together.
	 */
	expect?: string;
}

export interface OracleVerdict {
	passed: boolean;
	/** Exit status, or `null` when the oracle could not be run at all. */
	exitCode: number | null;
	/** Combined output, truncated. The record a failed transaction carries. */
	output: string;
	/** Set when the oracle exceeded its budget: an unfinished run is not a pass. */
	timedOut: boolean;
	/**
	 * Set when the command succeeded but its output did not say the change did.
	 * A different failure from a non-zero exit and reported as one, because "it
	 * ran and reported a problem" reads nothing like "it crashed".
	 */
	unmatched?: boolean;
}

/** Longest an oracle may run before the transaction is judged on nothing. */
export const DEFAULT_ORACLE_TIMEOUT_MS = 120_000;

/** Most output kept from an oracle, which a failed transaction carries forward. */
const MAX_ORACLE_OUTPUT = 8_000;

/**
 * Directories a workspace scan must not descend into.
 *
 * Not a nicety: a snapshot or a scan that walks `node_modules` on a real
 * project reads hundreds of thousands of files and the feature becomes slower
 * than the change it is protecting.
 */
export const SCAN_IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	".venv",
	"venv",
	"__pycache__",
	".next",
	".turbo",
	".cache",
	"coverage",
]);

async function readJson(filePath: string): Promise<unknown> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * The package manager a JavaScript workspace actually uses.
 *
 * Read off the lockfile rather than assumed, because running `npm test` in a
 * bun workspace installs a second lockfile as a side effect of judging an
 * edit — a change the transaction never asked for and would then roll back.
 */
async function detectNodeRunner(root: string): Promise<string> {
	if (await exists(path.join(root, "bun.lockb"))) return "bun";
	if (await exists(path.join(root, "bun.lock"))) return "bun";
	if (await exists(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
	if (await exists(path.join(root, "yarn.lock"))) return "yarn";
	return "npm";
}

/**
 * Scripts worth judging a change by, cheapest and most decisive first.
 *
 * A typecheck answers "is this still valid" in seconds and cannot pass a
 * broken file; a test suite answers a better question and costs more; a build
 * is the fallback. Ordering them this way is what keeps a transaction's
 * verdict affordable enough to run on every one.
 */
const SCRIPT_PREFERENCE = [
	"typecheck",
	"check-types",
	"tsc",
	"test",
	"build",
	"lint",
] as const;

/**
 * Where an oracle may come from, strongest claim first.
 *
 * `manual` is the one the user writes for the task in front of them, and it is
 * the answer to a failure mode the rest of the ladder cannot reach: an oracle
 * chosen by detection judges whether the workspace still holds together, not
 * whether the thing the user asked for now works. A model can leave a
 * typecheck green and the feature broken, and detection would keep that
 * transaction.
 */
export interface OracleSources {
	/** Written by the user for this task. Beats everything below it. */
	manual?: string;
	/** A default the user set once, in settings, for every task. */
	explicit?: string;
	/**
	 * What the output must say for a user-named check to count as passed.
	 *
	 * Applies to a named command only. A check found by looking at the
	 * workspace is a test runner or a compiler, and those already answer with
	 * their exit status; a command the user wrote may be neither.
	 */
	expect?: string;
}

function shellOracle(
	line: string,
	cwd: string,
	reason: string,
	expect?: string,
): Oracle {
	// Taken as written, through the shell, because a user who names an oracle
	// means that exact line — pipes, environment and all.
	return {
		label: line,
		command: process.platform === "win32" ? "cmd" : "sh",
		args: process.platform === "win32" ? ["/c", line] : ["-c", line],
		cwd,
		reason,
		...(expect?.trim() ? { expect: expect.trim() } : {}),
	};
}

/**
 * Find something in this workspace that can say whether a change is good.
 *
 * Returns `undefined` when nothing does — a documentation edit, a config file,
 * a repository with no runnable anything. That is not a failure: it is the
 * case where the verdict falls to the model, and the caller says so out loud
 * rather than pretending a check happened.
 */
export async function discoverOracle(
	workspaceRoot: string,
	options: OracleSources = {},
): Promise<Oracle | undefined> {
	// A command the user wrote for this task beats one they set once for every
	// task, and both beat anything found by looking at the tree. Detection
	// answers "does this workspace still build"; the user's line answers the
	// question they actually care about, which is often narrower and is
	// sometimes the only thing that can tell success from a plausible edit.
	const manual = options.manual?.trim();
	if (manual) {
		return shellOracle(
			manual,
			workspaceRoot,
			"named for this task",
			options.expect,
		);
	}
	const configured = options.explicit?.trim();
	if (configured) {
		return shellOracle(
			configured,
			workspaceRoot,
			"named in settings",
			options.expect,
		);
	}

	const pkg = (await readJson(path.join(workspaceRoot, "package.json"))) as
		| { scripts?: Record<string, string> }
		| undefined;
	if (pkg?.scripts) {
		const runner = await detectNodeRunner(workspaceRoot);
		for (const name of SCRIPT_PREFERENCE) {
			if (typeof pkg.scripts[name] === "string") {
				return {
					label: `${runner} run ${name}`,
					command: runner,
					args: ["run", name],
					cwd: workspaceRoot,
					reason: `package.json defines a \`${name}\` script`,
				};
			}
		}
	}

	if (await exists(path.join(workspaceRoot, "Cargo.toml"))) {
		return {
			label: "cargo test",
			command: "cargo",
			args: ["test", "--quiet"],
			cwd: workspaceRoot,
			reason: "Cargo.toml at the workspace root",
		};
	}

	if (await exists(path.join(workspaceRoot, "go.mod"))) {
		return {
			label: "go test ./...",
			command: "go",
			args: ["test", "./..."],
			cwd: workspaceRoot,
			reason: "go.mod at the workspace root",
		};
	}

	for (const marker of ["pyproject.toml", "pytest.ini", "tox.ini"]) {
		if (await exists(path.join(workspaceRoot, marker))) {
			return {
				label: "pytest",
				command: "python3",
				args: ["-m", "pytest", "-q"],
				cwd: workspaceRoot,
				reason: `${marker} at the workspace root`,
			};
		}
	}

	if (await exists(path.join(workspaceRoot, "tsconfig.json"))) {
		return {
			label: "tsc --noEmit",
			command: "npx",
			args: ["tsc", "--noEmit"],
			cwd: workspaceRoot,
			reason: "tsconfig.json at the workspace root",
		};
	}

	if (await exists(path.join(workspaceRoot, "Makefile"))) {
		const makefile = await fs
			.readFile(path.join(workspaceRoot, "Makefile"), "utf8")
			.catch(() => "");
		for (const target of ["test", "check"]) {
			if (new RegExp(`^${target}:`, "m").test(makefile)) {
				return {
					label: `make ${target}`,
					command: "make",
					args: [target],
					cwd: workspaceRoot,
					reason: `Makefile has a \`${target}\` target`,
				};
			}
		}
	}

	return undefined;
}

/**
 * Run the oracle and read its exit status.
 *
 * A non-zero exit, a signal, a timeout and a command that could not be started
 * are all failures. The last of those is the one worth naming: an oracle that
 * cannot run has judged nothing, and treating "not found" as a pass would keep
 * every transaction it was pointed at.
 */
export async function runOracle(
	oracle: Oracle,
	options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<OracleVerdict> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_ORACLE_TIMEOUT_MS;
	try {
		const { stdout, stderr } = await run(oracle.command, oracle.args, {
			cwd: oracle.cwd,
			timeout: timeoutMs,
			maxBuffer: 16 * 1024 * 1024,
			env: options.env ?? process.env,
		});
		const combined = `${stdout}${stderr}`;
		const matched = outputSaysItPassed(oracle, combined);
		return {
			passed: matched,
			exitCode: 0,
			output: matched
				? truncate(combined)
				: `${truncate(combined)}\n\nThe check ran and finished cleanly, but its output does not match /${oracle.expect}/, which is what this task counts as working.`,
			timedOut: false,
			...(matched ? {} : { unmatched: true }),
		};
	} catch (error) {
		const failure = error as Omit<NodeJS.ErrnoException, "code"> & {
			code?: number | string;
			killed?: boolean;
			signal?: string;
			stdout?: string;
			stderr?: string;
		};
		const timedOut = failure.killed === true || failure.signal === "SIGTERM";
		const started = typeof failure.code === "number";
		const output = truncate(
			`${failure.stdout ?? ""}${failure.stderr ?? ""}` ||
				(failure.message ?? ""),
		);
		return {
			passed: false,
			exitCode: started ? (failure.code as number) : null,
			output: timedOut
				? `${output}\n\nThe oracle was still running after ${Math.round(timeoutMs / 1000)}s and was stopped. An unfinished check is not a pass.`
				: output,
			timedOut,
		};
	}
}

/**
 * Whether a clean exit is enough, or the output has to say so as well.
 *
 * A pattern that will not compile fails the check rather than being ignored.
 * The alternative is worse in exactly the case it matters: a typo in the
 * pattern would silently return the protocol to judging on exit status, which
 * for this class of check means keeping everything.
 */
function outputSaysItPassed(oracle: Oracle, output: string): boolean {
	if (!oracle.expect) {
		return true;
	}
	try {
		return new RegExp(oracle.expect).test(output);
	} catch {
		return false;
	}
}

function truncate(output: string): string {
	const trimmed = output.trimEnd();
	return trimmed.length > MAX_ORACLE_OUTPUT
		? `${trimmed.slice(0, MAX_ORACLE_OUTPUT)}\n… (${trimmed.length - MAX_ORACLE_OUTPUT} more characters)`
		: trimmed;
}

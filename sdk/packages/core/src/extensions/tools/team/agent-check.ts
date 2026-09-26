/**
 * The lead's check on a delegated agent: a command and what its output must
 * say, run when the agent says it is done.
 *
 * The same thing the change protocol's approved check is, with the same
 * runner (`runtime/atomic/oracle.ts`) and the same semantics: it runs once at
 * each completion attempt; on a fail the agent is shown the output and goes on
 * working, within its iteration budget; on a pass -- or when the budget is
 * spent -- the verdict goes into the agent's report. What an agent's own "it
 * works now" is worth was measured across the atomic campaign: routinely
 * nothing, because a model reports on the edit it meant to make.
 *
 * Where it runs is the part that differs. A delegated agent works on a private
 * overlay of the workspace, so the lead's files do not hold its work, and a
 * check run on them judges nothing the agent did. The check runs where the
 * agent's own shell runs: under the sandbox launcher (`wrapSpawn`), which maps
 * the workspace onto the agent's overlay. Where there is no launcher -- no
 * sandbox on this platform, or "Agents can run commands" off -- the check is
 * NOT run on the host instead: every delegated command runs sandboxed, and an
 * unsandboxed one would both read the wrong files and be free to write the
 * real ones. The report says "not run: no command sandbox".
 */

import { z } from "zod";
import {
	DEFAULT_ORACLE_TIMEOUT_MS,
	type OracleSpawnWrapper,
	type OracleVerdict,
	runOracle,
	shellOracle,
} from "../../../runtime/atomic/oracle";

/** What the lead writes: a command, a pattern, and which way it must go. */
export interface AgentCheck {
	command: string;
	/** A regular expression, matched against stdout and stderr together. */
	expect: string;
	/** `match` (default): the output must match. `not_match`: it must not. */
	must?: "match" | "not_match";
}

/** The check as a tool field; see {@link readAgentCheck} for what is tolerated. */
export const AgentCheckSchema = z
	.object({
		command: z
			.string()
			.describe(
				"A shell command, run in the agent's own copy of the workspace.",
			),
		expect: z
			.string()
			.describe(
				"A regular expression the command's output (stdout+stderr) is matched against.",
			),
		must: z
			.enum(["match", "not_match"])
			.optional()
			.describe(
				'"match" (default): the output must match `expect`. "not_match": it must not. The command must exit 0 either way.',
			),
	})
	.describe(
		"An oracle for the agent: run when it says it is done. On a fail it is shown the output and keeps working (within its iterations); the verdict is in its report.",
	);

/** How the check came out, in the agent's report. */
export interface AgentOracleResult {
	status: "pass" | "fail" | "not_run";
	command: string;
	expect: string;
	must: "match" | "not_match";
	/** Exit status of the last run; `null` when it could not start or was not run. */
	exitCode: number | null;
	/** The end of the last run's output, bounded. */
	output: string;
	/** How many completion attempts it judged. */
	runs: number;
	/** Why it was not run, or what stopped it being re-run. */
	reason?: string;
}

/** Most of a check's output kept for the report and the agent. */
export const AGENT_CHECK_OUTPUT_TAIL_CHARS = 1_500;

/**
 * Identical failing verdicts in a row after which the check stops holding the
 * agent back.
 *
 * Needed because the default iteration cap is none: a check that cannot pass
 * (a pattern the fixed program never prints -- measured on the change
 * protocol's auto-approved checks) would otherwise keep an uncapped agent at
 * it forever. A check re-run over output that has not moved cannot say
 * anything the run before it did not, which is the change protocol's own
 * stalled-check rule. The agent is let finish; the verdict stays `fail`.
 */
export const AGENT_CHECK_MAX_IDENTICAL_FAILS = 3;

/** The reason a check is not run when the agent has no sandboxed shell. */
export const AGENT_CHECK_NO_SANDBOX = "no command sandbox";

const MUST_ALIASES: Record<string, "match" | "not_match"> = {
	match: "match",
	matches: "match",
	must_match: "match",
	not_match: "not_match",
	notmatch: "not_match",
	not_matches: "not_match",
	no_match: "not_match",
	must_not_match: "not_match",
	nomatch: "not_match",
	not: "not_match",
};

function firstString(
	record: Record<string, unknown>,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) {
			return value;
		}
	}
	return undefined;
}

/**
 * The check as the lead wrote it, read tolerantly, or `undefined` for none.
 *
 * Models send tool arguments in more shapes than the schema names: the object
 * as JSON text, `cmd` for `command`, `pattern` or `regex` for `expect`, a
 * pattern wrapped in slashes, `must: "not-match"`. Each of those has only one
 * reading, so it is taken. What cannot be read -- no command, or a pattern
 * that will not compile -- is refused with the reason, at spawn time: a check
 * that fails every run for a typo would hold the agent to work it can never
 * finish.
 */
export function readAgentCheck(raw: unknown): AgentCheck | undefined {
	if (raw === undefined || raw === null || raw === "") {
		return undefined;
	}
	let value = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			throw new Error(
				`\`check\` arrived as text that is not an object: send {"command": "...", "expect": "<regex>", "must": "match" | "not_match"}.`,
			);
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(
			'`check` must be an object: {"command": "...", "expect": "<regex>", "must": "match" | "not_match"}.',
		);
	}
	const record = value as Record<string, unknown>;
	const command = firstString(record, ["command", "cmd", "run", "shell"]);
	if (!command) {
		throw new Error("`check` has no `command`: the shell line to run.");
	}
	let expect =
		firstString(record, ["expect", "pattern", "regex", "expected", "match"]) ??
		"";
	const slashed = /^\/([\s\S]*)\/$/.exec(expect.trim());
	if (slashed?.[1] !== undefined) {
		expect = slashed[1];
	}
	try {
		new RegExp(expect);
	} catch (error) {
		throw new Error(
			`\`check.expect\` is not a valid regular expression (${
				error instanceof Error ? error.message : String(error)
			}).`,
		);
	}
	const mustRaw = firstString(record, ["must", "mode"]);
	const must = mustRaw
		? MUST_ALIASES[
				mustRaw
					.trim()
					.toLowerCase()
					.replace(/[\s-]+/g, "_")
			]
		: undefined;
	if (mustRaw && !must) {
		throw new Error(
			`\`check.must\` is "${mustRaw}"; it is "match" or "not_match".`,
		);
	}
	return {
		command: command.trim(),
		expect,
		...(must && must !== "match" ? { must } : {}),
	};
}

function describePattern(check: AgentCheck): string {
	if (!check.expect) {
		return "it must exit 0";
	}
	return check.must === "not_match"
		? `it must exit 0 and its output must NOT match the regular expression /${check.expect}/`
		: `it must exit 0 and its output must match the regular expression /${check.expect}/`;
}

/**
 * What the agent is told up front, at the end of its task, so it can run the
 * check itself before it says it is done.
 */
export function describeAgentCheck(check: AgentCheck, canRun: boolean): string {
	if (!canRun) {
		return [
			"# Your check",
			"",
			`The lead set a check for this task: \`${check.command}\` -- ${describePattern(check)}.`,
			"There is no command sandbox for you here, so it will not be run for you. Say in your answer whether you expect it to pass, and why.",
		].join("\n");
	}
	return [
		"# Your check",
		"",
		`When you say you are done, this command is run on your copy of the workspace: \`${check.command}\` -- ${describePattern(check)}.`,
		"If it fails you are shown its output and must keep working. Run it yourself with run_commands before you finish.",
	].join("\n");
}

function tail(text: string, max = AGENT_CHECK_OUTPUT_TAIL_CHARS): string {
	const trimmed = text.trimEnd();
	return trimmed.length > max ? `…${trimmed.slice(-(max - 1))}` : trimmed;
}

export interface DelegatedAgentCheck {
	readonly check: AgentCheck;
	/** Whether it will actually be run: a sandboxed shell to run it in. */
	readonly canRun: boolean;
	/** For the agent's `completionPolicy.onCompletionAttempt`. */
	onCompletionAttempt(context: {
		text?: string;
		forced?: boolean;
	}): Promise<string | undefined>;
	/** The verdict so far; `undefined` before any completion attempt. */
	result(): AgentOracleResult | undefined;
	/**
	 * Stop judging: the run is over, and anything that follows on the same
	 * conversation -- the summary asked for the lead -- is not a completion
	 * attempt of the task.
	 */
	close(): void;
}

export interface CreateDelegatedAgentCheckOptions {
	check: AgentCheck;
	/** The workspace root, which the launcher maps onto the agent's overlay. */
	cwd: string;
	/**
	 * The agent's sandboxed shell launcher. Absent means no command sandbox,
	 * and the check is reported as not run -- never run on the host instead.
	 */
	wrapSpawn?: OracleSpawnWrapper;
	timeoutMs?: number;
	/** Test seam: the runner. The change protocol's by default. */
	run?: typeof runOracle;
}

/**
 * A check bound to one agent: its launcher, its counters, its verdict.
 */
export function createDelegatedAgentCheck(
	options: CreateDelegatedAgentCheckOptions,
): DelegatedAgentCheck {
	const { check } = options;
	const run = options.run ?? runOracle;
	const canRun = options.wrapSpawn !== undefined;
	const must = check.must ?? "match";
	let latest: AgentOracleResult | undefined;
	let runs = 0;
	let closed = false;
	let lastFailOutput: string | undefined;
	let identicalFails = 0;

	const record = (
		verdict: OracleVerdict,
		reason?: string,
	): AgentOracleResult => {
		latest = {
			status: verdict.passed ? "pass" : "fail",
			command: check.command,
			expect: check.expect,
			must,
			exitCode: verdict.exitCode,
			output: tail(verdict.output),
			runs,
			...(reason ? { reason } : {}),
		};
		return latest;
	};

	return {
		check,
		canRun,
		result: () => latest,
		close: () => {
			closed = true;
		},
		async onCompletionAttempt() {
			if (closed) {
				return undefined;
			}
			if (!canRun) {
				latest = {
					status: "not_run",
					command: check.command,
					expect: check.expect,
					must,
					exitCode: null,
					output: "",
					runs,
					reason: AGENT_CHECK_NO_SANDBOX,
				};
				return undefined;
			}
			runs += 1;
			const oracle = shellOracle(
				check.command,
				options.cwd,
				"the lead's check for this agent",
				check.expect,
			);
			const verdict = await run(
				{ ...oracle, ...(must === "not_match" ? { must } : {}) },
				{
					timeoutMs: options.timeoutMs ?? DEFAULT_ORACLE_TIMEOUT_MS,
					...(options.wrapSpawn ? { wrapSpawn: options.wrapSpawn } : {}),
				},
			);
			if (verdict.passed) {
				lastFailOutput = undefined;
				identicalFails = 0;
				record(verdict);
				return undefined;
			}
			identicalFails =
				verdict.output === lastFailOutput ? identicalFails + 1 : 1;
			lastFailOutput = verdict.output;
			if (identicalFails >= AGENT_CHECK_MAX_IDENTICAL_FAILS) {
				// Nothing moved between the last runs: let it finish, failed.
				record(
					verdict,
					`the same failing output ${identicalFails} times in a row; the agent was let finish`,
				);
				return undefined;
			}
			const result = record(verdict);
			const why =
				verdict.exitCode === null
					? verdict.timedOut
						? "did not finish in time"
						: "could not be started"
					: verdict.unmatched
						? must === "not_match"
							? `exited 0, but its output matches /${check.expect}/`
							: `exited 0, but its output does not match /${check.expect}/`
						: `exited ${verdict.exitCode}`;
			return [
				`Your check did not pass: \`${check.command}\` ${why}. You are not done.`,
				"Its output (end):",
				"```",
				result.output,
				"```",
				`Fix what it reports and finish again; the check runs each time you finish (${describePattern(check)}).`,
			].join("\n");
		},
	};
}

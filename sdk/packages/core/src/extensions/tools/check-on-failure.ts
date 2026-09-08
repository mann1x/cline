/**
 * When a command fails, ask the checker about the file it blamed.
 *
 * The two halves of a diagnosis sit in two tools and the model has to think of
 * joining them. Measured over four transactions, it did not: given `run_commands`
 * output that named a file and a line, it wrote its own analyser — `find_error.js`,
 * then `diagnose.mjs`, `diagnose2.mjs`, `diagnose3.mjs` — twenty-two editor calls
 * across three scratch scripts and not one call to `check_file`. The transaction
 * that instead read the checker's report fixed the file in one.
 *
 * Wording did not close that gap, so the join is made here. It is a wrapper
 * around the shell tool that calls the host's own checker on the file the
 * failure names — in the output where the output names one, and otherwise on
 * the command line itself, which on the measured transaction was 95 commands
 * out of 96 — and appends the answer to the same result. Nothing about it is
 * language-specific: the paths are extracted by shape, and the checker is
 * whichever one the host installed — VS Code's language servers know Python and
 * Go, the CLI's built-in knows JavaScript and brackets, and both are asked the
 * same way.
 */

import type { AgentTool, AgentToolContext } from "@cline/shared";
import {
	findCommandFileTargets,
	findErrorLocations,
	looksLikeFailure,
} from "./error-locations";
import type { ToolOperationResult } from "./types";

/** Files checked for one call, however many failures it holds. */
const MAX_CHECKED_FILES = 3;

/** The heading the appended report arrives under. */
const ATTACHMENT_HEADING =
	"--- the checker, run for you on the file(s) this command names. This is the measurement, not a second opinion: where it disagrees with a count of your own, it is the count that is wrong. ---";

/**
 * What a result looks like once the shell tool is done with it.
 *
 * Typed structurally rather than imported as a class, because a host may
 * substitute its own shell tool — VS Code ships a terminal-aware one — and this
 * has to survive anything shaped like a result list.
 */
function asResults(value: unknown): ToolOperationResult[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const results = value.filter(
		(entry): entry is ToolOperationResult =>
			typeof entry === "object" && entry !== null && "query" in entry,
	);
	return results.length === value.length ? results : undefined;
}

/** Everything a result said, whichever field it said it in. */
function textOf(result: ToolOperationResult): string {
	const body = typeof result.result === "string" ? result.result : "";
	return result.error ? `${body}\n${result.error}` : body;
}

export interface CheckOnFailureOptions {
	/** Where relative paths in command output resolve from. */
	cwd: string;
	/** The checker to ask. Its report is appended verbatim. */
	checker: Pick<AgentTool<{ paths: string[] }, unknown>, "execute">;
}

/**
 * Wrap a shell tool so failing commands come back with the checker's verdict.
 *
 * The wrapper is transparent on success and on output that names no workspace
 * file, which is most of them: the extraction has to resolve a real path inside
 * the workspace before anything is run.
 */
export function withCheckOnFailure<TInput>(
	shell: AgentTool<TInput, unknown>,
	options: CheckOnFailureOptions,
): AgentTool<TInput, unknown> {
	const wrapped: AgentTool<TInput, unknown> = {
		...shell,
		execute: async (input: TInput, context: AgentToolContext) => {
			const raw = await shell.execute(input, context);
			const results = asResults(raw);
			if (!results) {
				return raw;
			}

			const paths: string[] = [];
			const seen = new Set<string>();
			const take = (candidate: string) => {
				if (!seen.has(candidate)) {
					seen.add(candidate);
					paths.push(candidate);
				}
			};
			for (const result of results) {
				const text = textOf(result);
				if (!looksLikeFailure(text, result.success === false)) {
					continue;
				}
				const blamed = findErrorLocations(text, options.cwd);
				for (const location of blamed) {
					take(location.path);
				}
				// Output that blames a file is the good case and not the common
				// one. A wrapper script, a test runner or a harness that catches
				// the error and prints its own summary leaves nothing to match —
				// measured, 95 of 96 commands in one transaction — and the file
				// is then only ever named on the command line that ran it.
				if (blamed.length === 0) {
					for (const target of findCommandFileTargets(
						result.query ?? "",
						options.cwd,
					)) {
						take(target);
					}
				}
			}
			if (paths.length === 0) {
				return raw;
			}

			let report: string;
			try {
				const answer = await options.checker.execute(
					// Capped here as well as per result: three failing commands
					// naming three files each is a build log, and the model is
					// owed an answer about the failure it is looking at, not a
					// survey.
					{ paths: paths.slice(0, MAX_CHECKED_FILES) },
					context,
				);
				report = typeof answer === "string" ? answer : String(answer);
			} catch {
				// The checker is an addition to an answer the model already has.
				// A failure inside it must not take the command's own output with
				// it — that output is the thing the model asked for.
				return raw;
			}
			if (report.trim() === "") {
				return raw;
			}

			// Appended to the last failing result rather than to all of them, so
			// a three-command call carries one copy. Its `query` is what the
			// model reads as "which command this belongs to", and the last
			// failure is the one it is looking at.
			const attachTo =
				[...results]
					.reverse()
					.find((result) =>
						looksLikeFailure(textOf(result), result.success === false),
					) ?? results[results.length - 1];
			if (!attachTo) {
				return raw;
			}
			const body =
				typeof attachTo.result === "string"
					? attachTo.result
					: attachTo.result === undefined || attachTo.result === null
						? ""
						: String(attachTo.result);
			attachTo.result = `${body}\n\n${ATTACHMENT_HEADING}\n${report}`;
			return results;
		},
	};
	return wrapped;
}

/**
 * Find the shell tool and the checker in an assembled toolset and join them.
 *
 * By name on both sides: a host that swapped in its own `run_commands` or its
 * own `check_file` gets the same wiring as the builtins, and a host missing
 * either gets its list back untouched.
 */
export function joinCheckerToShell<TTool extends AgentTool<never, unknown>>(
	tools: readonly TTool[],
	options: { cwd: string; shellName: string; checkerName: string },
): TTool[] {
	const checker = tools.find((tool) => tool.name === options.checkerName);
	const shell = tools.find((tool) => tool.name === options.shellName);
	if (!checker || !shell) {
		return [...tools];
	}
	const joined = withCheckOnFailure(shell, {
		cwd: options.cwd,
		checker: checker as unknown as Pick<
			AgentTool<{ paths: string[] }, unknown>,
			"execute"
		>,
	}) as TTool;
	return tools.map((tool) => (tool === shell ? joined : tool));
}

/**
 * Deciding gates: whether what a task waits on has happened (plan section 6).
 *
 * | gate | checked |
 * |---|---|
 * | `run:<id>` | as the run ends (the host reports it) |
 * | `command:<id>` | as the command exits (the host reports it) |
 * | `human:<what>` | as the person answers a question naming it, or "Resolve" in the panel |
 * | `commit:<sha>@<branch>` | before each request: `git merge-base --is-ancestor`, cheap |
 * | `timer:<ISO time>` | before each request |
 * | `gh-pr:` / `gh-run:` | on `task_view` only, never on the request path: it is a network call |
 */

import { execFile, execFileSync } from "node:child_process";
import { parseGate, type Task, type TaskGate } from "./model";
import type { GateDecision } from "./store";

const DURATION =
	/^\+?\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs|hours?|d|days?)$/i;
const UNIT_MS: Record<string, number> = {
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

/**
 * A timer written as a duration (`timer:+30m`, `timer:2h`) becomes the time
 * it ends, so the log holds the same moment whenever it is replayed. Any
 * other gate is returned as it is.
 */
export function absoluteGate(spec: string, now: number): string {
	const parsed = parseGate(spec);
	if (parsed?.kind !== "timer") return spec;
	const match = DURATION.exec(parsed.value);
	if (!match) return spec;
	const unit = (match[2] as string)[0]?.toLowerCase() ?? "m";
	const ms = Number(match[1]) * (UNIT_MS[unit] ?? 60_000);
	return `timer:${new Date(now + ms).toISOString()}`;
}

/** A timer gate: open once its time has passed. */
export function decideTimerGate(gate: TaskGate, now: number): GateDecision {
	const parsed = parseGate(gate.spec);
	if (parsed?.kind !== "timer") return undefined;
	const at = Date.parse(parsed.value);
	if (!Number.isFinite(at))
		return { failed: `"${parsed.value}" is not a time` };
	return now >= at ? { open: true } : undefined;
}

/**
 * A commit gate: open once the branch contains the commit. A commit or
 * branch git does not know yet is left waiting: it may be pushed later.
 */
export function decideCommitGate(
	gate: TaskGate,
	cwd: string | undefined,
): GateDecision {
	const parsed = parseGate(gate.spec);
	if (parsed?.kind !== "commit" || !cwd) return undefined;
	const at = parsed.value.lastIndexOf("@");
	const sha = (at > 0 ? parsed.value.slice(0, at) : parsed.value).trim();
	const branch =
		(at > 0 ? parsed.value.slice(at + 1) : "HEAD").trim() || "HEAD";
	if (!/^[\w./-]+$/.test(sha) || !/^[\w./-]+$/.test(branch)) {
		return { failed: `"${parsed.value}" is not a commit and branch` };
	}
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", sha, branch], {
			cwd,
			stdio: "ignore",
			timeout: 3000,
		});
		return { open: true };
	} catch {
		// Exit 1: not yet. 128: unknown commit or branch, also not yet.
		return undefined;
	}
}

function runJson(
	command: string,
	args: string[],
	cwd: string | undefined,
): Promise<unknown> {
	return new Promise((resolve) => {
		execFile(
			command,
			args,
			{ cwd, timeout: 15_000, maxBuffer: 1 << 20 },
			(error, stdout) => {
				if (error) {
					resolve(undefined);
					return;
				}
				try {
					resolve(JSON.parse(String(stdout)));
				} catch {
					resolve(undefined);
				}
			},
		);
	});
}

/**
 * A GitHub gate, through the `gh` CLI: `gh-pr:owner/repo#12` opens when the
 * PR is merged and fails when it was closed without; `gh-run:owner/repo/123`
 * opens when the run succeeded and fails on any other conclusion. No `gh`,
 * or no answer, leaves it waiting.
 */
export async function decideGitHubGate(
	gate: TaskGate,
	cwd: string | undefined,
): Promise<GateDecision> {
	const parsed = parseGate(gate.spec);
	if (!parsed) return undefined;
	if (parsed.kind === "gh-pr") {
		const match = /^(?:([\w.-]+\/[\w.-]+))?#?(\d+)$/.exec(parsed.value);
		if (!match) return { failed: `"${parsed.value}" is not owner/repo#number` };
		const args = ["pr", "view", match[2] as string, "--json", "state"];
		if (match[1]) args.push("-R", match[1]);
		const answer = (await runJson("gh", args, cwd)) as
			| { state?: string }
			| undefined;
		if (answer?.state === "MERGED") return { open: true };
		if (answer?.state === "CLOSED")
			return { failed: "the PR was closed without merging" };
		return undefined;
	}
	if (parsed.kind === "gh-run") {
		const match = /^(?:([\w.-]+\/[\w.-]+)\/)?(\d+)$/.exec(parsed.value);
		if (!match) return { failed: `"${parsed.value}" is not owner/repo/run-id` };
		const args = [
			"run",
			"view",
			match[2] as string,
			"--json",
			"status,conclusion",
		];
		if (match[1]) args.push("-R", match[1]);
		const answer = (await runJson("gh", args, cwd)) as
			| { status?: string; conclusion?: string }
			| undefined;
		if (answer?.status !== "completed") return undefined;
		return answer.conclusion === "success"
			? { open: true }
			: {
					failed: `the run ended ${answer.conclusion || "without a conclusion"}`,
				};
	}
	return undefined;
}

/**
 * Which `human:` gates an answer to a question opens: those whose task id or
 * whose words the question names; when it names none and exactly one is
 * waiting, that one -- the person was asked, and there is only one thing they
 * could have been asked about.
 */
export function humanGatesAnswered(
	question: string,
	waiting: { task: Task; gate: TaskGate }[],
): { task: Task; gate: TaskGate }[] {
	const human = waiting.filter(
		(entry) => parseGate(entry.gate.spec)?.kind === "human",
	);
	if (human.length === 0) return [];
	const text = question.toLowerCase();
	const named = human.filter((entry) => {
		const idPattern = new RegExp(
			`\\b${entry.task.id.replace(/\./g, "\\.")}\\b`,
			"i",
		);
		if (idPattern.test(question)) return true;
		const what = parseGate(entry.gate.spec)?.value.toLowerCase() ?? "";
		return what.length >= 6 && text.includes(what);
	});
	if (named.length > 0) return named;
	return human.length === 1 ? human : [];
}

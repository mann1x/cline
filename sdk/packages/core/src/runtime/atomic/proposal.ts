/**
 * A check the model proposes and the user approves.
 *
 * `discoverOracle` answers "what can this workspace run", and where the answer
 * is nothing the protocol falls back to the model's own account of its work —
 * which is the weakest thing in this area and the source of every wrong
 * verdict measured so far. The model, though, has just read the code and knows
 * what would demonstrate the fix. What it cannot do is decide that its own
 * exam is fair, so the user approves it.
 *
 * Two properties hold this together, and neither is optional:
 *
 * 1. *The user approves the exact text.* A proposed command is arbitrary shell
 *    that the host will then run repeatedly and trust as a judge, so approval
 *    is a security boundary rather than a convenience. It never falls under
 *    auto-approve, and a proposal that differs by one character is a new one.
 * 2. *It is frozen once approved.* A model that may re-propose after a failed
 *    transaction will weaken the check until one passes, which is an elaborate
 *    way of producing `self-declared`. Changing it costs a user interaction.
 */

import * as path from "node:path";
import type {
	CommandOracle,
	Oracle,
	OracleVerdict,
	PageOracle,
} from "./oracle";

/** What the model asks for, before anything has agreed to it. */
export interface CheckProposal {
	/**
	 * `page` is the harness's own check and needs nothing installed; `command`
	 * is a line for the shell, which may not exist on this machine and is why
	 * a proposal is validated before it is trusted.
	 */
	kind: "page" | "command";
	/** For `page`: the file to load, relative to the workspace root. */
	path?: string;
	/** For `command`: the line to run, exactly as the user would type it. */
	command?: string;
	/** For `command`: what the output must say, on top of exiting cleanly. */
	expect?: string;
	/** Why this check answers the task. Shown to the user, who decides. */
	reason: string;
}

/** The tool the model names a check with. Here so the prompt can say it without importing the tool. */
export const PROPOSE_CHECK_TOOL_NAME = "propose_check";

/** How many rounds of proposing the model gets before the protocol moves on. */
export const MAX_CHECK_PROPOSALS = 2;

export type CheckApproval =
	| { approved: true }
	/** Declined, with what the user wants instead — the model's next round. */
	| { approved: false; feedback?: string };

/** Asks the user. Absent on a host with nobody to ask, which is not a failure. */
export type CheckApprover = (
	proposal: CheckProposal,
	described: string,
) => Promise<CheckApproval>;

/** A proposal that cannot be used, and the sentence the model is told why. */
export interface ProposalRejection {
	problem: string;
}

function fieldOf(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== ""
		? value.trim()
		: undefined;
}

/**
 * Whether a path stays inside the workspace.
 *
 * A check is run repeatedly and unattended once approved, so the file it names
 * is not somewhere to be relaxed about. `..` out of the workspace, or an
 * absolute path to somewhere else, is refused rather than normalised.
 */
function insideWorkspace(workspaceRoot: string, candidate: string): boolean {
	const resolved = path.resolve(workspaceRoot, candidate);
	const relative = path.relative(workspaceRoot, resolved);
	return (
		relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
	);
}

/**
 * Read a proposal off a tool call, or say what is wrong with it.
 *
 * Through a typed tool and validated here, never by reading the model's prose.
 * `readSelfReport` is already a phrase-matching heuristic and it is the
 * weakest thing in this protocol; a second one deciding what the check is
 * would compound it.
 */
export function readCheckProposal(
	input: unknown,
	workspaceRoot: string,
): CheckProposal | ProposalRejection {
	const raw = (input ?? {}) as Record<string, unknown>;
	const reason = fieldOf(raw.reason);
	if (!reason) {
		return {
			problem:
				"`reason` is missing. Say what this check demonstrates about the task, in one sentence — the user reads it to decide.",
		};
	}

	const kind = fieldOf(raw.kind);
	if (kind !== "page" && kind !== "command") {
		return {
			problem:
				'`kind` must be "page" (load a file and run it — needs nothing installed) or "command" (a line for the shell).',
		};
	}

	if (kind === "page") {
		const file = fieldOf(raw.path);
		if (!file) {
			return {
				problem:
					"`path` is missing. Name the file to load, relative to the workspace root.",
			};
		}
		if (!insideWorkspace(workspaceRoot, file)) {
			return {
				problem: `\`path\` must be inside the workspace. \`${file}\` is not.`,
			};
		}
		if (!/\.(html?|js|cjs)$/i.test(file)) {
			return {
				problem: `This check loads a page or a script: \`${file}\` is neither. Use \`kind: "command"\` for anything else.`,
			};
		}
		return { kind, path: file, reason };
	}

	const command = fieldOf(raw.command);
	if (!command) {
		return {
			problem: "`command` is missing. Give the exact line to run.",
		};
	}
	const expect = fieldOf(raw.expect);
	if (expect) {
		try {
			new RegExp(expect);
		} catch (error) {
			return {
				problem: `\`expect\` is not a valid regular expression: ${
					error instanceof Error ? error.message : String(error)
				}. It is matched against the output in this process, so it is a pattern and never a command.`,
			};
		}
	}
	return { kind, command, reason, ...(expect ? { expect } : {}) };
}

/**
 * The proposal as the user reads it before approving.
 *
 * Who runs it comes first, and this is not a style point. Measured on the
 * first live use: the model proposed the page check — headless, in this
 * process, no browser window and no human — and the dialog opened "Load and
 * run `manic_miner.html`", which reads as an instruction to the person
 * reading it. The model's own reason said "loading the page in a browser will
 * confirm…", and the one line saying it runs inside Cline came last. The user
 * declined it as manual work they would have to repeat every attempt. It was
 * never manual, and this now says so before anything else.
 *
 * The exact text that will run still goes on its own line, because for a
 * command that is the thing being approved.
 */
export function describeCheckProposal(proposal: CheckProposal): string {
	const lead =
		"Cline runs this itself after every attempt, start to finish. You are not asked to test anything, now or later.";
	if (proposal.kind === "page") {
		return [
			lead,
			"",
			`It loads \`${proposal.path}\` here in Cline — no browser window opens — runs its scripts, and fails if the file does not parse, throws, or never draws a frame.`,
			"",
			`Cline's reason for choosing it: ${proposal.reason}`,
		].join("\n");
	}
	return [
		lead,
		"",
		"It runs this command, unattended, and judges the change by it:",
		`    ${proposal.command}`,
		proposal.expect
			? `It has to finish cleanly AND its output has to match /${proposal.expect}/.`
			: "It has to finish cleanly.",
		"",
		`Cline's reason for choosing it: ${proposal.reason}`,
	].join("\n");
}

/** The approved proposal as the thing that judges transactions. */
export function proposalToOracle(
	proposal: CheckProposal,
	workspaceRoot: string,
): Oracle {
	if (proposal.kind === "page") {
		const page: PageOracle = {
			kind: "page",
			label: `load \`${proposal.path}\` and check that it runs`,
			path: proposal.path as string,
			cwd: workspaceRoot,
			reason: "proposed for this task and approved by you",
		};
		return page;
	}
	const line = proposal.command as string;
	// Through the shell, exactly as a user-named oracle is: a line means that
	// line, pipes and environment and all. The approval is what makes that
	// safe, which is why it can never be skipped for this kind.
	const command: CommandOracle = {
		label: line,
		command: process.platform === "win32" ? "cmd" : "sh",
		args: process.platform === "win32" ? ["/c", line] : ["-c", line],
		cwd: workspaceRoot,
		reason: "proposed for this task and approved by you",
		...(proposal.expect ? { expect: proposal.expect } : {}),
	};
	return command;
}

/** Whether two proposals are the same one, for "approved already" purposes. */
export function sameProposal(a: CheckProposal, b: CheckProposal): boolean {
	return (
		a.kind === b.kind &&
		a.path === b.path &&
		a.command === b.command &&
		a.expect === b.expect
	);
}

/**
 * What a candidate check's verdict on the *unmodified* files means.
 *
 * Three outcomes, and only one of them is a usable check:
 *
 * - It passed. Then it says nothing about the task: it would have kept the
 *   transaction before a line was edited. Rejected.
 * - It could not run at all — a command that is not installed, a file that is
 *   not there. Rejected, and named as that rather than as a failure, because
 *   "not found" and "found a problem" arrive here looking the same and only
 *   one of them is the check working.
 * - It ran and reported a problem. That is the check doing its job on a
 *   broken tree, and it is the only one accepted.
 */
export function judgeCandidateCheck(
	verdict: OracleVerdict,
): { usable: true } | { usable: false; problem: string } {
	if (verdict.passed) {
		return {
			usable: false,
			problem:
				"That check already passes on the files as they were before any edit, so it cannot tell a fix from no fix at all. Propose one that fails right now and passes once the change lands.",
		};
	}
	if (verdict.timedOut) {
		return {
			usable: false,
			problem:
				"That check did not finish in the time it is given, so it cannot judge an attempt. Propose something faster.",
		};
	}
	if (verdict.exitCode === null) {
		return {
			usable: false,
			problem: `That check could not be run here at all, so it would judge nothing: ${verdict.output.trim() || "no output"}. Propose something that exists on this machine — \`kind: "page"\` needs nothing installed.`,
		};
	}
	return { usable: true };
}

/**
 * The tool a model proposes its own check with.
 *
 * Offered only where there is nothing to run: `discoverOracle` found no test
 * runner, no build and no compiler, so without this the transaction's verdict
 * is the model's own account of its work. Measured, that account is wrong
 * often enough to be the reason this protocol exists — and the model is
 * nonetheless the only party that has read the code and knows what would
 * demonstrate the fix. So it proposes, and the user decides.
 *
 * A tool rather than a sentence in the closing message. `readSelfReport` is
 * already a phrase-matching heuristic and it is the weakest thing here; a
 * second one deciding what the check *is* would compound it.
 */

import { type AgentTool, createTool } from "@cline/shared";
import type { Oracle, OracleVerdict } from "./oracle";
import {
	type CheckApprover,
	type CheckProposal,
	describeCheckProposal,
	judgeCandidateCheck,
	MAX_CHECK_PROPOSALS,
	PROPOSE_CHECK_TOOL_NAME,
	proposalToOracle,
	readCheckProposal,
} from "./proposal";

export { PROPOSE_CHECK_TOOL_NAME };

export const PROPOSE_CHECK_TOOL_DESCRIPTION = `Propose the check that will decide whether your change worked, and ask the user to approve it.

Nothing in this workspace can be run to judge a change, so without a check your own account of the work is the verdict — and that is the weakest evidence there is. Propose one instead. You have read the code; name the thing that would show the fix.

Two kinds:
- \`kind: "page"\` — Cline loads \`path\` itself, runs its scripts and pumps animation frames. It fails if the file does not parse, throws, or never draws. Nothing has to be installed, so prefer this for a page, a game or a script.
- \`kind: "command"\` — a line for the shell. Only worth proposing when you know it exists on this machine; a check that cannot run judges nothing. Add \`expect\` when the command reports its verdict in its output and exits cleanly either way.

Give a \`reason\` in one sentence: what passing this check proves about the task. The user reads it to decide.

Propose once, early — as soon as you know what you are fixing. What is approved judges every attempt for the rest of the run and cannot be changed, so do not propose something you can already make pass.

Once the user approves it, it is tried against the files as they were before your changes, and it has to FAIL there. A check that already passes on the unmodified files cannot tell a fix from no fix, and is refused.`;

export const PROPOSE_CHECK_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		kind: {
			type: "string",
			enum: ["page", "command"],
			description:
				"`page` for a file Cline loads and runs itself; `command` for a shell line.",
		},
		path: {
			type: "string",
			description:
				"For `page`: the file to load, relative to the workspace root.",
		},
		command: {
			type: "string",
			description: "For `command`: the exact line to run.",
		},
		expect: {
			type: "string",
			description:
				"For `command`: a regular expression the output must match, on top of exiting cleanly. Matched inside Cline; never a command.",
		},
		reason: {
			type: "string",
			description: "One sentence: what passing this check proves.",
		},
	},
	required: ["kind", "reason"],
} as const;

/** The part of the controller this tool drives. */
export interface CheckAdopter {
	readonly canAdoptOracle: boolean;
	adoptOracle(oracle: Oracle): void;
	/** Runs a candidate against the files this transaction opened on. */
	judgeAgainstBase(oracle: Oracle): Promise<OracleVerdict>;
}

export interface ProposeCheckToolOptions {
	workspaceRoot: string;
	controller: CheckAdopter;
	/** Asks the user. The security boundary, and never auto-approved. */
	approve: CheckApprover;
	/** For the host to say, in its own voice, what now judges the run. */
	onAdopted?: (oracle: Oracle, proposal: CheckProposal) => void;
	onError?: (message: string, error: unknown) => void;
}

export function createProposeCheckTool(
	options: ProposeCheckToolOptions,
): AgentTool {
	// Rounds, not calls: a proposal the model got wrong in shape has not spent
	// one, because nobody was asked anything. A round is spent by anything that
	// cost the user an interaction -- a decline, or a check they approved that
	// then turned out to judge nothing.
	let spent = 0;

	return createTool({
		name: PROPOSE_CHECK_TOOL_NAME,
		description: PROPOSE_CHECK_TOOL_DESCRIPTION,
		inputSchema: PROPOSE_CHECK_TOOL_INPUT_SCHEMA as unknown as Record<
			string,
			unknown
		>,
		execute: async (input: unknown): Promise<string> => {
			if (!options.controller.canAdoptOracle) {
				return "This run already has a check and it is frozen for the rest of the run. Make your change and let the check judge it.";
			}
			if (spent >= MAX_CHECK_PROPOSALS) {
				return "Two proposals have already been put to the user without one being taken on, so this run has no check and your own account of the work is the verdict. Do not propose again — say plainly whether the change worked and how you know.";
			}

			const proposal = readCheckProposal(input, options.workspaceRoot);
			if ("problem" in proposal) {
				// Not a declined round: nobody was asked anything.
				return `That proposal cannot be used. ${proposal.problem}`;
			}

			const described = describeCheckProposal(proposal);
			let approval: Awaited<ReturnType<CheckApprover>>;
			try {
				approval = await options.approve(proposal, described);
			} catch (error) {
				options.onError?.(
					"[Atomic] the check proposal was not answered",
					error,
				);
				return "The user could not be asked about that check, so the run continues without one. Say plainly whether your change worked and how you know.";
			}

			if (!approval.approved) {
				spent += 1;
				const said = approval.feedback?.trim();
				const left = MAX_CHECK_PROPOSALS - spent;
				return [
					"The user did not approve that check.",
					said ? `They said: ${said}` : undefined,
					left > 0
						? "Propose one more, taking that into account. If you cannot think of a better one, carry on without a check and say so."
						: "That was the last round, so this run has no check and your own account of the work is the verdict.",
				]
					.filter((line): line is string => line !== undefined)
					.join(" ");
			}

			const oracle = proposalToOracle(proposal, options.workspaceRoot);

			// Approved is not the same as usable. A check that already passes on
			// the unmodified files would have kept the transaction before a line
			// was edited, and one that cannot run at all judges nothing -- both
			// arrive as an approved proposal and neither is a check. This is the
			// property that separates the feature from theatre, and the snapshot
			// it needs is already sitting there.
			try {
				const candidate = await options.controller.judgeAgainstBase(oracle);
				const judged = judgeCandidateCheck(candidate);
				if (!judged.usable) {
					spent += 1;
					const left = MAX_CHECK_PROPOSALS - spent;
					return [
						`The user approved that check, but it was tried against the files as they were before your changes and it does not work as a check. ${judged.problem}`,
						left > 0
							? "Propose one more."
							: "That was the last round, so this run has no check and your own account of the work is the verdict.",
					].join(" ");
				}
			} catch (error) {
				// Never fatal: the user has approved it, and a validation that
				// could not be performed is a weaker guarantee rather than a
				// reason to refuse the check they asked for.
				options.onError?.(
					"[Atomic] the proposed check could not be tried against the base",
					error,
				);
			}

			try {
				options.controller.adoptOracle(oracle);
			} catch (error) {
				options.onError?.("[Atomic] the approved check was not adopted", error);
				return "That check was approved but could not be taken on, so the run keeps the check it already had.";
			}
			options.onAdopted?.(oracle, proposal);

			return [
				`Approved. Every attempt from here is judged by: ${oracle.label}.`,
				"It runs when your turn ends, and it decides — not your account of the change.",
				"It is fixed for the rest of the run, so make the change work rather than proposing something easier.",
			].join(" ");
		},
	});
}

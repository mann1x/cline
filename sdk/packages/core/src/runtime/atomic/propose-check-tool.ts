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
import type { Oracle } from "./oracle";
import {
	type CheckApprover,
	type CheckProposal,
	describeCheckProposal,
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

Propose once, early — as soon as you know what you are fixing. What is approved judges every attempt for the rest of the run and cannot be changed, so do not propose something you can already make pass.`;

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
	// one, because nobody was asked anything. Only the user declining does.
	let declined = 0;

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
			if (declined >= MAX_CHECK_PROPOSALS) {
				return "The user has declined twice, so this run has no check and your own account of the work is the verdict. Do not propose again — say plainly whether the change worked and how you know.";
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
				declined += 1;
				const said = approval.feedback?.trim();
				const left = MAX_CHECK_PROPOSALS - declined;
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

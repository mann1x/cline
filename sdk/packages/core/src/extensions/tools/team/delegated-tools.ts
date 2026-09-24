/**
 * The tools a delegated agent gets, on every path that starts one:
 * `spawn_agent`, a configured `subagent_*` tool, and a swarm worker.
 *
 * Two things differ from the lead's set, both measured on pandorum
 * 2026-09-24 (yglnz):
 *
 * - **A question goes to the lead, not the user.** An agent's `ask_question`
 *   reached the user directly, and the whole round -- the lead included, since
 *   it waits inside its delegation call -- sat for 1,141 s until they answered
 *   a question about a tool, from an agent they could not place. Here the
 *   agent's `ask_question` ends its run and its question is its report: the
 *   lead reads it with the others' and decides whether to answer, run the
 *   agent again, or ask the user itself.
 * - **The host's stateless tools come along.** Delegated agents got core's
 *   builtins only, so `check_file` -- which their instructions name -- was an
 *   `unavailable tool` twice, and the question above was the agent asking how
 *   to check braces without it. The ones shared are those that hold nothing
 *   per session and start nothing: not the terminal, which would give every
 *   agent of a round of 75 its own VS Code terminal, and not the browser,
 *   which is one Chrome.
 */
import type { AgentTool } from "@cline/shared";
import { validateWithZod, zodToJsonSchema } from "@cline/shared";
import { AskQuestionInputSchema } from "../schemas";

/** Host tools a delegated agent is given as well as its builtins. */
export const DELEGATED_HOST_TOOLS: ReadonlySet<string> = new Set([
	"check_file",
	"ask_lsp",
	"list_files",
]);

export const ASK_LEAD_TOOL_NAME = "ask_question";

/** How an agent's question reads in the report the lead receives. */
export function formatQuestionForLead(
	question: string,
	options: readonly string[],
): string {
	const lines = [
		"This agent stopped to ask a question instead of finishing its task. Nothing was asked of the user.",
		"",
		`Question: ${question.trim()}`,
	];
	if (options.length > 0) {
		lines.push("Options:", ...options.map((option) => `- ${option}`));
	}
	lines.push(
		"",
		"Answer it by running the agent again with the answer in its task, answer it yourself if you can, or ask the user with `ask_question` if only they know.",
	);
	return lines.join("\n");
}

/**
 * `ask_question` for a delegated agent: the same name and input, so an agent
 * file that tells it to ask still works, but the call ends the agent's run and
 * the question becomes what it reports to the lead.
 */
export function createAskLeadTool(): AgentTool {
	return {
		name: ASK_LEAD_TOOL_NAME,
		description:
			"Ask the agent that started you a question, when you cannot finish the task without an answer. " +
			"This ends your run: your question, with 2-5 options, is your report, and the lead decides what happens next -- " +
			"it may run you again with the answer. Ask only what you cannot find out with your tools. " +
			"Output: none you will see; the call is the last thing you do.",
		inputSchema: zodToJsonSchema(AskQuestionInputSchema),
		lifecycle: { completesRun: true },
		retryable: false,
		maxRetries: 0,
		execute: async (input) => {
			const validated = validateWithZod(AskQuestionInputSchema, input);
			return formatQuestionForLead(validated.question, validated.options);
		},
	} as AgentTool;
}

/**
 * A delegated agent's tools from its builtins and the host's tools.
 *
 * A host tool replaces a builtin of the same name, as it does for the lead.
 */
export function delegatedAgentTools(
	builtins: readonly AgentTool[],
	hostTools: readonly AgentTool[] | undefined,
): AgentTool[] {
	const shared = (hostTools ?? []).filter((tool) =>
		DELEGATED_HOST_TOOLS.has(tool.name),
	);
	const replaced = new Set(shared.map((tool) => tool.name));
	const tools = [
		...builtins.filter((tool) => !replaced.has(tool.name)),
		...shared,
	];
	return tools.map((tool) =>
		tool.name === ASK_LEAD_TOOL_NAME ? createAskLeadTool() : tool,
	);
}

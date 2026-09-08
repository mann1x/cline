/**
 * Delegation the *user* asked for, rather than delegation the model chose.
 *
 * A configured agent already reaches the model as a `subagent_<name>` tool, and
 * the model decides whether to call it. That is the right default and the wrong
 * only option: "run the QA agent on this" is an instruction, and a session
 * where the lead model quietly does the work itself instead is not delegation,
 * it is a suggestion that was declined.
 *
 * So the host runs the agent directly. The same tool object the model would
 * have called is executed here, which is the point -- provider resolution,
 * profile resolution, the per-agent skill and tool filtering and the endpoint
 * slot gate are the ones the tool path already got right, and a second
 * implementation of any of them would be a second thing to keep correct.
 */

import type { AgentHooks, AgentTool, AgentToolContext } from "@cline/shared";
import type { ConfiguredAgentConfig } from "./configured-agent-config";
import { buildConfiguredAgentToolDescriptors } from "./configured-agent-tool";
import { withDelegationHooks } from "./delegation-call-hooks";
import type { SpawnAgentOutput } from "./spawn-agent-tool";

/** One configured agent, as a host needs to show it in a picker. */
export interface ConfiguredAgentSummary {
	name: string;
	description: string;
	/** The tool the model would call to reach this agent. */
	toolName: string;
	/** Where the agent runs, when it names somewhere other than the session. */
	profile?: string;
	providerId?: string;
	modelId?: string;
	skills?: string[];
	/** The file it was read from, so a host can offer to open it. */
	path?: string;
}

export interface ConfiguredAgentDelegationResult {
	agentName: string;
	toolName: string;
	text: string;
	iterations: number;
	finishReason?: string;
	usage?: { inputTokens: number; outputTokens: number };
	/** Milliseconds the delegated run took, wall clock. */
	durationMs: number;
}

export function listConfiguredAgentSummaries(
	agents: readonly ConfiguredAgentConfig[] | undefined,
): ConfiguredAgentSummary[] {
	if (!agents || agents.length === 0) {
		return [];
	}
	return buildConfiguredAgentToolDescriptors(agents).map(
		({ toolName, config }) => ({
			name: config.name,
			description: config.description,
			toolName,
			profile: config.profile,
			providerId: config.providerId,
			modelId: config.modelId,
			skills: config.skills,
			path: config.path,
		}),
	);
}

/**
 * Resolve an agent by the name a user typed.
 *
 * Case-insensitive, because the name in a picker and the name in a command line
 * are the same name to everyone except a string comparison.
 */
export function findConfiguredAgent(
	agents: readonly ConfiguredAgentConfig[] | undefined,
	name: string,
): ConfiguredAgentSummary | undefined {
	const wanted = name.trim().toLowerCase();
	if (!wanted) {
		return undefined;
	}
	const summaries = listConfiguredAgentSummaries(agents);
	return (
		summaries.find((agent) => agent.name.toLowerCase() === wanted) ??
		summaries.find((agent) => agent.toolName.toLowerCase() === wanted)
	);
}

export class UnknownConfiguredAgentError extends Error {
	constructor(
		readonly requested: string,
		readonly available: readonly string[],
	) {
		super(
			available.length > 0
				? `There is no agent named "${requested}". Available: ${available.join(", ")}.`
				: `There is no agent named "${requested}", and no agents are configured. ` +
						"Agent files live in .cline/agents in the workspace, or in the Cline data directory.",
		);
		this.name = "UnknownConfiguredAgentError";
	}
}

export interface DelegateToConfiguredAgentInput {
	agents: readonly ConfiguredAgentConfig[] | undefined;
	/** The session's built tools, which already contain the `subagent_*` ones. */
	tools: readonly AgentTool[];
	agentName: string;
	prompt: string;
	sessionId?: string;
	/** The lead agent's id, so the delegated run is parented to it. */
	parentAgentId: string;
	conversationId?: string;
	signal?: AbortSignal;
	/**
	 * Hooks for this run alone, on top of the session's.
	 *
	 * How a background delegation gets its pause barrier: the run is otherwise
	 * identical to a foreground one, and giving it a second code path to run
	 * down would be a second path to keep correct.
	 */
	hooks?: AgentHooks;
}

/**
 * Run one configured agent on a task, on the host's say-so.
 *
 * Throws {@link UnknownConfiguredAgentError} for a name nobody has, and lets a
 * failure inside the agent surface as itself: a delegated run that failed is
 * not a delegation that did not happen, and flattening the two would hide which
 * one the user is looking at.
 */
export async function delegateToConfiguredAgent(
	input: DelegateToConfiguredAgentInput,
): Promise<ConfiguredAgentDelegationResult> {
	const prompt = input.prompt.trim();
	if (!prompt) {
		throw new Error("A delegated task needs a description of the work.");
	}
	const agent = findConfiguredAgent(input.agents, input.agentName);
	if (!agent) {
		throw new UnknownConfiguredAgentError(
			input.agentName,
			listConfiguredAgentSummaries(input.agents).map((entry) => entry.name),
		);
	}
	const tool = input.tools.find((entry) => entry.name === agent.toolName);
	if (!tool) {
		// The agent file parsed and the tool is still absent, which means
		// subagents are turned off for this session. Naming that is the
		// difference between a feature that is off and one that is broken.
		throw new Error(
			`The "${agent.name}" agent is configured but not available in this session. ` +
				"Subagents are turned off, so there is nothing to delegate to.",
		);
	}

	const context: AgentToolContext = {
		sessionId: input.sessionId,
		agentId: input.parentAgentId,
		conversationId: input.conversationId,
		iteration: 0,
		signal: input.signal,
		metadata: withDelegationHooks({ delegatedByUser: true }, input.hooks),
	};

	const startedAt = Date.now();
	const output = (await tool.execute({ prompt }, context)) as SpawnAgentOutput;
	return {
		agentName: agent.name,
		toolName: agent.toolName,
		text: output?.text ?? "",
		iterations: output?.iterations ?? 0,
		finishReason: output?.finishReason,
		usage: output?.usage,
		durationMs: Date.now() - startedAt,
	};
}

/**
 * How a delegated run enters the conversation.
 *
 * As a user-role message rather than a synthesized tool call: the lead model
 * never made a call, and manufacturing one would put a tool result in the
 * transcript answering a request that was never sent -- which some providers
 * reject outright and every reader of the transcript would misread. This says
 * what actually happened, in the voice of the person it happened on behalf of.
 */
export function renderDelegationForTranscript(
	result: ConfiguredAgentDelegationResult,
	task: string,
): string {
	const report = result.text.trim();
	return [
		`I delegated this to the "${result.agentName}" agent:`,
		"",
		task.trim(),
		"",
		report
			? `The agent reported back:\n\n${report}`
			: "The agent finished without reporting anything.",
	].join("\n");
}

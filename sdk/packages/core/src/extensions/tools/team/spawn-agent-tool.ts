/**
 * Reusable spawn_agent tool for delegating tasks to sub-agents.
 */

import { releasePolykvAgent } from "@cline/llms";
import {
	type AgentConfig,
	type AgentEvent,
	type AgentHooks,
	type AgentResult,
	type AgentTool,
	type AgentToolContext,
	type BasicLogger,
	createTool,
	type HookErrorMode,
	type ITelemetryService,
	type ToolApprovalRequest,
	type ToolApprovalResult,
	type ToolPolicy,
	type TurnFaultRecovery,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import type { OracleSpawnWrapper } from "../../../runtime/atomic/oracle";
import { createDelegatedStruggleSupervisor } from "../../../runtime/safety/worker-struggle";
import { isPolykvProvider } from "../../context/polykv-session";
import {
	type AgentCheck,
	type AgentOracleResult,
	createDelegatedAgentCheck,
	describeAgentCheck,
	readAgentCheck,
} from "./agent-check";
import {
	AGENT_CONTROLS_NOTE,
	AgentControlFields,
	maxIterationsOf,
} from "./agent-controls";
import {
	createDelegatedAgentLifetime,
	type DelegatedRunOutcome,
	type DelegatedStopReason,
	runDelegatedWithCap,
} from "./agent-iteration-cap";
import { summarizeForLead } from "./agent-reports";
import {
	type AgentFacts,
	agentFacts,
	agentFactsLine,
	type RoundHandle,
	type RoundMemberOutput,
	type RoundShared,
	reportWaits,
	roundsFor,
} from "./agent-rounds";
import { createAgentTroubleWatch, roomWaitTrouble } from "./agent-trouble";
import { buildSpawnBatchReport, type SpawnBatchReport } from "./batch-report";
import type { ConfiguredAgentConfig } from "./configured-agent-config";
import {
	createDelegatedAgent,
	type DelegatedAgentConfigProvider,
} from "./delegated-agent";
import {
	isAdmissionEvent,
	resumePlacement,
	runPlacedAgent,
} from "./placed-run";
import {
	drawSpawnSampling,
	mergeSpawnSampling,
	primeModelTemperature,
	type RealizedSpawnSampling,
	readSpawnSampling,
	SPAWN_SAMPLING_NOTE,
	SpawnSamplingFields,
	samplingForCopy,
	spawnSamplingFields,
} from "./spawn-sampling";
import {
	registerSubagentCancellation,
	type SubagentRequeueCarry,
	subagentCancelId,
	withRevisedInstructions,
} from "./subagent-cancellation";
import { buildSubagentLayout } from "./subagent-layout";
import {
	compactionLogger,
	createSubagentProgress,
	DELEGATION_PACING_NOTE,
	reportSubagentFinished,
	reportSubagentModel,
	reportSubagentSampling,
	requeued,
	restarted,
	watchPolykvRoom,
} from "./subagent-progress";
import { createTurnFaultRecovery } from "./turn-fault-recovery";

/** The tool a model calls to hand a self-contained piece of work to a subagent. */
export const SPAWN_AGENT_TOOL_NAME = "spawn_agent";

type AgentExtension = NonNullable<AgentConfig["extensions"]>[number];
type AgentFinishReason = AgentResult["finishReason"];

export const SpawnAgentInputSchema = z.object({
	/**
	 * What several sub-agents are given in common, stated once per agent and
	 * identically. On an engine with a shared KV pool it is held once for all
	 * of them; elsewhere the files are passed by name.
	 */
	knowledge: z
		.object({
			files: z
				.array(z.string())
				.optional()
				.describe(
					"Workspace files the agent works from. Give the SAME list to every agent that works on them: they are loaded once and shared, instead of each agent reading its own copy.",
				),
			text: z
				.string()
				.optional()
				.describe(
					"Shared notes every agent given this knowledge needs: findings, constraints, context. Keep it identical across those agents.",
				),
		})
		.optional()
		.describe(
			"Knowledge shared by several agents. Put here what they all need, and keep it identical across them; what differs goes in `instructions` and `task`.",
		),
	instructions: z
		.string()
		.optional()
		.describe(
			"The agent's role: how it works and what it looks for. Reuse the same text for every agent of the same kind (e.g. all 'js-brace-fixer' agents) -- it is shared between them. Put per-agent specifics in `task`.",
		),
	/** The older name for `instructions`, still accepted. */
	systemPrompt: z
		.string()
		.optional()
		.describe("Deprecated: use `instructions`."),
	task: z
		.string()
		.optional()
		.describe(
			"This agent's own task: what it alone must do. Refer to shared files by path; their content is already shared through `knowledge`. Give `task` for one agent, or `agents` for several.",
		),
	/**
	 * What to call this sub-agent in the UI.
	 *
	 * Spawned sub-agents are otherwise anonymous: the interface can only
	 * number them and quote their prompts back, which is unreadable once
	 * several are running at once. The caller knows what each one is for, so
	 * it is the caller that names them. Optional, because a run whose model
	 * ignores the field must still work.
	 */
	name: z
		.string()
		.optional()
		.describe(
			"Short label for this sub-agent, shown in the UI (e.g. 'tests', 'docs', 'api-review'). A few words at most.",
		),
	/**
	 * The lead's sampler for this agent -- or, beside `agents`, for every agent
	 * of the call, the seed offset by each agent's index. See `spawn-sampling.ts`.
	 */
	...SpawnSamplingFields,
	/** Its iteration cap and its check; beside `agents`, every agent's default. */
	...AgentControlFields,
	wait: z
		.boolean()
		.optional()
		.describe(
			"Wait for the agents to finish before this call returns (default: true for one agent; false for several, and for `merge`). With false the call returns at once with a round id and the agents run in the background while you keep working: their report is delivered to you when the round ends, `agents_status` shows their progress, and `await_agents` waits for them.",
		),
});

/**
 * Several agents in one call.
 *
 * What the model reaches for first: asked for 75 reports in the sx4bp run
 * (pandorum, 2026-09-23), the lead planned "a swarm", found only a one-agent
 * tool, and spent its turn deciding whether 75 calls was too many before
 * writing all 75 -- each repeating the same `knowledge` and `instructions`.
 * A list states the shared parts once and is one call.
 */
export const SpawnAgentMemberSchema = z.object({
	name: z
		.string()
		.optional()
		.describe("Short label for this agent, shown in the UI."),
	task: z.string().describe("What this agent alone must do."),
	instructions: z
		.string()
		.optional()
		.describe(
			"This agent's role, when it differs from the shared `instructions`.",
		),
	type: z
		.string()
		.optional()
		.describe(
			"A configured agent to run this entry as (the name after `subagent_`). It keeps its own role and model; the shared `knowledge` is given to it with the task.",
		),
	count: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			"How many agents run this entry, each with its own report (default 1). 15 of each of five agent types is five entries with `count: 15`, not 75 entries.",
		),
	temperature: SpawnSamplingFields.temperature.describe(
		"Sampling temperature for this entry's agents, over the call's `temperature`.",
	),
	seed: SpawnSamplingFields.seed.describe(
		'Sampling seed for this entry, over the call\'s `seed`. With `count`, each copy gets seed + its index: seed 7 with count 3 is 7, 8, 9; "random" gives each copy its own.',
	),
	temperature_range: SpawnSamplingFields.temperature_range.describe(
		"Percent this entry's agents' temperature is randomized by, over the call's `temperature_range`.",
	),
	max_iterations: AgentControlFields.max_iterations.describe(
		"This entry's iteration cap, over the call's `max_iterations`.",
	),
	check: AgentControlFields.check.describe(
		"This entry's check, over the call's `check`.",
	),
});

/** Most agents one entry's `count` may ask for. */
export const MAX_AGENTS_PER_ENTRY = 100;

/**
 * One entry per agent, with each `count` spelled out.
 *
 * Copies are named `<name>-<n>` so their rows and reports tell them apart.
 * The host expands the same way (`spawnBatchMembers`), which is what keeps a
 * row keyed `<call>#<index>` on the agent it shows.
 *
 * An entry's `seed` is offset by the copy's index -- seed 7 with count 3 is
 * 7, 8 and 9 -- so that copies running one task do not draw identical samples.
 * Its `temperature` is the same for every copy.
 */
export function expandAgentCounts(
	agents: readonly SpawnAgentMember[],
): SpawnAgentMember[] {
	return agents.flatMap((member, index) => {
		const count = Math.min(
			MAX_AGENTS_PER_ENTRY,
			Math.max(1, Math.floor(member.count ?? 1)),
		);
		const { count: _count, ...rest } = member;
		if (count === 1) {
			return [rest];
		}
		const base =
			member.name?.trim() || member.type?.trim() || `agent-${index + 1}`;
		return Array.from({ length: count }, (_entry, copy) => ({
			...rest,
			name: `${base}-${copy + 1}`,
			...(typeof rest.seed === "number" ? { seed: rest.seed + copy } : {}),
		}));
	});
}

export const SpawnAgentBatchInputSchema = SpawnAgentInputSchema.extend({
	agents: z
		.array(SpawnAgentMemberSchema)
		.optional()
		.describe(
			"Several agents at once: one entry per agent, sharing `knowledge` and `instructions`. Each returns its own report. Use instead of `task` whenever the job wants more than one agent.",
		),
});

/** Only offered when the session can run swarms. */
export const SpawnAgentSwarmInputSchema = SpawnAgentBatchInputSchema.extend({
	merge: z
		.boolean()
		.optional()
		.describe(
			"Run the agents as a swarm: they share a snapshot of your current context, and you get back one merged report instead of one per agent. Their own transcripts are discarded.",
		),
	count: z
		.union([z.number().int().positive(), z.literal("max")])
		.optional()
		.describe(
			'With `merge` and a single `task`: how many agents to run on it. "max" means as many as the servers will take.',
		),
});

export type SpawnAgentMember = z.infer<typeof SpawnAgentMemberSchema>;
export type SpawnAgentInput = z.infer<typeof SpawnAgentInputSchema> & {
	agents?: SpawnAgentMember[];
	merge?: boolean;
	count?: number | "max";
};

/** One agent of a batch, as reported back. */
export interface SpawnAgentMemberOutput extends Partial<SpawnAgentOutput> {
	name: string;
	/** Set when this agent failed; its siblings' reports are unaffected. */
	error?: string;
	/** Times the engine evicted it (an engine bug each time), when it did. */
	evicted?: number;
}

/**
 * An `agents` call's result: an aggregate, an index of every agent, and as
 * many reports as fit -- the rest named, to read with `read_agent_report`.
 * See `batch-report.ts`.
 */
export type SpawnAgentBatchOutput = SpawnBatchReport;

export interface SpawnAgentOutput {
	text: string;
	iterations: number;
	finishReason: AgentFinishReason;
	usage: {
		inputTokens: number;
		outputTokens: number;
	};
	/**
	 * Which model actually spent those tokens.
	 *
	 * Not always the session's: agents can be given a connection of their own,
	 * and a configured agent may name a provider per file. Without this the
	 * host can only add a sub-agent's tokens to the lead's total, which is the
	 * difference between free local tokens and billed ones going unrecorded.
	 */
	model?: {
		id: string;
		provider: string;
	};
	/**
	 * Which agent node this agent was placed on, when the session has any.
	 *
	 * The model and the node are different facts and both are worth showing:
	 * two nodes can carry the same model on two endpoints, and the reason a
	 * fan-out is slow is usually which node took the work rather than which
	 * model did it. Absent on a session with no nodes, where there is only
	 * one place an agent can run and naming it says nothing.
	 */
	nodeId?: string;
	/** What the settings panel calls that node: `Node1`, `Node2`. */
	nodeLabel?: string;
	/**
	 * The sampler the call asked for, when it asked: what this agent ran with
	 * over its model's own -- a random seed or temperature as drawn, with what
	 * it was drawn around. Absent means the model's own throughout.
	 */
	sampling?: RealizedSpawnSampling;
	/** The agent's own id: what `resume_agent` and the status tool name it by. */
	agentId?: string;
	/** Its cap: the first one plus every raise. Absent is no cap. */
	maxIterations?: number;
	/** Set when the iteration cap is what ended it (the lead stopped it there). */
	stopReason?: DelegatedStopReason;
	/**
	 * `awaiting_lead`: it is at its cap, waiting, work kept -- continue it with
	 * `resume_agent`. Only when nothing could ask the lead during the round.
	 */
	state?: "awaiting_lead";
	/** The lead's check, when one was set: pass, fail or not run. */
	oracle?: AgentOracleResult;
	/**
	 * Its place in the round and how it ended (section F): id, state, stop
	 * reason, iterations against its cap, tokens, compactions, check, sampler
	 * and node. Set on the result the lead is handed.
	 */
	agent?: AgentFacts;
}

export interface SubAgentStartContext {
	subAgentId: string;
	conversationId: string;
	parentAgentId: string;
	input: SpawnAgentInput;
	/**
	 * The spawning tool call. Unique per spawned agent (batch spawns suffix the
	 * index), and known before the agent's own id exists, so it is the key a
	 * per-agent sandbox is registered under and later handed back by. Optional
	 * because a tool context need not carry one; sandboxing is skipped when it
	 * does not.
	 */
	toolCallId?: string;
}

export interface SubAgentEndContext {
	subAgentId: string;
	conversationId: string;
	parentAgentId: string;
	input: SpawnAgentInput;
	/** The spawning tool call; see {@link SubAgentStartContext.toolCallId}. */
	toolCallId?: string;
	result?: SpawnAgentOutput;
	agentResult?: AgentResult;
	error?: Error;
}

/** How a delegation that has ended is identified to its last observer. */
export interface SubAgentSettledContext {
	/** The spawning tool call; see {@link SubAgentStartContext.toolCallId}. */
	toolCallId?: string;
	/** The agent's name, as the lead gave it or as its file names it. */
	name: string;
}

export interface SpawnAgentToolConfig {
	configProvider: DelegatedAgentConfigProvider;
	/**
	 * Whether the session also offers the `team_*` tools. Only then does the
	 * description point at them: with Teammates off (the default) a sentence
	 * sending the model to tools it was not given is a call that fails.
	 */
	teammates?: boolean;
	defaultMaxIterations?: number;
	subAgentTools?: AgentTool[];
	createSubAgentTools?: (
		input: SpawnAgentInput,
		context: AgentToolContext,
	) => AgentTool[] | Promise<AgentTool[]>;
	onSubAgentEvent?: (event: AgentEvent) => void;
	/**
	 * Lifecycle hooks forwarded to spawned sub-agent runs.
	 */
	hooks?: AgentHooks;
	/**
	 * Extension list forwarded to spawned sub-agent runs.
	 */
	extensions?: AgentExtension[];
	/**
	 * Error handling mode for forwarded lifecycle hooks.
	 */
	hookErrorMode?: HookErrorMode;
	/**
	 * Called after a sub-agent instance is created and before it starts running.
	 * Errors are ignored so lifecycle observers cannot break task execution.
	 */
	onSubAgentStart?: (context: SubAgentStartContext) => void | Promise<void>;
	/**
	 * Called once a sub-agent run finishes (success or error).
	 * Errors are ignored so lifecycle observers cannot break task execution.
	 */
	onSubAgentEnd?: (context: SubAgentEndContext) => void | Promise<void>;
	/**
	 * Called once the spawn is over, however it ended -- including the paths
	 * {@link onSubAgentEnd} never sees, where the agent failed or was stopped
	 * before it started. Whatever `createSubAgentTools` opened for this call
	 * (its private workspace) is released here, so nothing outlives the call.
	 * Errors are ignored.
	 */
	onSubAgentSettled?: (context: SubAgentSettledContext) => void | Promise<void>;
	/**
	 * Optional per-tool policy for spawned sub-agents.
	 */
	toolPolicies?: Record<string, ToolPolicy>;
	/**
	 * Optional approval callback for spawned sub-agent tool calls.
	 */
	requestToolApproval?: (
		request: ToolApprovalRequest,
	) => Promise<ToolApprovalResult> | ToolApprovalResult;
	/**
	 * Optional logger forwarded to spawned sub-agent runs.
	 */
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
	/**
	 * The configured agents an `agents[].type` may name, keyed by
	 * {@link configuredAgentKey}. Each runs through its own tool, so its role,
	 * model and placement are exactly what a direct `subagent_<name>` call
	 * would give it.
	 */
	configuredAgents?: () => ReadonlyMap<string, AgentTool>;
	/** The same agents' definitions, keyed alike: what a swarm worker needs. */
	configuredAgentConfigs?: () => ReadonlyMap<string, ConfiguredAgentConfig>;
	/**
	 * The session's swarm, when it can run one. Present means `merge` and
	 * `count` are offered and routed to it, and `spawn_swarm` is not
	 * registered on its own.
	 */
	swarm?: AgentTool;
	/**
	 * The launcher an agent's commands run under, keyed by its spawning tool
	 * call: where its `check` is run. `undefined` -- or no resolver -- is no
	 * command sandbox, and the check is reported as not run.
	 */
	commandSandboxFor?: (
		toolCallId: string | undefined,
	) => { wrapSpawn: OracleSpawnWrapper; cwd: string } | undefined;
	/**
	 * The lead's session, when the tool is built for one: its rounds can then
	 * run an agent again from their record (`retry_failed`) without the call
	 * that first ran it.
	 */
	sessionId?: string;
}

/** The key a configured agent is looked up by: `JS-Syntactic`, `js_syntactic` and `subagent_js_syntactic` are one agent. */
export function configuredAgentKey(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/^subagent_/, "")
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

const SPAWN_AGENT_DESCRIPTION =
	"Spawn sub-agents for focused tasks: `task` for one agent, `agents` for several in one call. Structure the work in three parts, from most shared to least: `knowledge` (files and notes the agents need -- identical across them), `instructions` (the role -- identical for every agent of the same kind), and each agent's `task` (what it alone does). Shared parts are loaded once for all agents that share them, so many agents cost little more than one. An `agents` entry may name a configured agent in `type`; it then runs with that agent's own role and model. " +
	"Output: one agent gives `{text, iterations, maxIterations?, finishReason, stopReason?, state?, oracle?, agentId, usage: {inputTokens, outputTokens}, agent: {id, round, state, stopReason, iterations, maxIterations, tokens, compactions, oracle, sampling, node, model}}`; `agents` gives `{round, summary: {total, completed, errored, cancelled, awaitingLead, byType, byFailureClass, totalIterations, totalTokens}, agents: [{id, name, status, stop?, failureClass?, line?, error?, iterations?, maxIterations?, stopReason?, agentId?, oracle?}], reports: [{name, id, facts, text, oracle?}], notShown?: {names}, usage}` -- every agent is in `agents`; a report left out of `reports` to keep the result whole is listed in `notShown` and read with `read_agent_report(name)`. `failureClass` is `infra` (server, transport or refusal: worth running again as is) or `task` (the model, a tool or the iteration budget). Every call is a round with an id (`r3`) and each agent has one (`r3-2`): `agents_status` shows a round or an agent in detail, and `retry_failed(round_id)` runs its failed agents again from their original tasks. " +
	"Not merging is the way to get N separate reports: each agent of an `agents` call reports on its own, where `merge` returns one combined report. " +
	"`text` is the sub-agent's final answer and the only part you need: it worked in its own context, so nothing it read or edited is visible to you except through `text`. One agent waits by default: it has finished by the time you see this, unless its `state` is `awaiting_lead`. Several agents run in the background by default: the call returns at once with the round id, you keep working, and their report is delivered to you when the round ends (`wait: true` to block instead). " +
	"Give each sub-agent a short `name`: when several run at once it is the only thing telling their progress apart on screen. ";

/** Said only when the session has the team tools; see {@link SpawnAgentToolConfig.teammates}. */
const SPAWN_AGENT_TEAMMATES_NOTE =
	"Use `spawn_agent` for tasks that finish and report back; use the `team_*` tools for long-lived teammates you keep assigning work to and messaging. ";

const SPAWN_AGENT_SWARM_DESCRIPTION =
	'With `merge: true` the agents run as a swarm instead: they share a snapshot of your current context, so they need no `knowledge` about what you already know, and you get back one merged report rather than one per agent. Use it when the parts do not depend on each other and you want one answer -- searching a repo several ways, checking several files, trying several approaches. With a single `task`, `count` says how many agents run it; `count: "max"` means as many as the servers will take. An `agents` entry with a `type` keeps the role and tools of that agent in the swarm. ';

export function describeSpawnAgent(swarm: boolean, teammates = false): string {
	return (
		SPAWN_AGENT_DESCRIPTION +
		(teammates ? SPAWN_AGENT_TEAMMATES_NOTE : "") +
		(swarm ? SPAWN_AGENT_SWARM_DESCRIPTION : "") +
		SPAWN_SAMPLING_NOTE +
		AGENT_CONTROLS_NOTE +
		DELEGATION_PACING_NOTE
	);
}

/** Shared knowledge, as text in front of a task, for an agent whose prompt is its own. */
function withKnowledge(
	knowledge: SpawnAgentInput["knowledge"],
	task: string,
): string {
	const parts: string[] = [];
	if (knowledge?.text?.trim()) {
		parts.push(knowledge.text.trim());
	}
	if (knowledge?.files && knowledge.files.length > 0) {
		parts.push(
			[
				"Files to work from (read them with your tools as you need them):",
				...knowledge.files.map((file) => `- ${file}`),
			].join("\n"),
		);
	}
	return parts.length > 0
		? `# Shared knowledge\n\n${parts.join("\n\n")}\n\n# Your task\n\n${task}`
		: task;
}

/** Fields a call can carry beside `agents`; see {@link readAgentsField}. */
const AGENTS_SIBLING_FIELDS = new Set([
	"wait",
	"merge",
	"count",
	"knowledge",
	"instructions",
	"systemPrompt",
	"task",
	"name",
	"temperature",
	"seed",
	"temperature_range",
	"max_iterations",
	"check",
]);

/**
 * `agents` as the list it was meant to be, or a refusal that says how to send it.
 *
 * Measured on pandorum 2026-09-23 (5rybo): qwen sent `agents` as text, twice,
 * and the text was the list followed by the rest of the call --
 * `[{...}, ...], "merge": true`. That is not JSON on its own, it went through
 * as a string, and the batch failed with `a.map is not a function`, which
 * told the model nothing it could act on. It gave up on the list and fanned
 * one task out fifteen times instead.
 *
 * Two readings are taken, each the only one its text has: the list as JSON
 * text, and the list with the fields written after it, read as the object
 * they close. A field that bled in fills only what the call left unset.
 * Anything else is refused by name, never run.
 */
export function readAgentsField(input: SpawnAgentInput): SpawnAgentInput {
	const raw = (input as { agents?: unknown }).agents;
	if (raw === undefined || Array.isArray(raw)) {
		return checkMembers(input);
	}
	if (typeof raw !== "string") {
		throw new Error(AGENTS_SHAPE_HELP);
	}
	let listError: unknown;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return checkMembers({ ...input, agents: parsed });
		}
	} catch (error) {
		listError = error;
	}
	try {
		const parsed: unknown = JSON.parse(`{"agents":${raw}}`);
		if (
			parsed &&
			typeof parsed === "object" &&
			Array.isArray((parsed as { agents?: unknown }).agents)
		) {
			const { agents, ...rest } = parsed as Record<string, unknown>;
			const bled = Object.fromEntries(
				Object.entries(rest).filter(
					([key]) =>
						AGENTS_SIBLING_FIELDS.has(key) &&
						(input as Record<string, unknown>)[key] === undefined,
				),
			);
			return checkMembers({
				...bled,
				...input,
				agents,
			} as SpawnAgentInput);
		}
	} catch {
		// Refused below, with the first reading's error: that is the one that
		// says where the list itself stops parsing.
	}
	throw new Error(
		`\`agents\` arrived as text, not as an array, and the text does not parse (${
			listError instanceof Error ? listError.message : "not a list"
		}). ${AGENTS_SHAPE_HELP}`,
	);
}

const AGENTS_SHAPE_HELP =
	'Send `agents` as an array of objects, one per agent -- [{"name": "...", "task": "..."}, ...] -- and put `merge`, `count` and `knowledge` in fields of their own, not inside `agents`.';

function checkMembers(input: SpawnAgentInput): SpawnAgentInput {
	const members = (input.agents ?? []) as unknown[];
	if (members.length === 0) {
		return input;
	}
	members.forEach((member, index) => {
		const task = (member as { task?: unknown } | null)?.task;
		if (typeof task !== "string" || task.trim() === "") {
			throw new Error(
				`\`agents[${index}]\` has no \`task\`. Every entry needs one: what that agent alone must do. ${AGENTS_SHAPE_HELP}`,
			);
		}
	});
	return {
		...input,
		agents: expandAgentCounts(input.agents as SpawnAgentMember[]),
	};
}

/**
 * The swarm tool's input, from a `merge` call.
 *
 * An entry naming a configured agent in `type` becomes a worker with that
 * agent's role and tool list, on the swarm's nodes and snapshot. Dropped
 * before, so asked for "15 code-verifiers as a swarm" the round ran fifteen
 * generic workers under the lead's shared instructions.
 */
export function toSwarmInput(
	input: SpawnAgentInput,
	configs?: ReadonlyMap<string, ConfiguredAgentConfig>,
): Record<string, unknown> {
	const role = input.instructions ?? input.systemPrompt ?? "";
	const knowledge = withKnowledge(input.knowledge, "").replace(
		/\n\n# Your task\n\n$/,
		"",
	);
	const roleOf = (member: SpawnAgentMember) => {
		const type = member.type?.trim();
		if (!type) {
			return undefined;
		}
		const agent = configs?.get(configuredAgentKey(type));
		if (!agent) {
			const known = [...(configs?.values() ?? [])].map((entry) => entry.name);
			throw new Error(
				`No configured agent named "${type}".${
					known.length > 0
						? ` Configured agents: ${known.join(", ")}.`
						: " None are configured."
				}`,
			);
		}
		// A swarm's workers share the lead's snapshot on the swarm's nodes. An
		// agent pinned to a model of its own cannot share it, and running it on
		// the node's model would change its model without saying so.
		if (agent.providerId || agent.modelId || agent.profile) {
			throw new Error(
				`The configured agent "${agent.name}" runs on its own model (${
					agent.profile
						? `profile ${agent.profile}`
						: [agent.providerId, agent.modelId].filter(Boolean).join("/")
				}), and a swarm runs every worker on the swarm's shared snapshot. Send its entries without \`merge\` to run them on their own model, each with its own report.`,
			);
		}
		return agent;
	};
	return {
		systemPrompt: [role, knowledge].filter((part) => part.trim()).join("\n\n"),
		...(input.task ? { task: input.task } : {}),
		...(input.agents && input.agents.length > 0
			? {
					tasks: input.agents.map((member) => {
						const agent = roleOf(member);
						return {
							...(member.name ? { name: member.name } : {}),
							...spawnSamplingFields(readSpawnSampling(member)),
							...controlFields(member),
							task: member.instructions
								? `${member.instructions}\n\n${member.task}`
								: member.task,
							...(agent
								? {
										systemPrompt: [agent.systemPrompt, knowledge]
											.filter((part) => part.trim())
											.join("\n\n"),
										...(agent.tools ? { tools: agent.tools } : {}),
									}
								: {}),
						};
					}),
				}
			: {}),
		...(input.count !== undefined ? { count: input.count } : {}),
		...(input.wait !== undefined ? { wait: input.wait } : {}),
		// The call's sampler is the swarm's: its seed is offset per worker
		// there, as it is per agent in a batch.
		...spawnSamplingFields(readSpawnSampling(input)),
		// And its cap and check are the round's, under each task's own.
		...controlFields(input),
	};
}

/** `max_iterations` and `check`, read and passed on only when set. */
export function controlFields(input: unknown): {
	max_iterations?: number;
	check?: AgentCheck;
} {
	const record = (input ?? {}) as { check?: unknown };
	const maxIterations = maxIterationsOf(input);
	const check = readAgentCheck(record.check);
	return {
		...(maxIterations !== undefined ? { max_iterations: maxIterations } : {}),
		...(check ? { check } : {}),
	};
}

/** What a session hands its spawn tool beyond the connection. */
export type SpawnToolOptions = Pick<
	SpawnAgentToolConfig,
	"swarm" | "configuredAgents" | "configuredAgentConfigs" | "teammates"
>;

/**
 * Create a spawn_agent tool that can run a delegated task with a focused sub-agent.
 */
export function createSpawnAgentTool(
	config: SpawnAgentToolConfig,
): AgentTool<
	SpawnAgentInput,
	SpawnAgentOutput | SpawnAgentBatchOutput | SpawnBackgroundAck
> {
	// A session's spawn tool can run an agent of one of its rounds again from
	// the round's record -- `retry_failed`, a restart of a finished agent --
	// long after the call that started it is gone from the lead's history.
	if (config.sessionId !== undefined) {
		registerSpawnRunner(config, config.sessionId);
	}
	return createTool<
		SpawnAgentInput,
		SpawnAgentOutput | SpawnAgentBatchOutput | SpawnBackgroundAck
	>({
		name: SPAWN_AGENT_TOOL_NAME,
		description: describeSpawnAgent(
			Boolean(config.swarm),
			config.teammates === true,
		),
		inputSchema: zodToJsonSchema(
			config.swarm ? SpawnAgentSwarmInputSchema : SpawnAgentBatchInputSchema,
		),
		execute: async (raw, context) => {
			const input = readAgentsField(raw);
			if (input.merge && config.swarm) {
				return (await config.swarm.execute(
					toSwarmInput(input, config.configuredAgentConfigs?.()) as never,
					context,
				)) as never;
			}
			if (input.agents && input.agents.length > 0) {
				return await runSpawnBatch(config, input, context);
			}
			const task = input.task?.trim();
			if (!task) {
				throw new Error(
					"spawn_agent needs a `task` for one agent, or `agents` for several.",
				);
			}
			return await runSingleSpawn(config, { ...input, task }, context);
		},
		timeoutMs: 300000,
		retryable: false,
		// It gates itself -- the spawn queue when placed, the endpoint's
		// slot gate when not -- so the runtime's pool of eight must not
		// gate it again. Forty requested agents ran eight wide behind it.
		lifecycle: { boundsOwnConcurrency: true },
	});
}

/** The round's shared parts, as a retry needs them. */
function sharedOf(input: SpawnAgentInput): RoundShared {
	const instructions = input.instructions ?? input.systemPrompt;
	const sampling = readSpawnSampling(input);
	return {
		...(input.knowledge ? { knowledge: input.knowledge } : {}),
		...(instructions ? { instructions } : {}),
		...(sampling ? { sampling } : {}),
	};
}

/**
 * How `retry_failed` and a restart run a `spawn_agent` agent again: the same
 * way the call ran it, from the round's stored task, knowledge and role.
 */
function registerSpawnRunner(
	config: SpawnAgentToolConfig,
	sessionId: string,
): void {
	roundsFor(sessionId).registerRunner(
		"spawn_agent",
		async ({ round, agent, task, context }) => {
			const sampling = spawnSamplingFields(
				mergeSpawnSampling(round.shared.sampling, agent.sampling),
			);
			// Its cap and check as the call gave them.
			const controls = storedControls(agent);
			if (agent.type?.trim()) {
				const tool = config
					.configuredAgents?.()
					?.get(configuredAgentKey(agent.type));
				if (!tool) {
					throw new Error(
						`No configured agent named "${agent.type}" in this session.`,
					);
				}
				const output = (await tool.execute(
					{
						prompt: withKnowledge(round.shared.knowledge, task),
						...sampling,
						...controls,
					} as never,
					context,
				)) as SpawnAgentOutput;
				return { name: agent.name, ...output };
			}
			const instructions = agent.instructions ?? round.shared.instructions;
			const output = await runSpawnedAgent(
				config,
				{
					name: agent.name,
					task,
					...sampling,
					...controls,
					...(round.shared.knowledge
						? { knowledge: round.shared.knowledge }
						: {}),
					...(instructions ? { instructions } : {}),
				},
				context,
			);
			return { name: agent.name, ...output };
		},
	);
}

/**
 * An agent's cap and check as its round stored them, for a rerun. The cap
 * is the one it was given, not one the lead raised later: a rerun starts
 * over.
 */
export function storedControls(agent: {
	maxIterations?: number;
	check?: unknown;
}): { max_iterations?: number; check?: AgentCheck } {
	return controlFields({
		...(agent.maxIterations !== undefined
			? { max_iterations: agent.maxIterations }
			: {}),
		...(agent.check !== undefined ? { check: agent.check } : {}),
	});
}

/**
 * What a call that runs in the background returns at once: where its agents
 * are, and how their report will reach the lead.
 */
export interface SpawnBackgroundAck {
	background: true;
	round: string;
	agents: Array<{ id: string; name: string }>;
	note: string;
}

export function backgroundAck(handle: RoundHandle): SpawnBackgroundAck {
	return {
		background: true,
		round: handle.id,
		agents: handle.record.agents.map((agent) => ({
			id: agent.id,
			name: agent.name,
		})),
		note: `Round ${handle.id} runs in the background. Keep working: its report is delivered to you when every agent has finished. \`agents_status\` shows progress; \`await_agents(round_id: "${handle.id}")\` waits for it.`,
	};
}

/** One agent: a round of one, blocking unless `wait: false`. */
async function runSingleSpawn(
	config: SpawnAgentToolConfig,
	input: SpawnAgentInput & { task: string },
	context: AgentToolContext,
): Promise<SpawnAgentOutput | SpawnBackgroundAck> {
	// Refused before a round is opened: a check that cannot parse.
	const controls = controlFields(input);
	const maxIterations = controls.max_iterations ?? config.defaultMaxIterations;
	const rounds = roundsFor(context.sessionId);
	const background = input.wait === false;
	const name = input.name?.trim() || "agent";
	const sampling = readSpawnSampling(input);
	const handle = rounds.open({
		kind: "spawn_agent",
		tool: SPAWN_AGENT_TOOL_NAME,
		...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
		background,
		shared: sharedOf(input),
		agents: [
			{
				name,
				task: input.task,
				...(sampling ? { sampling } : {}),
				...(maxIterations ? { maxIterations } : {}),
				...(controls.check ? { check: controls.check } : {}),
			},
		],
		...(background ? {} : context.signal ? { signal: context.signal } : {}),
		...(context.emitUpdate ? { emitUpdate: context.emitUpdate } : {}),
	});
	const memberContext: AgentToolContext = { ...context, signal: handle.signal };
	const run = (ctx: AgentToolContext) =>
		runSpawnedAgent(config, input, ctx) as Promise<RoundMemberOutput>;
	if (background) {
		// Its row stays open past the call; its end is sent to it the way a
		// batch member's is, since no call result will carry it there.
		void handle
			.run(0, memberContext, run)
			.then((output) => reportSubagentFinished(context.emitUpdate, output))
			.finally(() => handle.close());
		return backgroundAck(handle);
	}
	const leave = rounds.enterBlocking();
	try {
		await handle.run(0, memberContext, run);
		// A restart or retry of it from the side turn runs before the call
		// returns: the lead gets the run that counts.
		await handle.idle();
		const output = handle.outputs()[0] as SpawnAgentOutput & {
			error?: string;
		};
		const agent = handle.agent(0);
		handle.delivered();
		if (output.error !== undefined && output.finishReason === undefined) {
			throw new Error(output.error);
		}
		const {
			name: _name,
			error: _error,
			...rest
		} = output as SpawnAgentOutput & {
			name?: string;
			error?: string;
		};
		return {
			...rest,
			...(agent ? { agent: agentFacts(handle.record, agent) } : {}),
		};
	} finally {
		leave();
		handle.close();
	}
}

/**
 * Every agent of an `agents` call, each through the spawn queue on its own.
 *
 * Started together and paced by the queue, never by this loop: an agent that
 * finds no room waits there, in the order it was listed. One agent failing is
 * its own entry in the results; its siblings still report.
 */
async function runSpawnBatch(
	config: SpawnAgentToolConfig,
	input: SpawnAgentInput,
	context: AgentToolContext,
): Promise<SpawnAgentBatchOutput | SpawnBackgroundAck> {
	const members = input.agents ?? [];
	const configured = config.configuredAgents?.();
	// The call's sampler covers every agent of the call, its seed offset by the
	// agent's index; an entry's own values, already offset per copy, win.
	const callSampling = readSpawnSampling(input);
	// Read once, before any agent starts: a check that will not parse is
	// refused for the whole call rather than failing every agent it covers.
	const callControls = controlFields(input);
	const memberControls = members.map((member) => ({
		...callControls,
		...controlFields(member),
	}));
	const rounds = roundsFor(context.sessionId);
	// Several agents are a long job: the lead is not held for it (ruling 2 of
	// the lead-control spec). Measured 2026-09-26: a 75-agent batch left the
	// lead blocked for its whole run, answering stuck-agent reports in side
	// turns. One agent still blocks unless told otherwise.
	const background =
		input.wait === false || (input.wait !== true && members.length > 1);
	const handle = rounds.open({
		kind: "spawn_agent",
		tool: SPAWN_AGENT_TOOL_NAME,
		...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
		background,
		shared: sharedOf(input),
		agents: members.map((member, index) => {
			const sampling = mergeSpawnSampling(
				samplingForCopy(callSampling, index),
				readSpawnSampling(member),
			);
			return {
				name: member.name?.trim() || `agent-${index + 1}`,
				task: member.task,
				...(member.instructions ? { instructions: member.instructions } : {}),
				...(member.type?.trim() ? { type: member.type.trim() } : {}),
				...(sampling ? { sampling } : {}),
				...((memberControls[index]?.max_iterations ??
				config.defaultMaxIterations)
					? {
							maxIterations:
								memberControls[index]?.max_iterations ??
								config.defaultMaxIterations,
						}
					: {}),
				...(memberControls[index]?.check
					? { check: memberControls[index]?.check }
					: {}),
			};
		}),
		...(background ? {} : context.signal ? { signal: context.signal } : {}),
		...(context.emitUpdate ? { emitUpdate: context.emitUpdate } : {}),
		rowed: true,
	});
	async function runBatchMember(
		member: SpawnAgentMember,
		index: number,
		memberContext: AgentToolContext,
	): Promise<SpawnAgentMemberOutput> {
		const name = member.name?.trim() || `agent-${index + 1}`;
		// The entry's cap and check over the call's.
		const controls = memberControls[index] ?? {};
		const sampling = spawnSamplingFields(
			mergeSpawnSampling(
				samplingForCopy(callSampling, index),
				readSpawnSampling(member),
			),
		);
		// Every eviction the turn-fault recovery reports on its row is
		// counted for the round report, host or no host.
		let evicted = 0;
		const countedContext: AgentToolContext = {
			...memberContext,
			emitUpdate: (update: unknown) => {
				const row = update as Record<string, unknown>;
				if (typeof row?.evicted === "number") {
					evicted += 1;
				}
				memberContext.emitUpdate?.(update);
			},
		};
		const withEvictions = (
			output: SpawnAgentMemberOutput,
		): SpawnAgentMemberOutput =>
			evicted > 0 ? { ...output, evicted } : output;
		try {
			if (member.type?.trim()) {
				const tool = configured?.get(configuredAgentKey(member.type));
				if (!tool) {
					const known = [...(configured?.keys() ?? [])].join(", ");
					throw new Error(
						`No configured agent named "${member.type}".${
							known ? ` Configured agents: ${known}.` : " None are configured."
						}`,
					);
				}
				const output = (await tool.execute(
					{
						prompt: withKnowledge(input.knowledge, member.task),
						...sampling,
						...controls,
					} as never,
					countedContext,
				)) as SpawnAgentOutput;
				return withEvictions({ name, ...output });
			}
			const output = await runSpawnedAgent(
				config,
				{
					name,
					task: member.task,
					...sampling,
					...controls,
					...(input.knowledge ? { knowledge: input.knowledge } : {}),
					...((member.instructions ?? input.instructions ?? input.systemPrompt)
						? {
								instructions:
									member.instructions ??
									input.instructions ??
									input.systemPrompt,
							}
						: {}),
				},
				countedContext,
			);
			return withEvictions({ name, ...output });
		} catch (error) {
			return withEvictions({
				name,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const runAll = Promise.all(
		members.map(async (member, index) => {
			// Each member reports on its own row: the host keys it by the call
			// and this index, and its stop registration by the same pair.
			const memberContext: AgentToolContext = {
				...context,
				signal: handle.signal,
				toolCallId: `${context.toolCallId}#${index}`,
			};
			const output = await handle.run(index, memberContext, (ctx) =>
				runBatchMember(member, index, ctx),
			);
			reportSubagentFinished(
				context.emitUpdate &&
					((update: unknown) =>
						context.emitUpdate?.({
							...(update as Record<string, unknown>),
							member: index,
						})),
				output,
			);
			return output;
		}),
	);
	if (background) {
		void runAll.finally(() => handle.close());
		return backgroundAck(handle);
	}
	const leave = rounds.enterBlocking();
	try {
		await runAll;
		await handle.idle();
		handle.delivered();
		// Built to fit the tool-result cap and name every agent: a round of 75
		// summaries was cut from the middle, and the lead lost the agents there.
		return roundBatchReport(handle, context.sessionId);
	} finally {
		leave();
		handle.close();
	}
}

/** A round's batch report, each agent with its id, stop reason and facts. */
function roundBatchReport(
	handle: RoundHandle,
	sessionId: string | undefined,
): SpawnAgentBatchOutput {
	const outputs = handle.outputs();
	return buildSpawnBatchReport(
		handle.record.agents.map((agent, index) => ({
			...(outputs[index] as SpawnAgentMemberOutput),
			name: agent.name,
			...(agent.type ? { type: agent.type } : {}),
			id: agent.id,
			...(agent.stopReason ? { stop: agent.stopReason } : {}),
			facts: agentFactsLine(agent),
		})),
		sessionId,
		undefined,
		handle.id,
	);
}

/** What an agent moved to another node is told when it carries on. */
export function requeueNote(reason: string | undefined): string {
	return `[The lead moved you to another place to run${
		reason ? ` (${reason})` : ""
	}. Your work so far is above. Carry on with your task from where you stopped.]`;
}

// Beside the registry whose restarts carry the instructions: a teammate's
// task, run by the team runtime, is restarted the same way.
export { withRevisedInstructions };

/** One agent: placed through the spawn queue when there are nodes, run, reported. */
async function runSpawnedAgent(
	config: SpawnAgentToolConfig,
	input: SpawnAgentInput & { task: string },
	context: AgentToolContext,
): Promise<SpawnAgentOutput> {
	// Refused before anything is opened: a check that cannot parse would fail
	// every completion attempt of an agent that can never finish.
	const controls = controlFields(input);
	const maxIterations = controls.max_iterations ?? config.defaultMaxIterations;
	// Held past the call when the agent is detached at its cap: its
	// workspace, stop registration and engine session go when it is done.
	const lifetime = createDelegatedAgentLifetime();
	let capOutcome: DelegatedRunOutcome | undefined;
	// Where its check runs, and the task that states the check: set per
	// attempt, once that attempt's workspace is open.
	let sandbox: { wrapSpawn: OracleSpawnWrapper; cwd: string } | undefined;
	let task = input.task;
	// Where it runs is decided before it is built: a node is a whole agents
	// configuration, so which node took this agent decides which model it
	// is. Without nodes this is undefined and the agent runs on the single
	// delegated connection, as it always did.
	const placement = config.configProvider.getRuntimeConfig().nodePlacement;
	// This agent's own engine session -- never the lead's. Slash-free: the
	// engine's close route cannot carry one.
	const engineSessionId = `${context.sessionId ?? "cerebriline"}~agent-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	const lead = context.sessionId ?? "cerebriline";
	// What it is doing, on the tool call that started it. Nothing else
	// reports a running sub-agent to the user at all.
	const progress = createSubagentProgress(
		context.emitUpdate,
		config.onSubAgentEvent,
		Date.now,
		{ onCompaction: compactionLogger(input.name ?? "agent", config.logger) },
	);
	// Its own abort signal, so a runaway agent can be stopped without
	// cancelling the session and the siblings that are working.
	const cancelId = subagentCancelId(context.sessionId, context.toolCallId);
	const cancellation = registerSubagentCancellation(
		cancelId,
		context.signal,
		input.name,
	);
	// How long it has been stuck, for the lead: after long enough without
	// progress the lead is told, once, and may take the task back. Each wait
	// is also on its row's channel, for its round's status.
	const trouble = reportWaits(
		createAgentTroubleWatch({
			sessionId: context.sessionId,
			name: input.name ?? "agent",
			...(config.logger ? { logger: config.logger } : {}),
		}),
		context.emitUpdate,
		cancellation,
	);
	// Queued again while its requests wait for room on the engine.
	const stopRoomWatch = watchPolykvRoom(
		engineSessionId,
		context.emitUpdate,
		config.logger,
		(reason) => trouble.waiting(roomWaitTrouble(reason)),
	);
	// Announced rather than reconstructed by the reader. The chat row is the
	// thing that offers the stop, and it must name exactly what was
	// registered.
	if (cancelId) {
		context.emitUpdate?.({ cancelId });
	}
	const parentAgentId = context.agentId;
	// The lead's sampler, when it gave one. Carried as a build option, so a
	// re-placement onto another node keeps it.
	// Drawn here, once: a random seed, and where in its range a random
	// temperature falls, are this agent's for every attempt -- and for every
	// requeue. A restart starts the agent over, and draws a random one again.
	const requestedSampling = readSpawnSampling(input);
	let sampling = drawSpawnSampling(requestedSampling);
	// What the latest build made of it, for the result.
	let realizedSampling: RealizedSpawnSampling | undefined;
	// From the first build, kept across re-placements: the observers identify
	// one delegation, not one attempt at it.
	let started: { subAgentId: string; conversationId: string } | undefined;
	let tools: AgentTool[] = [];

	// Built per attempt, because the node IS the configuration: the provider
	// is read once at construction.
	const attempt = async (
		provider: DelegatedAgentConfigProvider,
		admitted: () => void,
		recoverTurnFault: TurnFaultRecovery | undefined,
		carry: SubagentRequeueCarry | undefined,
		nodeId?: string,
	): Promise<AgentResult> => {
		const connection = provider.getConnectionConfig();
		// The row names the model while it runs, not only once it is done.
		reportSubagentModel(context.emitUpdate, {
			providerId: connection.providerId,
			modelId: connection.modelId,
			knownModels: connection.knownModels,
			maxIterations: maxIterations ?? provider.getRuntimeConfig().maxIterations,
		});
		const pooled = isPolykvProvider({
			providerId: connection.providerId,
			baseUrl: connection.baseUrl,
			polykv: (connection.providerConfig as { polykv?: never } | undefined)
				?.polykv,
		});
		const layout = await buildSubagentLayout({
			instructions: input.instructions ?? input.systemPrompt ?? "",
			task: withRevisedInstructions(task, cancellation.instructions),
			...(input.knowledge ? { knowledge: input.knowledge } : {}),
			pooled,
			cwd: provider.getRuntimeConfig().cwd,
		});
		// A random temperature is drawn around the model's own: read it from
		// the server now if nothing local states it.
		await primeModelTemperature(sampling, connection);
		// Fresh per attempt: a restarted agent is judged from its own start.
		const check = controls.check
			? createDelegatedAgentCheck({
					check: controls.check,
					cwd: sandbox?.cwd ?? provider.getRuntimeConfig().cwd ?? process.cwd(),
					...(sandbox ? { wrapSpawn: sandbox.wrapSpawn } : {}),
				})
			: undefined;
		// The struggle layer the swarm's workers have: one nudge to commit a
		// SUMMARY, then a stop the lead decides on. Fresh per attempt.
		const struggle = createDelegatedStruggleSupervisor({
			label: `[agents] ${input.name ?? "agent"}`,
			maxIterations: maxIterations ?? provider.getRuntimeConfig().maxIterations,
			thinkingBudgetMessage: provider.getRuntimeConfig().thinkingBudgetMessage,
			...(config.logger ? { logger: config.logger } : {}),
		});
		const agent = createDelegatedAgent({
			kind: "subagent",
			struggle,
			...(check ? { check } : {}),
			// What the lead's side turn leaves for it while the lead waits.
			consumePendingUserMessage: async () => cancellation.takeMessage(),
			prompt: layout.systemPrompt,
			engineSessionId,
			...(pooled
				? { polykvWorker: { group: lead, layers: layout.layers } }
				: {}),
			pinnedHead: layout.pinnedHead,
			configProvider: provider,
			...(sampling
				? {
						sampling,
						onSampling: (realized: RealizedSpawnSampling) => {
							realizedSampling = realized;
							reportSubagentSampling(context.emitUpdate, realized);
						},
					}
				: {}),
			tools,
			maxIterations,
			parentAgentId,
			abortSignal: cancellation.signal,
			// Its own events still go where they always went; the observer
			// forwards them and reports the tool names on the way past. The
			// first one is also the engine admitting it.
			onEvent: (event) => {
				if (isAdmissionEvent(event)) {
					admitted();
					trouble.progressed();
				}
				progress.observe(event);
			},
			hookErrorMode: config.hookErrorMode,
			toolPolicies: config.toolPolicies,
			requestToolApproval: config.requestToolApproval,
			// A server restart or a refusal is waited out, never the answer.
			recoverTurnFault:
				recoverTurnFault ??
				createTurnFaultRecovery({
					label: input.name ?? "a sub-agent",
					baseUrl: () => connection.baseUrl,
					headers: () => connection.headers,
					signal: cancellation.signal,
					...(context.emitUpdate ? { emitUpdate: context.emitUpdate } : {}),
					...(config.logger ? { logger: config.logger } : {}),
					onWaiting: trouble.waiting,
				}),
		});
		// Its transcript, should the lead requeue it.
		cancellation.track(agent);
		if (!started) {
			started = {
				subAgentId: agent.getAgentId(),
				conversationId: agent.getConversationId(),
			};
			if (config.onSubAgentStart) {
				try {
					await config.onSubAgentStart({
						...started,
						parentAgentId,
						input,
						toolCallId: context.toolCallId,
					});
				} catch {
					// Best-effort observer callback.
				}
			}
		}
		// At its cap it waits for the lead, work kept; see
		// `agent-iteration-cap.ts`.
		const outcome = await runDelegatedWithCap({
			agent,
			start: async () => {
				if (carry && carry.messages.length > 0) {
					// Requeued: it carries on from its own transcript on its new
					// placement, rather than starting its task over.
					agent.restore(carry.messages as never);
					return await agent.continue(requeueNote(carry.reason));
				}
				return layout.pinnedHead.length > 0
					? await agent.runWithHead(layout.pinnedHead, layout.task)
					: await agent.run(layout.task);
			},
			name: input.name ?? "agent",
			supervisor: struggle,
			...(maxIterations !== undefined ? { maxIterations } : {}),
			...(context.sessionId ? { sessionId: context.sessionId } : {}),
			...(cancelId ? { cancelId } : {}),
			...(cancellation.signal ? { signal: cancellation.signal } : {}),
			...(context.emitUpdate ? { emitUpdate: context.emitUpdate } : {}),
			...(check ? { check } : {}),
			releaseEngineSession: () => releasePolykvAgent(engineSessionId),
			lifetime,
			onDetachedFinish: (final) => finishDetached(final),
			// Resumed after the call returned: back through its placement.
			resumeThrough: resumePlacement({
				...(placement ? { placement } : {}),
				...(nodeId ? { nodeId } : {}),
				...(config.configProvider.getRuntimeConfig().slotGate
					? { slotGate: config.configProvider.getRuntimeConfig().slotGate }
					: {}),
				signal: () => cancellation.signal,
			}),
		});
		capOutcome = outcome;
		if (outcome.state === "awaiting_lead") {
			return outcome.result;
		}
		// A summary for the lead, and the full report kept for it to read: a
		// round's reports sent whole were cut from the middle.
		return summarizeForLead({
			sessionId: context.sessionId,
			name: input.name ?? "agent",
			result: outcome.result,
			summarize: (prompt) => agent.continue(prompt),
		});
	};

	/** The report, from a result and what the cap and the check made of it. */
	const buildOutput = (
		result: AgentResult,
		outcome: DelegatedRunOutcome | undefined,
		placed?: { nodeId: string; nodeLabel?: string },
	): SpawnAgentOutput => ({
		text:
			outcome?.state === "awaiting_lead"
				? `${result.text}${awaitingLeadNote(input.name ?? "agent", started?.subAgentId, outcome)}`
				: result.text,
		iterations: result.iterations,
		finishReason: result.finishReason,
		usage: {
			inputTokens: result.usage.inputTokens,
			outputTokens: result.usage.outputTokens,
		},
		// Guarded rather than read straight through: `model` is required on
		// the type but this is bookkeeping, and a result that arrives without
		// one is not a reason to fail a sub-agent that has done its work.
		...(result.model
			? { model: { id: result.model.id, provider: result.model.provider } }
			: {}),
		// Where it ran. Only when it was placed: on a session with no nodes
		// there is one place to run and naming it is noise.
		...(placed ? { nodeId: placed.nodeId } : {}),
		...(placed?.nodeLabel ? { nodeLabel: placed.nodeLabel } : {}),
		...(realizedSampling ? { sampling: realizedSampling } : {}),
		...controlReport(started?.subAgentId, outcome),
	});

	/** The observers' end, for a run that ended or an agent detached at its cap. */
	const notifyEnd = async (
		output: SpawnAgentOutput | undefined,
		agentResult: AgentResult | undefined,
		error?: unknown,
	): Promise<void> => {
		if (!config.onSubAgentEnd || !started) {
			return;
		}
		try {
			await config.onSubAgentEnd({
				...started,
				parentAgentId,
				input,
				toolCallId: context.toolCallId,
				...(output ? { result: output } : {}),
				...(agentResult ? { agentResult } : {}),
				...(error !== undefined
					? {
							error: error instanceof Error ? error : new Error(String(error)),
						}
					: {}),
			});
		} catch {
			// Best-effort observer callback.
		}
	};

	/** A detached agent's real end: its work handed back, its observers told. */
	const finishDetached = async (final: DelegatedRunOutcome): Promise<void> => {
		await notifyEnd(buildOutput(final.result, final), final.result);
	};

	try {
		// Restartable from the row and by the lead: an attempt abandoned by a
		// restart is run again from the task, in the same place in the round,
		// on a fresh workspace. The abandoned attempt's engine session goes
		// first -- a stream the server dropped is still booked there.
		const { result, placed } = await cancellation.restartable(
			async (): Promise<{
				result: AgentResult;
				placed?: { nodeId: string; nodeLabel?: string };
			}> => {
				// Its toolset, over a private workspace when the host sandboxes:
				// opened per attempt, so a restart starts from a fresh overlay
				// (opening a key that is open closes the old one first). A
				// requeue keeps it: the transcript it carries refers to it.
				tools = config.createSubAgentTools
					? await config.createSubAgentTools(input, context)
					: (config.subAgentTools ?? []);
				// Where its check runs: under its own command sandbox, which
				// exists only once its workspace is open -- above. None means
				// the check is not run.
				sandbox = controls.check
					? config.commandSandboxFor?.(context.toolCallId)
					: undefined;
				task = controls.check
					? `${input.task}\n\n${describeAgentCheck(controls.check, sandbox !== undefined)}`
					: input.task;
				return await cancellation.continuable(
					async (carry) => {
						if (placement) {
							const outcome = await runPlacedAgent({
								placement,
								// The segment's, not the lead's: a restart or a requeue
								// while it is still queued takes it out of the queue.
								signal: cancellation.signal,
								emitUpdate: context.emitUpdate,
								...(config.logger ? { logger: config.logger } : {}),
								label: input.name ?? "a sub-agent",
								onWaiting: trouble.waiting,
								...(carry
									? {
											requeued: carry.avoidNodeId
												? { avoidNodeId: carry.avoidNodeId }
												: {},
										}
									: {}),
								run: (node, admitted, recoverTurnFault) =>
									attempt(
										node.configProvider,
										admitted,
										recoverTurnFault,
										carry,
										node.nodeId,
									),
								// A failed spawn's engine session goes before the next try, or
								// the retry is charged to a window booked for the last one.
								beforeRetry: async () => {
									await releasePolykvAgent(engineSessionId);
								},
							});
							return { result: outcome.result, placed: outcome.placed };
						}
						// Held to the endpoint's slot count, around the run alone: building
						// the toolset costs the server nothing, and holding a slot across it
						// would leave the endpoint idle while a slot was booked.
						const slotGate = config.configProvider.getRuntimeConfig().slotGate;
						const run = () =>
							attempt(config.configProvider, () => {}, undefined, carry);
						return { result: slotGate ? await slotGate.run(run) : await run() };
					},
					(carry) =>
						requeued(context.emitUpdate, engineSessionId, carry.reason),
				);
			},
			async () => {
				// A restart is a new start: a random sampler is drawn again.
				sampling = drawSpawnSampling(requestedSampling);
				await restarted(context.emitUpdate, engineSessionId);
			},
		);
		const output = buildOutput(result, capOutcome, placed);
		// Detached at its cap: its observers -- the hand-back of its workspace
		// above all -- wait for its real end, or they would dispose what it is
		// waiting to go on with.
		if (capOutcome?.state !== "awaiting_lead") {
			await notifyEnd(output, result);
		}
		return output;
	} catch (error) {
		await notifyEnd(undefined, undefined, error);
		throw error;
	} finally {
		// However the run ended -- or, for an agent detached at its cap, once
		// it does end. A stop registration that outlives its agent is a
		// button that reports success and does nothing.
		await lifetime.end(async () => {
			cancellation.release();
			stopRoomWatch();
			trouble.dispose();
			// And its workspace, which a run that never started still opened.
			if (config.onSubAgentSettled) {
				try {
					await config.onSubAgentSettled({
						toolCallId: context.toolCallId,
						name: input.name ?? "agent",
					});
				} catch {
					// Best-effort observer callback.
				}
			}
			// Its engine session goes back the moment it ends, and its pool
			// owner with it if it was the last: admission is decided against
			// held windows, and one held past its work refuses the next agent.
			const released = await releasePolykvAgent(engineSessionId).catch(
				() => undefined,
			);
			for (const failure of released?.failed ?? []) {
				config.logger?.log(
					`[Agents] could not close engine session ${failure.sessionId}: ${failure.error}`,
				);
			}
		});
	}
}

/** The report fields the cap and the check add, only where they say something. */
export function controlReport(
	agentId: string | undefined,
	outcome: DelegatedRunOutcome | undefined,
): Pick<
	SpawnAgentOutput,
	"agentId" | "maxIterations" | "stopReason" | "state" | "oracle"
> {
	return {
		...(agentId ? { agentId } : {}),
		...(outcome?.maxIterations !== undefined
			? { maxIterations: outcome.maxIterations }
			: {}),
		...(outcome?.stopReason ? { stopReason: outcome.stopReason } : {}),
		...(outcome?.state ? { state: outcome.state } : {}),
		...(outcome?.oracle ? { oracle: outcome.oracle } : {}),
	};
}

/** What the lead reads under an agent returned while it waits at its cap. */
export function awaitingLeadNote(
	name: string,
	agentId: string | undefined,
	outcome: DelegatedRunOutcome,
): string {
	if (outcome.stopReason === "supervisor") {
		return `\n\n---\n${name} was STRUGGLING: the struggle supervisor had told it to commit a SUMMARY of what it had, and stopped it when it went on probing. It is WAITING for you, its work kept (transcript and file changes). Call resume_agent(agent_id: "${agentId ?? name}", extra_iterations: <n>, instructions: "<what to settle for>") to continue it, or restart_agent(agent_id: "${agentId ?? name}", instructions: "...") to start it over; its report arrives when it finishes. Or stop it (stop_agents) to take the above as its report.`;
	}
	if (outcome.stopReason === "loop_guard") {
		return `\n\n---\n${name} was LOOPING: the loop guard stopped it for sending the same call again after its warning. It is WAITING for you, its work kept (transcript and file changes). Call resume_agent(agent_id: "${agentId ?? name}", extra_iterations: <n>, instructions: "<what to do instead>") to continue it, or restart_agent(agent_id: "${agentId ?? name}", instructions: "...") to start it over; its report arrives when it finishes. Or stop it (stop_agents) to take the above as its report.`;
	}
	return `\n\n---\n${name} reached its ${outcome.maxIterations ?? outcome.iterations}-iteration cap and is WAITING for you, its work kept (transcript and file changes). Call resume_agent(agent_id: "${agentId ?? name}", extra_iterations: <n>) to continue it from where it stopped; its report arrives when it finishes. Or stop it (stop_agents) to take the above as its report.`;
}

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
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import { isPolykvProvider } from "../../context/polykv-session";
import type { ConfiguredAgentConfig } from "./configured-agent-config";
import {
	createDelegatedAgent,
	type DelegatedAgentConfigProvider,
} from "./delegated-agent";
import { isAdmissionEvent, runPlacedAgent } from "./placed-run";
import {
	registerSubagentCancellation,
	subagentCancelId,
} from "./subagent-cancellation";
import { buildSubagentLayout } from "./subagent-layout";
import {
	createSubagentProgress,
	DELEGATION_PACING_NOTE,
	watchPolykvRoom,
} from "./subagent-progress";

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
});

/** Most agents one entry's `count` may ask for. */
export const MAX_AGENTS_PER_ENTRY = 100;

/**
 * One entry per agent, with each `count` spelled out.
 *
 * Copies are named `<name>-<n>` so their rows and reports tell them apart.
 * The host expands the same way (`spawnBatchMembers`), which is what keeps a
 * row keyed `<call>#<index>` on the agent it shows.
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
}

export interface SpawnAgentBatchOutput {
	results: SpawnAgentMemberOutput[];
	usage: { inputTokens: number; outputTokens: number };
}

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
}

export interface SubAgentStartContext {
	subAgentId: string;
	conversationId: string;
	parentAgentId: string;
	input: SpawnAgentInput;
}

export interface SubAgentEndContext {
	subAgentId: string;
	conversationId: string;
	parentAgentId: string;
	input: SpawnAgentInput;
	result?: SpawnAgentOutput;
	agentResult?: AgentResult;
	error?: Error;
}

export interface SpawnAgentToolConfig {
	configProvider: DelegatedAgentConfigProvider;
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
	"Output: one agent gives `{text, iterations, finishReason, usage: {inputTokens, outputTokens}}`; `agents` gives `{results: [{name, text, finishReason, error?}], usage}`. " +
	"`text` is the sub-agent's final answer and the only part you need: it worked in its own context, so nothing it read or edited is visible to you except through `text`. It has already finished by the time you see this — there is nothing to poll and nothing to await. " +
	"Give each sub-agent a short `name`: when several run at once it is the only thing telling their progress apart on screen. ";

const SPAWN_AGENT_SWARM_DESCRIPTION =
	'With `merge: true` the agents run as a swarm instead: they share a snapshot of your current context, so they need no `knowledge` about what you already know, and you get back one merged report rather than one per agent. Use it when the parts do not depend on each other and you want one answer -- searching a repo several ways, checking several files, trying several approaches. With a single `task`, `count` says how many agents run it; `count: "max"` means as many as the servers will take. An `agents` entry with a `type` keeps the role and tools of that agent in the swarm. ';

export function describeSpawnAgent(swarm: boolean): string {
	return (
		SPAWN_AGENT_DESCRIPTION +
		(swarm ? SPAWN_AGENT_SWARM_DESCRIPTION : "") +
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
	"merge",
	"count",
	"knowledge",
	"instructions",
	"systemPrompt",
	"task",
	"name",
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
	};
}

/** What a session hands its spawn tool beyond the connection. */
export type SpawnToolOptions = Pick<
	SpawnAgentToolConfig,
	"swarm" | "configuredAgents" | "configuredAgentConfigs"
>;

/**
 * Create a spawn_agent tool that can run a delegated task with a focused sub-agent.
 */
export function createSpawnAgentTool(
	config: SpawnAgentToolConfig,
): AgentTool<SpawnAgentInput, SpawnAgentOutput | SpawnAgentBatchOutput> {
	return createTool<SpawnAgentInput, SpawnAgentOutput | SpawnAgentBatchOutput>({
		name: SPAWN_AGENT_TOOL_NAME,
		description: describeSpawnAgent(Boolean(config.swarm)),
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
			return await runSpawnedAgent(config, { ...input, task }, context);
		},
		timeoutMs: 300000,
		retryable: false,
		// It gates itself -- the spawn queue when placed, the endpoint's
		// slot gate when not -- so the runtime's pool of eight must not
		// gate it again. Forty requested agents ran eight wide behind it.
		lifecycle: { boundsOwnConcurrency: true },
	});
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
): Promise<SpawnAgentBatchOutput> {
	const members = input.agents ?? [];
	const configured = config.configuredAgents?.();
	const results = await Promise.all(
		members.map(async (member, index): Promise<SpawnAgentMemberOutput> => {
			const name = member.name?.trim() || `agent-${index + 1}`;
			// Each member reports on its own row: the host keys it by the call
			// and this index, and its stop registration by the same pair.
			const memberContext: AgentToolContext = {
				...context,
				toolCallId: `${context.toolCallId}#${index}`,
				...(context.emitUpdate
					? {
							emitUpdate: (update: unknown) =>
								context.emitUpdate?.({
									...(update as Record<string, unknown>),
									member: index,
								}),
						}
					: {}),
			};
			try {
				if (member.type?.trim()) {
					const tool = configured?.get(configuredAgentKey(member.type));
					if (!tool) {
						const known = [...(configured?.keys() ?? [])].join(", ");
						throw new Error(
							`No configured agent named "${member.type}".${
								known
									? ` Configured agents: ${known}.`
									: " None are configured."
							}`,
						);
					}
					const output = (await tool.execute(
						{ prompt: withKnowledge(input.knowledge, member.task) } as never,
						memberContext,
					)) as SpawnAgentOutput;
					return { name, ...output };
				}
				const output = await runSpawnedAgent(
					config,
					{
						name,
						task: member.task,
						...(input.knowledge ? { knowledge: input.knowledge } : {}),
						...((member.instructions ??
						input.instructions ??
						input.systemPrompt)
							? {
									instructions:
										member.instructions ??
										input.instructions ??
										input.systemPrompt,
								}
							: {}),
					},
					memberContext,
				);
				return { name, ...output };
			} catch (error) {
				return {
					name,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}),
	);
	return {
		results,
		usage: {
			inputTokens: results.reduce(
				(sum, entry) => sum + (entry.usage?.inputTokens ?? 0),
				0,
			),
			outputTokens: results.reduce(
				(sum, entry) => sum + (entry.usage?.outputTokens ?? 0),
				0,
			),
		},
	};
}

/** One agent: placed through the spawn queue when there are nodes, run, reported. */
async function runSpawnedAgent(
	config: SpawnAgentToolConfig,
	input: SpawnAgentInput & { task: string },
	context: AgentToolContext,
): Promise<SpawnAgentOutput> {
	const tools = config.createSubAgentTools
		? await config.createSubAgentTools(input, context)
		: (config.subAgentTools ?? []);
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
	);
	// Queued again while its requests wait for room on the engine.
	const stopRoomWatch = watchPolykvRoom(engineSessionId, context.emitUpdate);
	// Its own abort signal, so a runaway agent can be stopped without
	// cancelling the session and the siblings that are working.
	const cancelId = subagentCancelId(context.sessionId, context.toolCallId);
	const cancellation = registerSubagentCancellation(cancelId, context.signal);
	// Announced rather than reconstructed by the reader. The chat row is the
	// thing that offers the stop, and it must name exactly what was
	// registered.
	if (cancelId) {
		context.emitUpdate?.({ cancelId });
	}
	const parentAgentId = context.agentId;
	// From the first build, kept across re-placements: the observers identify
	// one delegation, not one attempt at it.
	let started: { subAgentId: string; conversationId: string } | undefined;

	// Built per attempt, because the node IS the configuration: the provider
	// is read once at construction.
	const attempt = async (
		provider: DelegatedAgentConfigProvider,
		admitted: () => void,
	): Promise<AgentResult> => {
		const connection = provider.getConnectionConfig();
		const pooled = isPolykvProvider({
			providerId: connection.providerId,
			baseUrl: connection.baseUrl,
			polykv: (connection.providerConfig as { polykv?: never } | undefined)
				?.polykv,
		});
		const layout = await buildSubagentLayout({
			instructions: input.instructions ?? input.systemPrompt ?? "",
			task: input.task,
			...(input.knowledge ? { knowledge: input.knowledge } : {}),
			pooled,
			cwd: provider.getRuntimeConfig().cwd,
		});
		const agent = createDelegatedAgent({
			kind: "subagent",
			prompt: layout.systemPrompt,
			engineSessionId,
			...(pooled
				? { polykvWorker: { group: lead, layers: layout.layers } }
				: {}),
			pinnedHead: layout.pinnedHead,
			configProvider: provider,
			tools,
			maxIterations: config.defaultMaxIterations,
			parentAgentId,
			abortSignal: cancellation.signal,
			// Its own events still go where they always went; the observer
			// forwards them and reports the tool names on the way past. The
			// first one is also the engine admitting it.
			onEvent: (event) => {
				if (isAdmissionEvent(event)) {
					admitted();
				}
				progress.observe(event);
			},
			hookErrorMode: config.hookErrorMode,
			toolPolicies: config.toolPolicies,
			requestToolApproval: config.requestToolApproval,
		});
		if (!started) {
			started = {
				subAgentId: agent.getAgentId(),
				conversationId: agent.getConversationId(),
			};
			if (config.onSubAgentStart) {
				try {
					await config.onSubAgentStart({ ...started, parentAgentId, input });
				} catch {
					// Best-effort observer callback.
				}
			}
		}
		return layout.pinnedHead.length > 0
			? await agent.runWithHead(layout.pinnedHead, layout.task)
			: await agent.run(layout.task);
	};

	try {
		let result: AgentResult;
		let placed: { nodeId: string; nodeLabel?: string } | undefined;
		if (placement) {
			const outcome = await runPlacedAgent({
				placement,
				signal: context.signal,
				emitUpdate: context.emitUpdate,
				...(config.logger ? { logger: config.logger } : {}),
				label: input.name ?? "a sub-agent",
				run: (node, admitted) => attempt(node.configProvider, admitted),
				// A failed spawn's engine session goes before the next try, or
				// the retry is charged to a window booked for the last one.
				beforeRetry: async () => {
					await releasePolykvAgent(engineSessionId);
				},
			});
			result = outcome.result;
			placed = outcome.placed;
		} else {
			// Held to the endpoint's slot count, around the run alone: building
			// the toolset costs the server nothing, and holding a slot across it
			// would leave the endpoint idle while a slot was booked.
			const slotGate = config.configProvider.getRuntimeConfig().slotGate;
			const run = () => attempt(config.configProvider, () => {});
			result = slotGate ? await slotGate.run(run) : await run();
		}
		const output: SpawnAgentOutput = {
			text: result.text,
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
		};
		if (config.onSubAgentEnd && started) {
			try {
				await config.onSubAgentEnd({
					...started,
					parentAgentId,
					input,
					result: output,
					agentResult: result,
				});
			} catch {
				// Best-effort observer callback.
			}
		}
		return output;
	} catch (error) {
		if (config.onSubAgentEnd && started) {
			try {
				await config.onSubAgentEnd({
					...started,
					parentAgentId,
					input,
					error: error instanceof Error ? error : new Error(String(error)),
				});
			} catch {
				// Best-effort observer callback.
			}
		}
		throw error;
	} finally {
		// However the run ended: a stop registration that outlives its agent
		// is a button that reports success and does nothing.
		cancellation.release();
		stopRoomWatch();
		// Its engine session goes back the moment it ends, and its pool owner
		// with it if it was the last: admission is decided against held
		// windows, and one held past its work refuses the next agent.
		const released = await releasePolykvAgent(engineSessionId).catch(
			() => undefined,
		);
		for (const failure of released?.failed ?? []) {
			config.logger?.log(
				`[Agents] could not close engine session ${failure.sessionId}: ${failure.error}`,
			);
		}
	}
}

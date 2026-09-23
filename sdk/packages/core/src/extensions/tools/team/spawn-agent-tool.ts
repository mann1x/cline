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
import {
	MAX_NODE_PLACEMENT_ATTEMPTS,
	NODE_MODEL_MISSING_COOL_OFF_MS,
} from "./agent-placement-queue";
import {
	createDelegatedAgent,
	type DelegatedAgentConfigProvider,
} from "./delegated-agent";
import { isNodeUnreachable, isWastedNodeRun } from "./node-reachability";
import {
	registerSubagentCancellation,
	subagentCancelId,
} from "./subagent-cancellation";
import { buildSubagentLayout } from "./subagent-layout";
import { createSubagentProgress } from "./subagent-progress";

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
		.describe(
			"This agent's own task: what it alone must do. Refer to shared files by path; their content is already shared through `knowledge`.",
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

export type SpawnAgentInput = z.infer<typeof SpawnAgentInputSchema>;

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
}

/**
 * Create a spawn_agent tool that can run a delegated task with a focused sub-agent.
 */
export function createSpawnAgentTool(
	config: SpawnAgentToolConfig,
): AgentTool<SpawnAgentInput, SpawnAgentOutput> {
	return createTool<SpawnAgentInput, SpawnAgentOutput>({
		name: SPAWN_AGENT_TOOL_NAME,
		description:
			"Spawn a sub-agent for a focused task. Structure it in three parts, from most shared to least: `knowledge` (files and notes several agents need -- identical across them), `instructions` (the role -- identical for every agent of the same kind), `task` (what this agent alone does). Shared parts are loaded once for all agents that share them, so many agents cost little more than one. " +
			"Output: `{text, iterations, finishReason, usage: {inputTokens, outputTokens}}`. " +
			"`text` is the sub-agent's final answer and the only part you need: it worked in its own context, so nothing it read or edited is visible to you except through `text`. It has already finished by the time you see this — there is nothing to poll and nothing to await. " +
			"Give each sub-agent a short `name`: when several run at once it is the only thing telling their progress apart on screen.",
		inputSchema: zodToJsonSchema(SpawnAgentInputSchema),
		execute: async (input, context) => {
			const tools = config.createSubAgentTools
				? await config.createSubAgentTools(input, context)
				: (config.subAgentTools ?? []);

			// Where it runs, before it is built: a node is a whole agents
			// configuration, so which node took this agent decides which model
			// it is. Without nodes this is undefined and everything below is
			// the single delegated connection, as it always was.
			const placement = config.configProvider.getRuntimeConfig().nodePlacement;
			let placed = placement
				? await placement.place(context.signal)
				: undefined;
			// This agent's own engine session -- never the lead's. Slash-free:
			// the engine's close route cannot carry one.
			const engineSessionId = `${context.sessionId ?? "cerebriline"}~agent-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
			const lead = context.sessionId ?? "cerebriline";
			// What it is doing, on the tool call that started it. Nothing else
			// reports a running sub-agent to the user at all.
			const progress = createSubagentProgress(
				context.emitUpdate,
				config.onSubAgentEvent,
			);
			// Its own abort signal, so a runaway agent can be stopped without
			// cancelling the session and the siblings that are working.
			const cancelId = subagentCancelId(context.sessionId, context.toolCallId);
			const cancellation = registerSubagentCancellation(
				cancelId,
				context.signal,
			);
			// Announced rather than reconstructed by the reader. The chat row is
			// the thing that offers the stop, and it must name exactly what was
			// registered -- a host rebuilding the same string from its own idea
			// of the session id is a stop button that works until the two drift.
			if (cancelId) {
				context.emitUpdate?.({ cancelId });
			}
			// Rebuilt per attempt, because the node IS the configuration: which
			// node took this agent decides its provider and model, and the
			// provider is read once at construction.
			const buildSubAgent = async () => {
				const provider = placed?.configProvider ?? config.configProvider;
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
					parentAgentId: context.agentId,
					abortSignal: cancellation.signal,
					// Its own events still go where they always went; the observer
					// forwards them and reports the tool names on the way past.
					onEvent: progress.observe,
					hookErrorMode: config.hookErrorMode,
					toolPolicies: config.toolPolicies,
					requestToolApproval: config.requestToolApproval,
				});
				return { agent, head: layout.pinnedHead, task: layout.task };
			};
			let built = await buildSubAgent();
			let subAgent = built.agent;
			const start = () =>
				built.head.length > 0
					? subAgent.runWithHead(built.head, built.task)
					: subAgent.run(built.task);
			// Captured from the first build and kept across re-placements: the
			// observers identify one delegation, not one attempt at it, and the
			// chat row is keyed by the tool call rather than by either.
			const subAgentId = subAgent.getAgentId();
			const conversationId = subAgent.getConversationId();
			const parentAgentId = context.agentId;
			if (config.onSubAgentStart) {
				try {
					await config.onSubAgentStart({
						subAgentId,
						conversationId,
						parentAgentId,
						input,
					});
				} catch {
					// Best-effort observer callback.
				}
			}
			try {
				// Held to the endpoint's slot count, from the connection the agents
				// run on -- the gate lives on the delegated-agent config provider
				// because that is the one thing every spawn path already shares.
				// Gated around the run alone: building the toolset and telling the
				// observers costs the server nothing, and holding a slot across them
				// would leave the endpoint idle while a slot was booked.
				const slotGate = config.configProvider.getRuntimeConfig().slotGate;
				const runOnce = async () =>
					placed
						? // The node's own gate, which is its endpoint's answer
							// rather than the session's -- a node on a one-slot
							// ollama must not queue behind an opencoti node.
							await placed.run(start)
						: slotGate
							? await slotGate.run(start)
							: await start();

				// The agent goes back in the queue when the node it landed on
				// could not run it at all.
				//
				// A node whose model its server does not have answers instantly
				// and spends nothing, so there is no work to lose and no side
				// effect to repeat -- and the node will answer the same way for
				// every agent after this one. Failing the agent there reported
				// the node's misconfiguration as the agent's failure, which is
				// what it looked like on screen: an empty report, three times,
				// while two healthy nodes sat idle.
				let result = await runOnce();
				let attemptsLeft = placement ? MAX_NODE_PLACEMENT_ATTEMPTS - 1 : 0;
				while (
					placed &&
					placement &&
					attemptsLeft > 0 &&
					isWastedNodeRun(result)
				) {
					attemptsLeft -= 1;
					config.logger?.log(
						`[Agents] ${placed.nodeLabel ?? placed.nodeId} cannot run this agent (${String(result.text).slice(0, 120)}); re-queueing it on another node`,
					);
					placed.markUnreachable(NODE_MODEL_MISSING_COOL_OFF_MS);
					placed.release();
					placed = await placement.place(context.signal);
					await releasePolykvAgent(engineSessionId);
					built = await buildSubAgent();
					subAgent = built.agent;
					result = await runOnce();
				}
				const output: SpawnAgentOutput = {
					text: result.text,
					iterations: result.iterations,
					finishReason: result.finishReason,
					usage: {
						inputTokens: result.usage.inputTokens,
						outputTokens: result.usage.outputTokens,
					},
					// Guarded rather than read straight through: `model` is
					// required on the type but this is bookkeeping, and a
					// result that arrives without one is not a reason to
					// fail a sub-agent that has already done its work.
					...(result.model
						? {
								model: {
									id: result.model.id,
									provider: result.model.provider,
								},
							}
						: {}),
					// Where it ran. Only when it was placed: on a session with
					// no nodes there is one place to run and naming it is noise.
					...(placed ? { nodeId: placed.nodeId } : {}),
					...(placed?.nodeLabel ? { nodeLabel: placed.nodeLabel } : {}),
				};
				if (config.onSubAgentEnd) {
					try {
						await config.onSubAgentEnd({
							subAgentId,
							conversationId,
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
				if (config.onSubAgentEnd) {
					try {
						await config.onSubAgentEnd({
							subAgentId,
							conversationId,
							parentAgentId,
							input,
							error: error instanceof Error ? error : new Error(String(error)),
						});
					} catch {
						// Best-effort observer callback.
					}
				}
				// A node nothing could connect to is a node the next agent
				// should not be sent to either. Narrow on purpose: a server
				// that answered -- a refusal, a 400, a model error -- is a
				// server that is alive.
				if (placed && isNodeUnreachable(error)) {
					placed.markUnreachable();
				}
				throw error;
			} finally {
				// However the run ended. A node held by an agent that has
				// finished is capacity the next one never sees, and a stop
				// registration that outlives its agent is a button that
				// reports success and does nothing.
				placed?.release();
				cancellation.release();
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
			}
		},
		timeoutMs: 300000,
		retryable: false,
		// It gates itself -- the node lease when placed, the endpoint's
		// slot gate when not -- so the runtime's pool of eight must not
		// gate it again. Forty requested agents ran eight wide behind it.
		lifecycle: { boundsOwnConcurrency: true },
	});
}

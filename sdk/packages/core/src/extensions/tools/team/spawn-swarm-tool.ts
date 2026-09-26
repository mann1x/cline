/**
 * `spawn_swarm` — several agents on one shared prefix, reporting digests.
 *
 * `spawn_agent` delegates one task to one sub-agent that starts from a system
 * prompt and re-prefills the whole of it. A swarm is the other shape: N agents
 * that all need what the lead already knows, which on opencoti can be given to
 * them for free. The lead's live context is snapshotted into a KV pool with
 * `from_session` — no tokens cross the wire, the engine takes the prefix from
 * the slot's own token history — and every worker attaches to it. The workers
 * share a prefix instead of each paying for it.
 *
 * Four things about that are load-bearing, in the order they bite:
 *
 * 1. **The snapshot's timing.** The host prompt cache saves and clears idle
 *    slots the moment any new task launches, so the snapshot has to be taken at
 *    the end of the lead's turn, before any other task starts. Taken late it
 *    captures a slot that has already been cleared.
 * 2. **A failed snapshot holds the pooling, not the round.** Running the
 *    workers against a bad pool means each pays a full prefill and shares
 *    nothing, which is slower than not fanning out at all — so on failure they
 *    run unpooled and the result says so.
 * 3. **Every pool is released, on every path.** Unpin then release, in a
 *    `finally`. The engine's 60-second ephemeral sweep is the crash net, not
 *    the plan, and a pin left on an abandoned subtree blocks reclaim forever.
 * 4. **A worker that breaks the contract is still represented.** The reducer
 *    cannot tell "nothing to report" from "lost", so a worker that threw, or
 *    that spent its whole budget thinking and returned empty content, appears
 *    in the digest with what it did say. Its transcript goes when the pool
 *    does; whatever is not in the digest is gone.
 *
 * "As many agents as possible" needs no parser. The model reads the phrase and
 * passes `count: "max"`, and the runtime resolves it against what the engine
 * says it will take right now — which is the same `/capacity` answer the
 * admission gate draws from, and is bounded there for the reason named in
 * `agent-admission.ts`.
 */

import {
	type AgentMessage,
	type AgentReasoningPart,
	type AgentResult,
	type AgentTool,
	type AgentToolContext,
	createTool,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import {
	mergeWorkDigests,
	parseWorkDigest,
	renderWorkDigest,
	type WorkDigest,
} from "../../context/work-digest";
import {
	type AgentCheck,
	type AgentOracleResult,
	readAgentCheck,
} from "./agent-check";
import {
	AGENT_CONTROLS_NOTE,
	AgentControlFields,
	maxIterationsOf,
} from "./agent-controls";
import type { DelegatedStopReason } from "./agent-iteration-cap";
import {
	agentFactsLine,
	type RoundAgentSpec,
	type RoundMemberOutput,
	roundsFor,
} from "./agent-rounds";
import type { HandedRevision } from "./delegated-sandboxes";
import { backgroundAck } from "./spawn-agent-tool";
import {
	mergeSpawnSampling,
	type RealizedSpawnSampling,
	readSpawnSampling,
	SPAWN_SAMPLING_NOTE,
	type SpawnSampling,
	SpawnSamplingFields,
	samplingForCopy,
} from "./spawn-sampling";
import {
	registerSubagentCancellation,
	type SubagentCancellationRegistration,
	subagentCancelId,
} from "./subagent-cancellation";
import { reportSubagentFinished, restarted } from "./subagent-progress";

export const SpawnSwarmInputSchema = z.object({
	systemPrompt: z
		.string()
		.describe("System prompt every worker in the swarm runs with"),
	task: z
		.string()
		.optional()
		.describe(
			"One task, given to every worker. Use with `count` to fan the same question out; use `tasks` instead when the workers should do different things.",
		),
	tasks: z
		.array(
			z.object({
				name: z
					.string()
					.optional()
					.describe("Short label for this worker, shown in the UI."),
				task: z.string().describe("What this worker is to do."),
				systemPrompt: z
					.string()
					.optional()
					.describe(
						"This worker's own role, in place of the shared `systemPrompt`.",
					),
				tools: z
					.array(z.string())
					.optional()
					.describe("The only tools this worker may use, by name."),
				temperature: SpawnSamplingFields.temperature.describe(
					"Sampling temperature for this worker, over the swarm's `temperature`.",
				),
				seed: SpawnSamplingFields.seed.describe(
					'Sampling seed for this worker, used as given, over the swarm\'s `seed`; "random" for its own.',
				),
				temperature_range: SpawnSamplingFields.temperature_range.describe(
					"Percent this worker's temperature is randomized by, over the swarm's `temperature_range`.",
				),
				max_iterations: AgentControlFields.max_iterations.describe(
					"This worker's iteration cap, over the swarm's `max_iterations`.",
				),
				check: AgentControlFields.check.describe(
					"This worker's check, over the swarm's `check`.",
				),
			}),
		)
		.optional()
		.describe("A task per worker, when they are doing different things."),
	count: z
		.union([z.number().int().positive(), z.literal("max")])
		.optional()
		.describe(
			'How many workers to run on `task`. "max" means as many as the server will take right now; a number is an upper bound, and the server may allow fewer.',
		),
	temperature: SpawnSamplingFields.temperature.describe(
		"Sampling temperature for every worker, over their model's own. \"random\": each worker gets the model's own +/- `temperature_range`%. Omit to keep the model's.",
	),
	seed: SpawnSamplingFields.seed.describe(
		'Sampling seed for the workers: worker i (from 0) gets seed + i, so they do not sample identically; "random" gives each its own. A task\'s own `seed` is used as given.',
	),
	temperature_range: SpawnSamplingFields.temperature_range,
	max_iterations: AgentControlFields.max_iterations.describe(
		"Every worker's iteration cap, unless its task sets its own.",
	),
	check: AgentControlFields.check.describe(
		"Every worker's check, unless its task sets its own.",
	),
	wait: z
		.boolean()
		.optional()
		.describe(
			"Wait for the swarm to finish before this call returns. Default false: the call returns at once with a round id, the workers run while you keep working, and the merged report is delivered to you when the round ends (`await_agents` waits for it explicitly).",
		),
});

export type SpawnSwarmInput = z.infer<typeof SpawnSwarmInputSchema>;

export interface SpawnSwarmOutput {
	/** The merged report. The only thing that survives the round. */
	digest: string;
	/** How many workers actually ran. */
	workers: number;
	/** Whether they shared the lead's prefix, or each paid for their own. */
	pooled: boolean;
	/**
	 * What the round cost, summed over the workers that reported it.
	 *
	 * Carried out because nothing downstream can recover it: the workers'
	 * transcripts are discarded when their pool is released, so a swarm that
	 * kept this to itself would spend N runs' worth of tokens that are counted
	 * nowhere the task header can see. `spawn_agent` reports its own for the
	 * same reason. A worker that threw contributes nothing, having returned no
	 * result to read a count from -- the number is what was reported, not an
	 * estimate of what was spent.
	 */
	usage: { inputTokens: number; outputTokens: number };
	/**
	 * One report per requested worker, in the order they were asked for.
	 *
	 * What the host puts on each worker's row. Without it every row of a
	 * 75-worker round sat at "0 tools called · 0 tokens" for the whole round,
	 * and a worker that failed -- or never started -- said so nowhere.
	 */
	results?: SwarmMemberReport[];
	/** The round this call opened, for `agents_status` and `retry_failed`. */
	round?: string;
	/** Every worker's id and how it ended, one line of facts each. */
	agents?: Array<{
		id: string;
		name: string;
		state?: string;
		stop?: string;
		facts?: string;
	}>;
	/** Set when the round runs in the background and this is its receipt. */
	background?: true;
	note?: string;
}

/** How one worker ended, for its row. */
export interface SwarmMemberReport {
	name: string;
	text?: string;
	usage?: { inputTokens: number; outputTokens: number };
	/** Why it failed, or why it never ran. Absent means it finished. */
	error?: string;
	model?: { provider: string; id: string };
	nodeId?: string;
	nodeLabel?: string;
	/** The seed and temperature it ran with, as drawn, when the call set any. */
	sampling?: RealizedSpawnSampling;
	/** Its id in the round, and how it ended there. */
	id?: string;
	/** Its state in the round: `awaiting_lead` while it waits at its cap. */
	state?: string;
	/** The round's stop reason (`iteration_cap` when the cap ended it). */
	stopReason?: DelegatedStopReason | string;
	finishReason?: string;
	/** Iterations used, and its cap where there is one. */
	iterations?: number;
	maxIterations?: number;
	/** Its own id, for `resume_agent` and the status tool. */
	agentId?: string;
	/** The lead's check, when one was set. */
	oracle?: AgentOracleResult;
}

/** A worker's result, with where it ran when the runner knows. */
export type SwarmWorkerResult = AgentResult & {
	placed?: { nodeId: string; nodeLabel?: string };
	/** What its sampler came to, when the call set one. */
	sampling?: RealizedSpawnSampling;
	/**
	 * The revisions its changes were handed back to the lead as, when it ran on
	 * a private workspace. Present -- even empty -- means it did; the runner
	 * sets the same field on the error a failed worker throws.
	 */
	handback?: readonly HandedRevision[];
	/** Its cap, and what the cap and the check made of its run. */
	maxIterations?: number;
	stopReason?: DelegatedStopReason;
	state?: "awaiting_lead";
	agentId?: string;
	oracle?: AgentOracleResult;
};

/** The revisions a result or a thrown error carries, if it ran sandboxed. */
function handbackOf(carrier: unknown): readonly HandedRevision[] | undefined {
	if (carrier && typeof carrier === "object" && "handback" in carrier) {
		const handback = (carrier as { handback?: unknown }).handback;
		return Array.isArray(handback) ? handback : undefined;
	}
	return undefined;
}

/** An ephemeral pool holding a snapshot of the lead's live context. */
export interface SwarmPoolSnapshot {
	poolId: string;
	/** Unpin then release. Called on every path, success and failure. */
	release(): Promise<void>;
}

export interface SwarmPoolSource {
	/**
	 * Snapshot the lead's live context into an ephemeral pool.
	 *
	 * `undefined` when the engine would not, which runs the round unpooled
	 * rather than failing it.
	 */
	snapshot(): Promise<SwarmPoolSnapshot | undefined>;
	/**
	 * How many workers the engine will take right now, or `undefined` when it
	 * will not say.
	 *
	 * An **opening hint only**, where {@link admit} exists. It is a
	 * point-in-time status, and the question a growing round needs answered is
	 * a different one: not "how many are free" but "may I start one more",
	 * asked again after each spawn.
	 */
	headroom(): Promise<number | undefined>;
	/**
	 * May one more worker start right now? **Asks without taking.**
	 *
	 * This is what lets a round grow: the engine's answer bounds it, rather
	 * than a number computed once at launch. Non-consuming on purpose — the
	 * worker this admits goes on to acquire through its own slot gate, so a
	 * probe that took the slot would book every worker twice and halve the
	 * round.
	 *
	 * Absent on a source that cannot be asked, which keeps the round sized
	 * from the hint: no probe is no evidence that one more would be taken.
	 */
	admit?(): Promise<boolean>;
}

export interface SwarmWorkerRequest {
	name: string;
	task: string;
	systemPrompt: string;
	/** The shared pool, when there is one. */
	poolId?: string;
	/** The only tools this worker gets, by name; absent means all of them. */
	tools?: string[];
	/**
	 * Progress for this worker's row: placement, tool calls, output. Already
	 * tagged with the worker, so the runner reports as a lone agent would.
	 */
	emitUpdate?: (update: unknown) => void;
	/** This worker's own stop, which the lead's cancel also trips. */
	signal?: AbortSignal;
	/** Messages the lead's side turn left for it, one per turn boundary. */
	takeMessage?: () => string | undefined;
	/**
	 * The sampler the call asked for this worker, when it asked; its seed
	 * already offset by the worker's index. See `spawn-sampling.ts`.
	 */
	sampling?: SpawnSampling;
	/** Its iteration cap: the task's, else the swarm's; absent is the default. */
	maxIterations?: number;
	/** Its check: the task's, else the swarm's. */
	check?: AgentCheck;
	/**
	 * The worker's own controls: read its signal per segment (a requeue ends
	 * a segment), run its placement `continuable` so a requeue carries its
	 * transcript, and `track` the agent it builds.
	 */
	control?: SubagentCancellationRegistration;
}

export interface SpawnSwarmToolConfig {
	pools: SwarmPoolSource;
	/** Run one worker to completion. */
	runWorker: (request: SwarmWorkerRequest) => Promise<SwarmWorkerResult>;
	/**
	 * Rewrite several digests into one, with a model that knows what the lead
	 * knows because it was forked from the same pool.
	 *
	 * Optional: without it, and whenever it fails, the digests are folded
	 * mechanically instead. That fold is lossless where the model's is not, so
	 * it is a fallback worth having rather than a degraded mode.
	 *
	 * The reducer is an agent with file tools like the workers, so it can hand
	 * changes back too. It reports them through `handedBack`, whether it
	 * returns a digest or not, so the report can name them beside the
	 * workers'.
	 */
	reduce?: (
		digests: readonly WorkDigest[],
		reducer?: {
			handedBack(name: string, handed: readonly HandedRevision[]): void;
		},
	) => Promise<WorkDigest | undefined>;
	/** Most workers this will ever run, whatever the model or engine says. */
	maxWorkers?: number;
	/**
	 * How long the supervisor waits before asking again, when nothing has
	 * finished and the engine last said no.
	 */
	tickMs?: number;
	/** Test seam. */
	sleep?: (ms: number) => Promise<void>;
	/**
	 * The lead's session, when the tool is built for one: `retry_failed` and a
	 * restart of a finished worker then run it again from its round.
	 */
	sessionId?: string;
}

/**
 * A spin guard, and deliberately not a policy.
 *
 * It exists only so that an engine answering yes forever cannot run this loop
 * until something else breaks. It must never be the number that decides how
 * wide a round gets — that is the engine's answer, and a constant standing in
 * for it is the limit this was raised to remove. Set at the engine's own
 * `--max-parallel` ceiling so that reaching it means something has gone wrong
 * rather than that a swarm was busy.
 */
export const SWARM_RUNAWAY_MAX = 64;

/** Opening size when the engine will not say and cannot be probed. */
export const DEFAULT_MAX_SWARM_WORKERS = 8;

/** How often the supervisor re-asks while work is left. */
export const DEFAULT_SWARM_TICK_MS = 5_000;

/**
 * The reasoning tail of a run that produced no answer.
 *
 * Only read when the content channel came back empty: a run that answered has
 * said what it wanted to say, and its reasoning is working-out, not a report.
 */
function recoverReasoning(result: AgentResult): string | undefined {
	if (result.text.trim() !== "") {
		return undefined;
	}
	for (const message of [...(result.messages ?? [])].reverse()) {
		const parts = ((message as AgentMessage).content ?? []).filter(
			(part): part is AgentReasoningPart => part.type === "reasoning",
		);
		const text = parts
			.map((part) => part.text)
			.join("")
			.trim();
		if (text !== "") {
			return text;
		}
	}
	return undefined;
}

/** What one worker contributed, however it ended. */
function digestOf(name: string, result: AgentResult): WorkDigest {
	const parsed = parseWorkDigest(result.text);
	const reasoning = recoverReasoning(result);
	if (parsed) {
		return { agent: name, ...parsed };
	}
	if (reasoning) {
		return {
			agent: name,
			error: `produced no answer (${result.finishReason})`,
			reasoning,
		};
	}
	return { agent: name, error: `returned nothing (${result.finishReason})` };
}

/**
 * A worker's digest, with what its cap and its check said. The reducer and
 * the fold keep `notes`, so the lead reads it in the merged report -- and
 * a worker waiting at its cap is named with the id to resume it by.
 */
function withControls(
	digest: WorkDigest,
	result: SwarmWorkerResult,
): WorkDigest {
	const lines: string[] = [];
	const cap = result.maxIterations ?? result.iterations;
	if (result.state === "awaiting_lead") {
		lines.push(
			`WAITING at its ${cap}-iteration cap, work kept: resume_agent(agent_id: "${result.agentId ?? digest.agent ?? ""}", extra_iterations: <n>) continues it.`,
		);
	} else if (result.stopReason === "iteration_cap") {
		lines.push(
			`Stopped at its ${cap}-iteration cap; the above is what it got to.`,
		);
	}
	const oracle = result.oracle;
	if (oracle) {
		lines.push(
			oracle.status === "not_run"
				? `Check \`${oracle.command}\`: not run (${oracle.reason ?? "no command sandbox"}).`
				: `Check \`${oracle.command}\`: ${oracle.status.toUpperCase()}${
						oracle.exitCode === null ? "" : ` (exit ${oracle.exitCode})`
					}${
						oracle.status === "fail" && oracle.output
							? `: ${oracle.output.slice(-300)}`
							: ""
					}`,
		);
	}
	if (lines.length === 0) {
		return digest;
	}
	return {
		...digest,
		notes: [digest.notes, ...lines].filter(Boolean).join("\n"),
	};
}

/** One sandboxed worker's hand-back. */
interface SwarmHandback {
	name: string;
	handed: readonly HandedRevision[];
}

/**
 * Where the round's work went, for the end of the swarm's report.
 *
 * Each worker ran on a private copy of the workspace, so the lead's files are
 * untouched and every change is a revision in the lead's log. Without this the
 * lead reads its own copy, sees none of the fixes the digest describes, and
 * concludes the workers did nothing (the `spawn_agent` note's pandorum
 * failure, once per worker). Empty when no worker was sandboxed.
 */
export function swarmHandbackNote(handbacks: readonly SwarmHandback[]): string {
	if (handbacks.length === 0) {
		return "";
	}
	const changed = handbacks.filter((entry) => entry.handed.length > 0);
	if (changed.length === 0) {
		return `\n\n---\nThe workers worked on private copies of the workspace and left your files unchanged; none recorded file changes to hand back.`;
	}
	const verb = (kind: string): string =>
		kind === "deleted" || kind === "created" || kind === "reverted"
			? kind
			: "changed";
	const lines = changed
		.flatMap((entry) =>
			entry.handed.map(
				(h) =>
					`  - ${h.rel} — revision #${h.index} (${verb(h.kind)} by "${entry.name}")`,
			),
		)
		.join("\n");
	const first = changed[0]?.handed[0]?.index ?? 1;
	return (
		`\n\n---\nThe workers worked on private copies of the workspace, so your own files are UNCHANGED. Their changes are held for you as revisions, not written to disk:\n${lines}\n` +
		`To see a version: \`read_files\` with \`revision: "#${first}"\`. To apply it to your workspace: \`restore_file\` with the same \`revision\`. ` +
		`Do not verify the workers' work by reading or running your current copy of these files — it does not contain these changes yet.`
	);
}

function requestedWorkers(input: SpawnSwarmInput): Array<{
	name: string;
	task: string;
	systemPrompt?: string;
	tools?: string[];
	sampling?: SpawnSampling;
	maxIterations?: number;
	check?: AgentCheck;
}> {
	// The round's cap and check, under each task's own. Read up front so a
	// check that cannot parse refuses the round before any worker starts.
	const round = workerControls(input);
	if (input.tasks && input.tasks.length > 0) {
		return input.tasks.map((entry, index) => {
			const sampling = workerSampling(input, index, entry);
			const controls = { ...round, ...workerControls(entry) };
			return {
				name: entry.name?.trim() || `worker-${index + 1}`,
				task: entry.task,
				...(entry.systemPrompt ? { systemPrompt: entry.systemPrompt } : {}),
				...(entry.tools ? { tools: entry.tools } : {}),
				...(sampling ? { sampling } : {}),
				...controls,
			};
		});
	}
	const task = input.task?.trim();
	if (!task) {
		return [];
	}
	const count = typeof input.count === "number" ? input.count : 1;
	return Array.from({ length: Math.max(1, count) }, (_entry, index) => ({
		name: `worker-${index + 1}`,
		task,
		...round,
	}));
}

/** A task's (or the round's) `max_iterations` and `check`, when set. */
function workerControls(entry: unknown): {
	maxIterations?: number;
	check?: AgentCheck;
} {
	const record = (entry ?? {}) as { check?: unknown };
	const maxIterations = maxIterationsOf(entry);
	const check = readAgentCheck(record.check);
	return {
		...(maxIterations !== undefined ? { maxIterations } : {}),
		...(check ? { check } : {}),
	};
}

/**
 * Worker `index`'s sampler: the swarm's, its seed offset by the index so that
 * workers on one task do not draw identical samples, under the task's own.
 */
export function workerSampling(
	input: Pick<SpawnSwarmInput, "temperature" | "seed" | "temperature_range">,
	index: number,
	task?: unknown,
): SpawnSampling | undefined {
	return mergeSpawnSampling(
		samplingForCopy(readSpawnSampling(input), index),
		readSpawnSampling(task),
	);
}

/**
 * What the reducer is asked to do.
 *
 * It runs attached to the same pool the workers did, so it already knows
 * everything the lead knows -- which is why the prompt can tell it to be short
 * rather than complete. "Done as planned" costs a line there and a paragraph
 * anywhere else.
 */
export const SWARM_REDUCER_PROMPT = `You are merging the reports of several agents that worked in parallel on one task, and you already hold the context they were given — so do not restate it.

Write ONE report in the same form they used, as a fenced json block with any of these keys: goal, done, in_progress, ruled_out, key_facts, next, notes.

Rules:
- Keep every specific: paths, symbols, error text, commands, numbers. A detail you drop has to be rediscovered.
- Where two agents found the same thing, say it once.
- Where they disagree, say so and say who found what. Do not pick a winner.
- An agent that reported an error or nothing must still appear, in notes, by name.
- Do not add findings none of them reported.`;

/** A worker's result, as its round and its row record it. */
function swarmMemberOutput(
	name: string,
	result: SwarmWorkerResult,
): SwarmMemberReport & RoundMemberOutput {
	const failed =
		result.finishReason === "error" || result.finishReason === "aborted";
	return {
		name,
		text: result.text,
		finishReason: result.finishReason,
		iterations: result.iterations,
		usage: {
			inputTokens: result.usage?.inputTokens ?? 0,
			outputTokens: result.usage?.outputTokens ?? 0,
		},
		...(result.model
			? { model: { provider: result.model.provider, id: result.model.id } }
			: {}),
		...(result.placed ? result.placed : {}),
		...(result.sampling ? { sampling: result.sampling } : {}),
		...(result.maxIterations !== undefined
			? { maxIterations: result.maxIterations }
			: {}),
		...(result.stopReason ? { stopReason: result.stopReason } : {}),
		...(result.state ? { state: result.state } : {}),
		...(result.agentId ? { agentId: result.agentId } : {}),
		...(result.oracle ? { oracle: result.oracle } : {}),
		...(failed
			? {
					error:
						result.text.trim() ||
						(result.finishReason === "aborted"
							? "stopped"
							: "failed without saying why"),
				}
			: {}),
	};
}

/**
 * One worker, under a control of its own: restartable from its row and by the
 * lead, requeueable, messageable. A worker releases its own engine session
 * when its run ends, restarted or not.
 */
async function runSwarmWorker(
	config: SpawnSwarmToolConfig,
	request: SwarmWorkerRequest,
	context: AgentToolContext,
	options: {
		poolId?: string;
		/** Registered already, so its row's stop worked while it queued. */
		registration?: SubagentCancellationRegistration;
		/** Tells the round which control is this worker's. */
		bind?: (cancelId: string) => void;
	},
): Promise<SwarmWorkerResult> {
	const cancelId = subagentCancelId(context.sessionId, context.toolCallId);
	const cancellation =
		options.registration ??
		registerSubagentCancellation(cancelId, context.signal, request.name);
	if (cancelId && !options.registration) {
		options.bind?.(cancelId);
	}
	const emitUpdate = context.emitUpdate;
	try {
		return await cancellation.restartable(
			() =>
				config.runWorker({
					...request,
					...(options.poolId ? { poolId: options.poolId } : {}),
					...(emitUpdate ? { emitUpdate } : {}),
					...(cancellation.signal ? { signal: cancellation.signal } : {}),
					takeMessage: cancellation.takeMessage,
					control: cancellation,
				}),
			() => restarted(emitUpdate, undefined),
		);
	} finally {
		if (!options.registration) {
			cancellation.release();
		}
	}
}

export function createSpawnSwarmTool(
	config: SpawnSwarmToolConfig,
): AgentTool<SpawnSwarmInput, SpawnSwarmOutput> {
	// A worker of this session's rounds can be run again from its record:
	// its task, role, tools and sampler. Its pool is gone with its round, so
	// it runs unpooled and prefills its own prefix.
	if (config.sessionId !== undefined) {
		roundsFor(config.sessionId).registerRunner(
			"swarm",
			async ({ round, agent, task, context }) => {
				const result = await runSwarmWorker(
					config,
					{
						name: agent.name,
						task,
						systemPrompt: agent.systemPrompt ?? round.shared.systemPrompt ?? "",
						...(agent.tools ? { tools: agent.tools } : {}),
						...(agent.sampling ? { sampling: agent.sampling } : {}),
						...workerControls({
							...(agent.maxIterations !== undefined
								? { max_iterations: agent.maxIterations }
								: {}),
							...(agent.check !== undefined ? { check: agent.check } : {}),
						}),
					},
					context,
					{},
				);
				return swarmMemberOutput(agent.name, result);
			},
		);
	}
	const ceiling = Math.max(1, config.maxWorkers ?? DEFAULT_MAX_SWARM_WORKERS);
	const tickMs = Math.max(0, config.tickMs ?? DEFAULT_SWARM_TICK_MS);
	/**
	 * A tick that can be cancelled when it loses the race.
	 *
	 * The supervisor waits on "a worker finishes, or the tick" — and a worker
	 * finishing is the common case, so a plain `setTimeout` would leave one
	 * pending timer per loop iteration. On a thirty-worker round that is thirty
	 * live timers holding the process up for five seconds after the last
	 * answer.
	 */
	const waitForTick =
		config.sleep !== undefined
			? (ms: number) => ({ promise: config.sleep!(ms), cancel: () => {} })
			: (ms: number) => {
					let handle: ReturnType<typeof setTimeout> | undefined;
					const promise = new Promise<void>((resolve) => {
						handle = setTimeout(resolve, ms);
					});
					return {
						promise,
						cancel: () => {
							if (handle !== undefined) {
								clearTimeout(handle);
							}
						},
					};
				};

	return createTool<SpawnSwarmInput, SpawnSwarmOutput>({
		name: "spawn_swarm",
		description:
			"Run several agents at once on a shared copy of your current context, and get back one merged report. " +
			"Use it when a task splits into parts that do not depend on each other — searching a repo several ways, checking several files, trying several approaches. " +
			"Give `tasks` when the workers should do different things, or `task` with `count` to fan the same question out. " +
			'`count: "max"` means as many as the server will take right now; that is what to pass when asked for as many agents as possible. ' +
			"Workers start as the server admits them and the rest wait their turn, so a long task list or `max` overloads nothing; the round just takes longer. " +
			"A swarm is one round: its workers are made for it, run once, and are gone when the digest comes back — there is nobody left to send a second task to. Work that is a known list of jobs, each wanting a worker you keep talking to, is a team instead. " +
			SPAWN_SAMPLING_NOTE +
			AGENT_CONTROLS_NOTE +
			"Output: `{digest, workers, pooled, usage}`. `digest` is the whole result — the workers' own transcripts are discarded, so nothing they saw reaches you except through it.",
		inputSchema: zodToJsonSchema(SpawnSwarmInputSchema),
		execute: async (input, context?: AgentToolContext) => {
			const requested = requestedWorkers(input);
			if (requested.length === 0) {
				return {
					digest: "No task was given, so no workers ran.",
					workers: 0,
					pooled: false,
					usage: { inputTokens: 0, outputTokens: 0 },
				};
			}

			const probe = config.pools.admit;
			const headroom = await config.pools.headroom().catch(() => undefined);

			// How much work there is to do. An explicit task list is the work
			// and bounds the round however much room the engine has; a single
			// task repeated is bounded by the engine instead, which is what
			// `max` asks for.
			const explicit = input.tasks && input.tasks.length > 0;
			// A row per worker wherever the workers are known up front: a task
			// list, or one task repeated a stated number of times. Only
			// `count: "max"` leaves the number to the engine, and its workers
			// share the call's one row. Rowed as one before, a count of 15
			// showed as a single agent while fifteen ran.
			const rowed = explicit || typeof input.count === "number";
			const hint = Math.max(
				1,
				Math.min(
					ceiling,
					input.count === "max" ? (headroom ?? 1) : requested.length,
					headroom ?? Number.POSITIVE_INFINITY,
				),
			);
			const queueLength = explicit
				? requested.length
				: probe
					? // The engine decides, and the guard only stops a spin.
						input.count === "max"
						? SWARM_RUNAWAY_MAX
						: Math.min(requested.length, SWARM_RUNAWAY_MAX)
					: hint;
			// A swarm runs beside the lead unless it asks to wait: the lead
			// keeps working, and the round's report is delivered when it ends.
			const background = input.wait !== true;
			const rounds = roundsFor(context?.sessionId);
			const handle = rounds.open({
				kind: "swarm",
				tool: "spawn_swarm",
				...(context?.toolCallId ? { toolCallId: context.toolCallId } : {}),
				background,
				shared: {
					systemPrompt: input.systemPrompt,
					...(readSpawnSampling(input)
						? { sampling: readSpawnSampling(input) }
						: {}),
				},
				// Known up front when rowed; `max` adds its workers as it
				// launches them.
				agents: rowed
					? requested.slice(0, queueLength).map((entry) => ({
							name: entry.name,
							task: entry.task,
							...(entry.systemPrompt
								? { systemPrompt: entry.systemPrompt }
								: {}),
							...(entry.tools ? { tools: entry.tools } : {}),
							...(entry.sampling ? { sampling: entry.sampling } : {}),
							...(entry.maxIterations !== undefined
								? { maxIterations: entry.maxIterations }
								: {}),
							...(entry.check ? { check: entry.check } : {}),
						}))
					: [],
				...(background
					? {}
					: context?.signal
						? { signal: context.signal }
						: {}),
				...(context?.emitUpdate ? { emitUpdate: context.emitUpdate } : {}),
				rowed,
			});
			// Each worker of a task list has a row of its own in the host, keyed
			// by the call and its index, and a stop of its own under the same
			// pair -- registered now, so its row's stop works while it queues.
			// A task repeated `count: "max"` times has one row, the call's, and
			// one stop that reaches every worker on it -- and each worker still
			// has a control of its own, under the call's, for the lead.
			const memberCancellations = new Map<
				number,
				SubagentCancellationRegistration
			>();
			const callCancellation = rowed
				? undefined
				: registerSubagentCancellation(
						subagentCancelId(context?.sessionId, context?.toolCallId),
						handle.signal,
					);
			const callCancelId = rowed
				? undefined
				: subagentCancelId(context?.sessionId, context?.toolCallId);
			if (callCancelId && callCancellation?.signal) {
				context?.emitUpdate?.({ cancelId: callCancelId, queued: true });
			}
			const memberCallId = (member: number) =>
				context?.toolCallId
					? `${context.toolCallId}#${rowed ? member : `w${member}`}`
					: undefined;
			if (rowed) {
				requested.slice(0, queueLength).forEach((entry, index) => {
					const cancelId = subagentCancelId(
						context?.sessionId,
						memberCallId(index),
					);
					const registration = registerSubagentCancellation(
						cancelId,
						handle.signal,
						entry.name,
					);
					memberCancellations.set(index, registration);
					if (cancelId && registration.signal) {
						handle.bindControl(index, cancelId);
						// Waiting its turn until the supervisor launches it: every row
						// otherwise starts as "running", and a round of 75 showed 75
						// agents at work while four of them were.
						context?.emitUpdate?.({ cancelId, queued: true, member: index });
					}
				});
			}

			const queue: Array<SwarmWorkerRequest & { member: number }> = explicit
				? requested.slice(0, queueLength).map((entry, index) => ({
						member: index,
						name: entry.name ?? `worker-${index + 1}`,
						task: entry.task,
						systemPrompt: entry.systemPrompt ?? input.systemPrompt,
						...(entry.tools ? { tools: entry.tools } : {}),
						...(entry.sampling ? { sampling: entry.sampling } : {}),
						...(entry.maxIterations !== undefined
							? { maxIterations: entry.maxIterations }
							: {}),
						...(entry.check ? { check: entry.check } : {}),
					}))
				: Array.from({ length: queueLength }, (_entry, index) => {
						const sampling = workerSampling(input, index);
						const first = requested[0];
						return {
							member: index,
							name: `worker-${index + 1}`,
							task: first?.task ?? "",
							systemPrompt: input.systemPrompt,
							...(sampling ? { sampling } : {}),
							...(first?.maxIterations !== undefined
								? { maxIterations: first.maxIterations }
								: {}),
							...(first?.check ? { check: first.check } : {}),
						};
					});

			// Taken before any worker starts, for the reason at the top of this
			// file: the host prompt cache clears an idle slot the moment a new
			// task launches, and the snapshot is of that slot. Taken before the
			// call returns, too, when the round runs in the background: it is
			// the lead's context as it was when it asked.
			const snapshot = await config.pools.snapshot().catch(() => undefined);

			const runRound = async (): Promise<SpawnSwarmOutput> => {
				const reports: SwarmMemberReport[] = [];
				let inputTokens = 0;
				let outputTokens = 0;
				// The supervisor. Launch while the engine says yes and work is
				// left; when it says no, wait for a worker to finish or for the
				// tick, then ask again. A slot that frees mid-round belongs to
				// this swarm as much as one that was free at the start.
				const results: WorkDigest[] = [];
				// What each sandboxed worker handed back, for the report: the
				// digest is rewritten by the fold or the reducer, and neither
				// keeps a worker's note about where its changes went.
				const handbacks: SwarmHandback[] = [];
				const inFlight = new Set<Promise<void>>();
				let started = 0;
				// Round index per queue member: `max` adds its workers as they
				// launch.
				const roundIndex = new Map<number, number>();
				const indexOf = (worker: { member: number } & RoundAgentSpec) => {
					let index = roundIndex.get(worker.member);
					if (index === undefined) {
						index = rowed
							? worker.member
							: handle.add({
									name: worker.name,
									task: worker.task,
									...(worker.systemPrompt
										? { systemPrompt: worker.systemPrompt }
										: {}),
									...(worker.sampling ? { sampling: worker.sampling } : {}),
									...(worker.maxIterations !== undefined
										? { maxIterations: worker.maxIterations }
										: {}),
									...(worker.check ? { check: worker.check } : {}),
								});
						roundIndex.set(worker.member, index);
					}
					return index;
				};
				const record = (
					member: number,
					entry: SwarmMemberReport,
					index: number | undefined,
				): void => {
					const agent = index !== undefined ? handle.agent(index) : undefined;
					const withFacts = agent
						? {
								...entry,
								id: agent.id,
								state: agent.state,
								...(agent.stopReason ? { stopReason: agent.stopReason } : {}),
							}
						: entry;
					if (rowed) {
						reports[member] = withFacts;
						reportSubagentFinished(
							context?.emitUpdate &&
								((update: unknown) =>
									context.emitUpdate?.({
										...(update as Record<string, unknown>),
										member,
									})),
							withFacts,
						);
					}
				};

				const launch = (
					worker: SwarmWorkerRequest & { member: number },
				): void => {
					started += 1;
					const { member, ...request } = worker;
					const index = indexOf(worker as never);
					const registration = memberCancellations.get(member);
					const running = (async () => {
						if (
							handle.signal.aborted ||
							callCancellation?.signal?.aborted ||
							registration?.signal?.aborted
						) {
							registration?.release();
							const error = "stopped before it started";
							handle.never(index, error);
							record(member, { name: worker.name, error }, index);
							results.push({ agent: worker.name, error });
							return;
						}
						const memberContext: AgentToolContext = {
							...(context ??
								({ agentId: "", iteration: 0 } as AgentToolContext)),
							signal: callCancellation?.signal ?? handle.signal,
							...(memberCallId(member)
								? { toolCallId: memberCallId(member) }
								: {}),
						};
						let failed: unknown;
						const output = await handle.run(
							index,
							memberContext,
							async (ctx) => {
								try {
									const result = await runSwarmWorker(config, request, ctx, {
										...(snapshot ? { poolId: snapshot.poolId } : {}),
										...(registration ? { registration } : {}),
										bind: (cancelId) => handle.bindControl(index, cancelId),
									});
									const handed = handbackOf(result);
									if (handed) {
										handbacks.push({ name: worker.name, handed });
									}
									inputTokens += result.usage?.inputTokens ?? 0;
									outputTokens += result.usage?.outputTokens ?? 0;
									results.push(
										withControls(digestOf(worker.name, result), result),
									);
									return swarmMemberOutput(worker.name, result);
								} catch (error) {
									failed = error;
									const handed = handbackOf(error);
									if (handed) {
										handbacks.push({ name: worker.name, handed });
									}
									throw error;
								} finally {
									registration?.release();
								}
							},
						);
						if (failed !== undefined) {
							// Named, never dropped: the lead cannot tell an empty
							// round from a lost one otherwise.
							results.push({
								agent: worker.name,
								error: output.error ?? "failed",
							} satisfies WorkDigest);
						}
						record(member, output as SwarmMemberReport, index);
					})();
					const tracked = running.finally(() => {
						inFlight.delete(tracked);
					});
					inFlight.add(tracked);
				};

				while (queue.length > 0 || inFlight.size > 0) {
					while (queue.length > 0 && started < SWARM_RUNAWAY_MAX) {
						if (handle.signal.aborted) {
							break;
						}
						if (probe) {
							if (!(await probe.call(config.pools))) {
								break;
							}
						} else if (inFlight.size >= hint) {
							// No probe, so the hint is the only bound there is.
							break;
						}
						const next = queue.shift();
						if (!next) {
							break;
						}
						launch(next);
					}
					if (inFlight.size === 0) {
						// Nothing running and nothing admitted. If work remains
						// the engine is simply full, so wait rather than spin --
						// but with nothing outstanding there is no release
						// coming, and waiting forever is worse than stopping.
						break;
					}
					// Whichever comes first: a worker finishing, which frees a
					// slot, or the tick, which is the fallback when the engine
					// freed one for some other reason.
					const tick = waitForTick(tickMs);
					try {
						await Promise.race([Promise.race([...inFlight]), tick.promise]);
					} finally {
						tick.cancel();
					}
				}
				await Promise.allSettled([...inFlight]);
				// Asked for and never run: the round stopped with work left.
				// Each one is named, in the digest and on its row.
				for (const worker of queue) {
					memberCancellations.get(worker.member)?.release();
					const error = handle.signal.aborted
						? "stopped before it started"
						: "never started: no node had room when the round ended";
					if (rowed) {
						handle.never(worker.member, error);
						results.push({ agent: worker.name, error });
						record(worker.member, { name: worker.name, error }, worker.member);
					}
				}
				// A restart or retry of a worker from the lead runs before the
				// round reports: the lead gets the run that counts.
				await handle.idle();
				if (rowed) {
					requested.slice(0, queueLength).forEach((entry, index) => {
						reports[index] ??= {
							name: entry.name ?? `worker-${index + 1}`,
							error: "never started",
						};
					});
				}

				let merged: WorkDigest | undefined;
				if (results.length > 1 && config.reduce) {
					merged = await config
						.reduce(results, {
							handedBack: (name, handed) => {
								handbacks.push({ name, handed });
							},
						})
						.catch(() => undefined);
				}
				const digest = merged ?? mergeWorkDigests(results);

				return {
					round: handle.id,
					digest: renderWorkDigest(digest) + swarmHandbackNote(handbacks),
					workers: started,
					pooled: snapshot !== undefined,
					usage: { inputTokens, outputTokens },
					agents: handle.record.agents.map((agent) => ({
						id: agent.id,
						name: agent.name,
						state: agent.state,
						...(agent.stopReason ? { stop: agent.stopReason } : {}),
						facts: agentFactsLine(agent),
					})),
					...(rowed ? { results: reports } : {}),
				};
			};

			const finish = async () => {
				callCancellation?.release();
				for (const registration of memberCancellations.values()) {
					registration.release();
				}
				// The leak this whole change set exists to stop. On the failure
				// paths too.
				await snapshot?.release().catch(() => {});
			};

			if (background) {
				void runRound()
					.then((output) => {
						handle.setReport(JSON.stringify(output), output.digest);
					})
					.catch(() => undefined)
					.finally(async () => {
						await finish();
						handle.close();
					});
				return {
					...backgroundAck(handle),
					digest: `Round ${handle.id} runs in the background; the merged report is delivered to you when it ends.`,
					workers: 0,
					pooled: snapshot !== undefined,
					usage: { inputTokens: 0, outputTokens: 0 },
				};
			}
			const leave = rounds.enterBlocking();
			try {
				const output = await runRound();
				handle.setReport(JSON.stringify(output), output.digest);
				handle.delivered();
				return output;
			} finally {
				leave();
				await finish();
				handle.close();
			}
		},
		timeoutMs: 600_000,
		retryable: false,
	});
}

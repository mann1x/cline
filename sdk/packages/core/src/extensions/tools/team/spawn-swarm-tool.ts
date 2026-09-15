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
	 */
	headroom(): Promise<number | undefined>;
}

export interface SwarmWorkerRequest {
	name: string;
	task: string;
	systemPrompt: string;
	/** The shared pool, when there is one. */
	poolId?: string;
}

export interface SpawnSwarmToolConfig {
	pools: SwarmPoolSource;
	/** Run one worker to completion. */
	runWorker: (request: SwarmWorkerRequest) => Promise<AgentResult>;
	/**
	 * Rewrite several digests into one, with a model that knows what the lead
	 * knows because it was forked from the same pool.
	 *
	 * Optional: without it, and whenever it fails, the digests are folded
	 * mechanically instead. That fold is lossless where the model's is not, so
	 * it is a fallback worth having rather than a degraded mode.
	 */
	reduce?: (digests: readonly WorkDigest[]) => Promise<WorkDigest | undefined>;
	/** Most workers this will ever run, whatever the model or engine says. */
	maxWorkers?: number;
}

/** A swarm this size stops being a fan-out and starts being a stampede. */
export const DEFAULT_MAX_SWARM_WORKERS = 8;

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

function requestedWorkers(input: SpawnSwarmInput): Array<{
	name: string;
	task: string;
}> {
	if (input.tasks && input.tasks.length > 0) {
		return input.tasks.map((entry, index) => ({
			name: entry.name?.trim() || `worker-${index + 1}`,
			task: entry.task,
		}));
	}
	const task = input.task?.trim();
	if (!task) {
		return [];
	}
	const count = typeof input.count === "number" ? input.count : 1;
	return Array.from({ length: Math.max(1, count) }, (_entry, index) => ({
		name: `worker-${index + 1}`,
		task,
	}));
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

export function createSpawnSwarmTool(
	config: SpawnSwarmToolConfig,
): AgentTool<SpawnSwarmInput, SpawnSwarmOutput> {
	const ceiling = Math.max(1, config.maxWorkers ?? DEFAULT_MAX_SWARM_WORKERS);

	return createTool<SpawnSwarmInput, SpawnSwarmOutput>({
		name: "spawn_swarm",
		description:
			"Run several agents at once on a shared copy of your current context, and get back one merged report. " +
			"Use it when a task splits into parts that do not depend on each other — searching a repo several ways, checking several files, trying several approaches. " +
			"Give `tasks` when the workers should do different things, or `task` with `count` to fan the same question out. " +
			'`count: "max"` means as many as the server will take right now; that is what to pass when asked for as many agents as possible. ' +
			"Output: `{digest, workers, pooled, usage}`. `digest` is the whole result — the workers' own transcripts are discarded, so nothing they saw reaches you except through it.",
		inputSchema: zodToJsonSchema(SpawnSwarmInputSchema),
		execute: async (input) => {
			const requested = requestedWorkers(input);
			if (requested.length === 0) {
				return {
					digest: "No task was given, so no workers ran.",
					workers: 0,
					pooled: false,
					usage: { inputTokens: 0, outputTokens: 0 },
				};
			}

			// The engine's number bounds the round. `max` takes it; an explicit
			// count is an upper bound of the caller's that it also bounds --
			// the server knowing it cannot take eight is not overridden by a
			// model asking for eight.
			const headroom = await config.pools.headroom().catch(() => undefined);
			const wanted = input.count === "max" ? (headroom ?? 1) : requested.length;
			const workerCount = Math.max(
				1,
				Math.min(
					ceiling,
					wanted,
					headroom ?? Number.POSITIVE_INFINITY,
					input.tasks && input.tasks.length > 0
						? requested.length
						: Number.POSITIVE_INFINITY,
				),
			);
			const workers =
				input.tasks && input.tasks.length > 0
					? requested.slice(0, workerCount)
					: Array.from({ length: workerCount }, (_entry, index) => ({
							name: `worker-${index + 1}`,
							task: requested[0]?.task ?? "",
						}));

			// Taken before any worker starts, for the reason at the top of this
			// file: the host prompt cache clears an idle slot the moment a new
			// task launches, and the snapshot is of that slot.
			const snapshot = await config.pools.snapshot().catch(() => undefined);

			let inputTokens = 0;
			let outputTokens = 0;

			try {
				const results = await Promise.all(
					workers.map(async (worker) => {
						try {
							const result = await config.runWorker({
								name: worker.name,
								task: worker.task,
								systemPrompt: input.systemPrompt,
								...(snapshot ? { poolId: snapshot.poolId } : {}),
							});
							inputTokens += result.usage?.inputTokens ?? 0;
							outputTokens += result.usage?.outputTokens ?? 0;
							return digestOf(worker.name, result);
						} catch (error) {
							// Named, never dropped: the lead cannot tell an
							// empty round from a lost one otherwise.
							return {
								agent: worker.name,
								error: error instanceof Error ? error.message : String(error),
							} satisfies WorkDigest;
						}
					}),
				);

				let merged: WorkDigest | undefined;
				if (results.length > 1 && config.reduce) {
					merged = await config.reduce(results).catch(() => undefined);
				}
				const digest = merged ?? mergeWorkDigests(results);

				return {
					digest: renderWorkDigest(digest),
					workers: workers.length,
					pooled: snapshot !== undefined,
					usage: { inputTokens, outputTokens },
				};
			} finally {
				// The leak this whole change set exists to stop. On the failure
				// paths too.
				await snapshot?.release().catch(() => {});
			}
		},
		timeoutMs: 600_000,
		retryable: false,
	});
}

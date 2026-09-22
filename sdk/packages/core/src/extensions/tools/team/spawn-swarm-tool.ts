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
	/**
	 * How long the supervisor waits before asking again, when nothing has
	 * finished and the engine last said no.
	 */
	tickMs?: number;
	/** Test seam. */
	sleep?: (ms: number) => Promise<void>;
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
			"A swarm is one round: its workers are made for it, run once, and are gone when the digest comes back — there is nobody left to send a second task to. Work that is a known list of jobs, each wanting a worker you keep talking to, is a team instead. " +
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

			const probe = config.pools.admit;
			const headroom = await config.pools.headroom().catch(() => undefined);

			// How much work there is to do. An explicit task list is the work
			// and bounds the round however much room the engine has; a single
			// task repeated is bounded by the engine instead, which is what
			// `max` asks for.
			const explicit = input.tasks && input.tasks.length > 0;
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
			const queue: SwarmWorkerRequest[] = explicit
				? requested.slice(0, queueLength).map((entry, index) => ({
						name: entry.name ?? `worker-${index + 1}`,
						task: entry.task,
						systemPrompt: input.systemPrompt,
					}))
				: Array.from({ length: queueLength }, (_entry, index) => ({
						name: `worker-${index + 1}`,
						task: requested[0]?.task ?? "",
						systemPrompt: input.systemPrompt,
					}));

			// Taken before any worker starts, for the reason at the top of this
			// file: the host prompt cache clears an idle slot the moment a new
			// task launches, and the snapshot is of that slot.
			const snapshot = await config.pools.snapshot().catch(() => undefined);

			let inputTokens = 0;
			let outputTokens = 0;

			try {
				// The supervisor. Launch while the engine says yes and work is
				// left; when it says no, wait for a worker to finish or for the
				// tick, then ask again. A slot that frees mid-round belongs to
				// this swarm as much as one that was free at the start.
				const results: WorkDigest[] = [];
				const inFlight = new Set<Promise<void>>();
				let started = 0;

				const launch = (worker: SwarmWorkerRequest): void => {
					started += 1;
					const running = (async () => {
						try {
							const result = await config.runWorker({
								...worker,
								...(snapshot ? { poolId: snapshot.poolId } : {}),
							});
							inputTokens += result.usage?.inputTokens ?? 0;
							outputTokens += result.usage?.outputTokens ?? 0;
							results.push(digestOf(worker.name, result));
						} catch (error) {
							// Named, never dropped: the lead cannot tell an
							// empty round from a lost one otherwise.
							results.push({
								agent: worker.name,
								error: error instanceof Error ? error.message : String(error),
							} satisfies WorkDigest);
						}
					})();
					const tracked = running.finally(() => {
						inFlight.delete(tracked);
					});
					inFlight.add(tracked);
				};

				while (queue.length > 0 || inFlight.size > 0) {
					while (queue.length > 0 && started < SWARM_RUNAWAY_MAX) {
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

				let merged: WorkDigest | undefined;
				if (results.length > 1 && config.reduce) {
					merged = await config.reduce(results).catch(() => undefined);
				}
				const digest = merged ?? mergeWorkDigests(results);

				return {
					digest: renderWorkDigest(digest),
					workers: started,
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

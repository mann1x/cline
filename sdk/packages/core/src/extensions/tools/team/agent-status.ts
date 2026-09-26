/**
 * `agents_status`: what the lead's agents are doing, and why.
 *
 * Read-only, and offered in every mode the lead can be in -- its own turn
 * beside a background round, the side turn while a blocking round runs, and
 * an escalation's expert (spec B, rulings 3 and 6). Three shapes:
 *
 * - no arguments: a summary -- per round, how many agents are in each state
 *   and for how long the round has run; per node, what it runs, whether it
 *   answers, how full it is, its admission policy and recent refusals, and
 *   the retry policy in words;
 * - `round_id`: one line per agent of that round;
 * - `agent_id` (or several): an agent in detail -- its state and the reason
 *   for it, node, model, window, tokens, speed, iterations against its cap,
 *   compactions by cause, sampler, the oracle's verdict, the tail of its
 *   output and of its activity, and its errors with their class.
 *
 * Bounded: never a transcript, and never more than {@link STATUS_MAX_CHARS}.
 * Everything it says comes from what is already known -- the round records,
 * the placement queue, and the last `/kv` read the compaction trigger made.
 * It never asks a server anything.
 */

import {
	latestOpencotiKv,
	latestOpencotiPressure,
	polykvAdmissionPolicy,
} from "@cline/llms";
import type {
	AgentTool,
	TeamMemberSnapshot,
	TeamRunRecord,
} from "@cline/shared";
import type { AgentNodeStatus } from "./agent-node-placement";
import { MAX_NODE_PLACEMENT_ATTEMPTS } from "./agent-placement-queue";
import {
	type AgentRounds,
	type AgentRunState,
	LIVE_STATES,
	oracleWords,
	type RoundAgentRecord,
	type RoundRecord,
	roundsFor,
} from "./agent-rounds";
import type { DelegatedAgentConfigProvider } from "./delegated-agent";
import { REFUSED_HOLD_MAX_MS } from "./placed-run";

export const AGENTS_STATUS_TOOL_NAME = "agents_status";

/** The most a status answer may take. */
export const STATUS_MAX_CHARS = 12_000;
/** Rounds the summary lists one by one; older ones are counted. */
const SUMMARY_ROUNDS = 8;
/** Activity lines an agent's detail shows. */
const DETAIL_ACTIVITY = 8;
/** Agents one detail call covers. */
const DETAIL_MAX_AGENTS = 6;

/**
 * How the harness treats infrastructure trouble, in words, for the lead:
 * it must not try to route around a node itself (ruling 1).
 */
export const RETRY_POLICY_TEXT = `Retry policy: refusals and unreachable nodes are retried with backoff -- a refused agent goes back to the front of the queue and the node is held for up to ${Math.round(REFUSED_HOLD_MAX_MS / 1000)} s; a node that does not answer is out of rotation and probed every few seconds until it does. Agents never fail on infrastructure, and there is no per-agent time limit. Only a node without the model is skipped for longer, and ${MAX_NODE_PLACEMENT_ATTEMPTS} of those in a row is the agent's own failure. Placement is the harness's: to move an agent, requeue it; it is never routed by hand.`;

/** A teammate, as the team runtime reports it. */
export interface TeammateStatusSource {
	members: TeamMemberSnapshot[];
	runs: TeamRunRecord[];
}

export interface AgentsStatusOptions {
	sessionId: string;
	/** The session's delegated connection: its nodes, or its single endpoint. */
	configProvider?: () => DelegatedAgentConfigProvider | undefined;
	/** The team, when the session has teammates. */
	teammates?: () => TeammateStatusSource | undefined;
	now?: () => number;
}

function clock(at: number): string {
	return new Date(at).toISOString().slice(11, 19);
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	}
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function count(value: number): string {
	return Intl.NumberFormat("en-US").format(Math.round(value));
}

function short(value: number): string {
	return value >= 10_000
		? `${Math.round(value / 1000)}k`
		: value >= 1_000
			? `${(value / 1000).toFixed(1)}k`
			: String(Math.round(value));
}

function oneLine(text: string | undefined, max: number): string {
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The live state of an agent: its record, with its control's say. */

/** The check (section E): what it runs, and what it said. */
function describeCheck(agent: RoundAgentRecord): string {
	const oracle = agent.oracle;
	if (oracle) {
		const what = `\`${oracle.command}\` must ${oracle.must === "not_match" ? "not match" : "match"} /${oracle.expect}/`;
		const tailText = oracle.output?.trim()
			? `\n  output (tail): ${oneLine(oracle.output.slice(-400), 400)}`
			: "";
		return `check: ${oracleWords(oracle)} -- ${what}, judged ${oracle.runs} time${oracle.runs === 1 ? "" : "s"}${
			oracle.reason && oracle.status !== "not_run"
				? ` (${oneLine(oracle.reason, 120)})`
				: ""
		}${tailText}`;
	}
	const check = agent.check as { command?: unknown } | undefined;
	if (check) {
		return `check: set (\`${typeof check.command === "string" ? check.command : "?"}\`), not judged yet`;
	}
	return "check: none";
}

/** Why an agent is where it is, in words (ruling 6). */
export function describeReason(
	agent: RoundAgentRecord,
	state: AgentRunState,
	now: number,
): string {
	switch (state) {
		case "waiting_infra": {
			const wait = agent.waiting;
			if (!wait) {
				return "waiting on infrastructure";
			}
			const since = `since ${clock(wait.since)}Z (${formatDuration(now - wait.since)})`;
			if (wait.kind === "refusal") {
				const floor = /tps below floor/i.test(wait.detail)
					? "the admission floor: "
					: /allocation|window|cells/i.test(wait.detail)
						? "KV room: "
						: "";
				return `waiting on infrastructure: refused by ${wait.where} (${floor}"${oneLine(wait.detail, 160)}"), retrying ${since}`;
			}
			return `waiting on infrastructure: ${wait.where} ${oneLine(wait.detail, 80) || "not answering"}, retrying ${since}`;
		}
		case "awaiting_lead":
			if (agent.awaitingReason === "struggling") {
				return `STRUGGLING: the struggle supervisor stopped it after it was told to commit a SUMMARY and went on, after ${agent.iterations ?? "?"} iterations, its work kept${
					agent.stopDetail ? ` (${oneLine(agent.stopDetail, 200)})` : ""
				}; resume_agent(agent_id, extra_iterations, instructions) continues it -- say what to settle for -- restart_agent(agent_id, instructions) starts it over, stop_agents takes its work as it is`;
			}
			if (agent.awaitingReason === "looping") {
				return `LOOPING: the loop guard stopped it for sending the same call again after its warning, after ${agent.iterations ?? "?"} iterations, its work kept${
					agent.stopDetail ? ` (${oneLine(agent.stopDetail, 200)})` : ""
				}; resume_agent(agent_id, extra_iterations, instructions) continues it -- say what to do instead of that call -- restart_agent(agent_id, instructions) starts it over, stop_agents takes its work as it is`;
			}
			return `stopped at its ${agent.maxIterations ?? "?"}-iteration cap after ${agent.iterations ?? agent.maxIterations ?? "?"} iterations, its work kept; resume_agent(agent_id, extra_iterations) continues it, stop_agents takes its work as it is, restart_agent starts it over`;
		case "queued":
			return agent.requeues > 0
				? "queued again after a requeue, carrying its transcript"
				: "queued: waiting for a node with room";
		case "running":
			return "running";
		case "done":
			return agent.stopReason === "completed"
				? "finished"
				: `finished (${agent.stopReason})`;
		default: {
			const reason = agent.stopReason ?? state;
			const label: Record<string, string> = {
				iteration_cap: `reached its ${agent.maxIterations ?? "?"}-iteration cap`,
				looping:
					"the loop guard stopped it for repeating the same call, and it was ended there",
				struggling:
					"the struggle supervisor stopped it for grinding after its nudge, and it was ended there",
				context_overflow: "its context overflowed and could not be recovered",
				mistake_limit: "stopped by its own guard (repeated mistakes or a loop)",
				engine_error: "the engine returned an error it could not retry",
				task_error: "its own run failed",
				cancelled_by_lead: "cancelled by you (the lead)",
				cancelled_by_user: "cancelled by the user",
				cancelled_by_session:
					"cancelled because the lead's turn or the session was stopped",
				interrupted: "interrupted: the session was reloaded while it ran",
			};
			const detail = agent.stopDetail
				? `: ${oneLine(agent.stopDetail, 200)}`
				: "";
			return `${label[reason] ?? reason}${detail}`;
		}
	}
}

const STATE_ORDER: AgentRunState[] = [
	"running",
	"queued",
	"waiting_infra",
	"awaiting_lead",
	"done",
	"failed",
	"cancelled",
];

function roundCounts(round: RoundRecord): Record<AgentRunState, number> {
	const counts = Object.fromEntries(
		STATE_ORDER.map((state) => [state, 0]),
	) as Record<AgentRunState, number>;
	for (const agent of round.agents) {
		counts[agent.state] += 1;
	}
	return counts;
}

function roundLine(round: RoundRecord, now: number): string {
	const counts = roundCounts(round);
	const parts = STATE_ORDER.filter((state) => counts[state] > 0).map(
		(state) => `${state.replace("_", "-")} ${counts[state]}`,
	);
	const failures = round.agents
		.filter((agent) => agent.state === "failed" && agent.stopReason)
		.reduce<Record<string, number>>((acc, agent) => {
			const reason = agent.stopReason as string;
			acc[reason] = (acc[reason] ?? 0) + 1;
			return acc;
		}, {});
	const why = Object.entries(failures)
		.map(([reason, n]) => `${reason} ${n}`)
		.join(", ");
	const elapsed =
		round.status === "running"
			? `running ${formatDuration(now - round.createdAt)}`
			: `ended after ${formatDuration((round.endedAt ?? now) - round.createdAt)}`;
	return `${round.id} ${round.tool}${round.background ? " (background)" : ""} · ${elapsed} · ${round.agents.length} agent${round.agents.length === 1 ? "" : "s"}: ${parts.join(", ") || "none"}${why ? ` (failed: ${why})` : ""}`;
}

/** The PolyKV section of a connection's provider config, if it has one. */
function polykvSection(
	providerConfig: unknown,
): Record<string, unknown> | undefined {
	const section = (providerConfig as { polykv?: unknown } | undefined)?.polykv;
	return section && typeof section === "object"
		? (section as Record<string, unknown>)
		: undefined;
}

function isPolykvNode(node: {
	providerId?: string;
	providerConfig?: unknown;
}): boolean {
	return (
		node.providerId?.trim().toLowerCase() === "opencoti" ||
		polykvSection(node.providerConfig) !== undefined
	);
}

/** Admission policy, recent refusals and KV cells of a PolyKV node. */
function polykvLines(
	node: { baseUrl?: string; providerConfig?: unknown },
	now: number,
): string[] {
	const section = polykvSection(node.providerConfig);
	const policy =
		section && section.overcommit !== true
			? polykvAdmissionPolicy(section as never)
			: undefined;
	const lines: string[] = [];
	if (policy?.target_tps_per_session !== undefined) {
		lines.push(
			`admission: floor ${policy.target_tps_per_session} tok/s per session, ${policy.mode ?? "advisory"}${
				policy.mode === "enforced"
					? " (a new agent that would push the projected mean below it is refused and retried)"
					: " (reported, never refused)"
			}`,
		);
	} else {
		lines.push(
			section?.overcommit === true
				? "admission: overcommit (no floor sent)"
				: "admission: the engine's own default (no floor set by this profile)",
		);
	}
	const pressure = latestOpencotiPressure(node.baseUrl);
	if (pressure) {
		const age = formatDuration(now - pressure.at);
		const p = pressure.pressure;
		lines.push(
			`refusals: ${p.refused60s} in the last ${p.windowS} s${
				p.lastRefusalAgeS !== undefined
					? `, the last ${Math.round(p.lastRefusalAgeS)} s before the read`
					: ""
			}${p.refusalsTotal !== undefined ? `, ${count(p.refusalsTotal)} since boot` : ""} (read ${age} ago)`,
		);
	} else {
		lines.push("refusals: no /kv pressure read yet");
	}
	const kv = latestOpencotiKv(node.baseUrl);
	if (kv) {
		lines.push(
			`KV cells: ${count(kv.booked)} booked by ${kv.sessions} session${kv.sessions === 1 ? "" : "s"}${
				kv.cellsTotal !== undefined
					? ` of ${count(kv.cellsTotal)}${kv.cellsFree !== undefined ? `, ${count(kv.cellsFree)} free` : ""}`
					: ""
			} (read ${formatDuration(now - kv.at)} ago)`,
		);
	}
	return lines;
}

/** The nodes block of the summary. */
export function describeNodes(
	provider: DelegatedAgentConfigProvider | undefined,
	now: number,
): string[] {
	const runtime = provider?.getRuntimeConfig();
	const placement = runtime?.nodePlacement;
	const nodes: AgentNodeStatus[] | undefined = placement?.describe?.();
	if (!placement || !nodes) {
		if (!runtime) {
			return ["Nodes: none known."];
		}
		const connection = provider?.getConnectionConfig();
		const active = runtime.slotGate?.active();
		const node = {
			providerId: connection?.providerId,
			baseUrl: connection?.baseUrl,
			providerConfig: connection?.providerConfig,
		};
		return [
			`Nodes: none configured; agents run on the session's delegated connection, ${connection?.providerId}/${connection?.modelId}${
				active !== undefined ? ` (${active} running)` : ""
			}.`,
			...(isPolykvNode(node)
				? polykvLines(node, now).map((line) => `  ${line}`)
				: []),
		];
	}
	const lines = [
		`Nodes (${placement.waiting} agent${placement.waiting === 1 ? "" : "s"} waiting in the placement queue):`,
	];
	for (const node of nodes) {
		const name = node.label ? `${node.label} [${node.nodeId}]` : node.nodeId;
		const reach =
			node.downUntil !== undefined
				? `out of rotation until ${clock(node.downUntil)}Z (not answering, or without its model)`
				: "reachable";
		const held =
			node.heldUntil !== undefined
				? `; held after a refusal until ${clock(node.heldUntil)}Z`
				: "";
		const capacity = Number.isFinite(node.capacity)
			? `${node.running}/${node.capacity} slots in use`
			: `${node.running} running (no cap: the engine's admission decides)`;
		lines.push(
			`- ${name}, priority ${node.priority}: ${node.providerId}/${node.modelId}${
				node.baseUrl ? ` at ${node.baseUrl}` : ""
			} · ${reach} · ${capacity}${held}`,
		);
		if (isPolykvNode(node)) {
			for (const line of polykvLines(node, now)) {
				lines.push(`    ${line}`);
			}
		}
	}
	return lines;
}

function teammateLines(
	source: TeammateStatusSource | undefined,
	now: number,
): string[] {
	const teammates = source?.members.filter((m) => m.role === "teammate") ?? [];
	if (teammates.length === 0) {
		return [];
	}
	const lines = ["Teammates:"];
	for (const member of teammates) {
		const runs = (source?.runs ?? []).filter(
			(run) => run.agentId === member.agentId,
		);
		const current = runs.find(
			(run) => run.status === "running" || run.status === "queued",
		);
		const last = runs.at(-1);
		const activity = member.activity
			? ` · ${member.activity.toolCalls} tool calls, ${member.activity.compactions} compactions over its life`
			: "";
		lines.push(
			`- ${member.agentId}: ${member.status}${
				current
					? ` · run ${current.id} ${current.status} for ${formatDuration(now - new Date(current.startedAt).getTime())}${
							current.currentActivity ? ` (${current.currentActivity})` : ""
						}`
					: last
						? ` · last run ${last.id} ${last.status}${last.error ? `: ${oneLine(last.error, 100)}` : ""}`
						: ""
			}${activity}`,
		);
	}
	return lines;
}

/** The whole summary: rounds, nodes, retry policy, teammates. */
export function describeSummary(
	rounds: AgentRounds,
	options: Omit<AgentsStatusOptions, "sessionId">,
): string {
	const now = (options.now ?? Date.now)();
	const all = rounds.list().reverse();
	const lines: string[] = [];
	if (all.length === 0) {
		lines.push("No rounds yet: no agents have been delegated in this session.");
	} else {
		lines.push("Rounds, newest first:");
		for (const round of all.slice(0, SUMMARY_ROUNDS)) {
			lines.push(`- ${roundLine(round, now)}`);
		}
		const older = all.slice(SUMMARY_ROUNDS);
		if (older.length > 0) {
			const running = older.filter((round) => round.status === "running");
			lines.push(
				`- and ${older.length} older round${older.length === 1 ? "" : "s"}${
					running.length > 0
						? ` (${running.length} still running: ${running.map((r) => r.id).join(", ")})`
						: ", all ended"
				}`,
			);
		}
	}
	lines.push("", ...describeNodes(options.configProvider?.(), now));
	lines.push("", RETRY_POLICY_TEXT);
	const team = teammateLines(options.teammates?.(), now);
	if (team.length > 0) {
		lines.push("", ...team);
	}
	lines.push(
		"",
		"agents_status(round_id) lists a round's agents; agents_status(agent_id) shows one in detail.",
	);
	return lines.join("\n");
}

/** One line per agent of a round. */
export function describeRound(round: RoundRecord, now: number): string {
	const lines = [roundLine(round, now)];
	for (const agent of round.agents) {
		const state = agent.state;
		const where = agent.nodeLabel ?? agent.nodeId;
		const bits = [
			state,
			...(where ? [where] : []),
			...(agent.iterations !== undefined
				? [
						`${agent.iterations}${agent.maxIterations ? `/${agent.maxIterations}` : ""} it`,
					]
				: []),
			...(agent.inputTokens !== undefined
				? [`${short(agent.inputTokens)}/${short(agent.outputTokens ?? 0)} tok`]
				: []),
			...(agent.genTps !== undefined && LIVE_STATES.has(state)
				? [`${agent.genTps} tok/s`]
				: []),
			...(agent.compactions ? [`${agent.compactions} compactions`] : []),
		];
		const reason =
			state === "running"
				? agent.activity.at(-1)
					? `last: ${oneLine(agent.activity.at(-1)?.text, 80)}`
					: ""
				: describeReason(agent, state, now);
		lines.push(
			`- ${agent.id} ${agent.name}: ${bits.join(" · ")}${reason ? ` -- ${oneLine(reason, 200)}` : ""}`,
		);
	}
	return lines.join("\n");
}

/** One agent in full: everything ruling 6 and spec B ask for, bounded. */
export function describeAgent(
	round: RoundRecord,
	agent: RoundAgentRecord,
	now: number,
): string {
	const state = agent.state;
	const lines = [
		`${agent.id} ${agent.name} (round ${round.id}, ${round.tool}) -- ${state}: ${describeReason(agent, state, now)}`,
	];
	const model = [agent.providerId, agent.modelId].filter(Boolean).join("/");
	const window =
		agent.contextTokens !== undefined
			? `window ${count(agent.contextTokens)}${agent.contextWindow ? ` of ${count(agent.contextWindow)}` : ""} tokens in use`
			: agent.contextWindow
				? `window ${count(agent.contextWindow)} tokens`
				: undefined;
	lines.push(
		[
			`node: ${agent.nodeLabel ?? agent.nodeId ?? "(not placed)"}`,
			`model: ${model || "(not yet known)"}`,
			...(window ? [window] : []),
			`tokens: ${count(agent.inputTokens ?? 0)} in / ${count(agent.outputTokens ?? 0)} out`,
			...(agent.genTps !== undefined
				? [`speed: ${agent.genTps} tok/s (recent)`]
				: []),
		].join(" · "),
	);
	const causes = Object.entries(agent.compactionsByCause ?? {})
		.filter(([, n]) => (n ?? 0) > 0)
		.map(([cause, n]) => `${cause} ${n}`)
		.join(", ");
	const sampling = agent.samplingUsed;
	lines.push(
		[
			`iterations: ${agent.iterations ?? 0} / ${agent.maxIterations ?? "default cap"}`,
			`compactions: ${agent.compactions ?? 0}${causes ? ` (${causes})` : ""}`,
			`sampling: ${
				sampling &&
				(sampling.seed !== undefined || sampling.temperature !== undefined)
					? [
							sampling.seed !== undefined
								? `seed ${sampling.seed}${sampling.seedRandom ? " (random)" : ""}`
								: "",
							sampling.temperature !== undefined
								? `temperature ${sampling.temperature}${
										sampling.temperatureBase !== undefined
											? ` (drawn around ${sampling.temperatureBase} ±${sampling.temperatureRange ?? "?"}%)`
											: ""
									}`
								: "",
						]
							.filter(Boolean)
							.join(", ")
					: "the model's own"
			}`,
			`runs: ${agent.attempts}${agent.requeues > 0 ? `, requeued ${agent.requeues}x` : ""}`,
		].join(" · "),
	);
	lines.push(describeCheck(agent));
	if (agent.revisedInstructions) {
		lines.push(
			`revised instructions: ${oneLine(agent.revisedInstructions, 300)}`,
		);
	}
	lines.push(`task: ${oneLine(agent.task, 300)}`);
	const tail = agent.result ?? agent.outputTail;
	if (tail) {
		lines.push(
			`${agent.result ? "report" : "last output"} (tail):\n${tail.trim()}`,
		);
	}
	const activity = agent.activity.slice(-DETAIL_ACTIVITY);
	if (activity.length > 0) {
		lines.push(
			"activity (latest last):",
			...activity.map(
				(line) =>
					`  ${clock(line.at)}Z ${line.severity === "warn" ? "[warn] " : ""}${oneLine(line.text, 200)}`,
			),
		);
	}
	if (agent.errors.length > 0) {
		lines.push(
			"errors:",
			...agent.errors.map(
				(error) =>
					`  ${clock(error.at)}Z [${error.class}] ${oneLine(error.text, 240)}`,
			),
		);
	}
	return lines.join("\n");
}

function teammateDetail(
	source: TeammateStatusSource | undefined,
	id: string,
	now: number,
): string | undefined {
	const member = source?.members.find(
		(entry) => entry.role === "teammate" && entry.agentId === id,
	);
	if (!member) {
		return undefined;
	}
	const runs = (source?.runs ?? []).filter((run) => run.agentId === id);
	const lines = [`${id} (teammate) -- ${member.status}`];
	if (member.description) {
		lines.push(`role: ${oneLine(member.description, 200)}`);
	}
	if (member.activity) {
		const causes = Object.entries(member.activity.compactionsByCause ?? {})
			.map(([cause, n]) => `${cause} ${n}`)
			.join(", ");
		lines.push(
			`life: ${member.activity.toolCalls} tool calls, ${member.activity.compactions} compactions${causes ? ` (${causes})` : ""}`,
		);
	}
	for (const run of runs.slice(-4)) {
		const started = new Date(run.startedAt).getTime();
		lines.push(
			`run ${run.id}: ${run.status}${
				started > 0
					? `, started ${clock(started)}Z (${formatDuration(now - started)} ago)`
					: ""
			}${run.currentActivity ? `, ${run.currentActivity}` : ""}${run.error ? ` -- ${oneLine(run.error, 200)}` : ""}`,
		);
	}
	return lines.join("\n");
}

function bound(text: string): string {
	return text.length > STATUS_MAX_CHARS
		? `${text.slice(0, STATUS_MAX_CHARS - 80)}\n… (cut to stay short; ask for a round or an agent by id for the rest)`
		: text;
}

export function renderAgentsStatus(
	input: { agent_id?: string; agent_ids?: string[]; round_id?: string },
	options: AgentsStatusOptions,
): string {
	const rounds = roundsFor(options.sessionId);
	const now = (options.now ?? Date.now)();
	const ids = [
		...(input.agent_id ? [input.agent_id] : []),
		...(input.agent_ids ?? []),
	]
		.map((id) => id.trim())
		.filter(Boolean);
	if (ids.length > 0) {
		const parts = ids.slice(0, DETAIL_MAX_AGENTS).map((id) => {
			const found = rounds.findAgent(id);
			if (found) {
				return describeAgent(found.round, found.agent, now);
			}
			return (
				teammateDetail(options.teammates?.(), id, now) ??
				`${id}: no agent by that id or name in this session.`
			);
		});
		if (ids.length > DETAIL_MAX_AGENTS) {
			parts.push(
				`(${ids.length - DETAIL_MAX_AGENTS} more not shown: ask for them in another call.)`,
			);
		}
		return bound(parts.join("\n\n"));
	}
	if (input.round_id?.trim()) {
		const round = rounds.get(input.round_id);
		if (!round) {
			const known = rounds
				.list()
				.map((entry) => entry.id)
				.slice(-10);
			return `No round ${input.round_id.trim()}.${known.length > 0 ? ` Rounds: ${known.join(", ")}.` : ""}`;
		}
		return bound(describeRound(round, now));
	}
	return bound(describeSummary(rounds, options));
}

export const AGENTS_STATUS_DESCRIPTION =
	"What your delegated agents are doing, and why -- read-only, and safe to call as often as you like: it asks no server anything. " +
	"With no arguments: every round (a spawn call) with its agents counted by state -- running, queued, waiting-infra, awaiting-lead, done, failed, cancelled -- and how long it has run; every node with what it runs, whether it answers, its slots in use and queue, its admission policy and recent refusals; and the retry policy. " +
	"`round_id` lists that round's agents one per line. `agent_id` (or `agent_ids`) shows an agent in detail: its state and the reason (waiting on which node and why, its iteration cap, a context overflow, an engine error, cancelled by whom), node, model, window and tokens, recent speed, iterations against its cap, compactions by cause, sampler, check result, the tail of its output and activity, and its errors. " +
	"Use it instead of waiting blind: it is how you decide whether to requeue, restart, resume or retry an agent.";

export function createAgentsStatusTool(
	options: AgentsStatusOptions,
): AgentTool {
	return {
		name: AGENTS_STATUS_TOOL_NAME,
		description: AGENTS_STATUS_DESCRIPTION,
		inputSchema: {
			type: "object",
			properties: {
				agent_id: {
					type: "string",
					description:
						"An agent's id (r3-2) or name: show it in detail. A teammate's id works too.",
				},
				agent_ids: {
					type: "array",
					items: { type: "string" },
					description: "Several agents to show in detail.",
				},
				round_id: {
					type: "string",
					description: "A round's id (r3): one line per agent of it.",
				},
			},
		},
		execute: async (input: unknown, context) =>
			renderAgentsStatus(
				(input ?? {}) as {
					agent_id?: string;
					agent_ids?: string[];
					round_id?: string;
				},
				{ ...options, sessionId: context?.sessionId ?? options.sessionId },
			),
	} as AgentTool;
}

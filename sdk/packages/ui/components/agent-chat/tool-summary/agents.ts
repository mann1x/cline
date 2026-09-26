/**
 * Rows for the lead's tools over its delegated agents: the status tool and
 * the controls. Each says which agent or round it was about, which a bare
 * humanized tool name did not.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ids(record: Record<string, unknown>, one: string, many: string) {
	const list = [
		...(typeof record[one] === "string" ? [record[one] as string] : []),
		...(Array.isArray(record[many])
			? (record[many] as unknown[]).filter(
					(entry): entry is string => typeof entry === "string",
				)
			: []),
	]
		.map((entry) => entry.trim())
		.filter(Boolean);
	return list;
}

function listed(list: string[], max = 4): string {
	return list.length > max
		? `${list.slice(0, max).join(", ")} and ${list.length - max} more`
		: list.join(", ");
}

/** The tools this covers. */
export const AGENT_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
	"agents_status",
	"requeue_agent",
	"restart_agent",
	"resume_agent",
	"retry_failed",
	"message_agents",
	"stop_agents",
	"await_agents",
]);

/** The row label for one of {@link AGENT_CONTROL_TOOL_NAMES}, or undefined. */
export function agentControlLabel(
	toolName: string,
	input: unknown,
	inProgress: boolean,
): string | undefined {
	if (!AGENT_CONTROL_TOOL_NAMES.has(toolName)) {
		return undefined;
	}
	const record = isRecord(input) ? input : {};
	const verb = (now: string, done: string) => (inProgress ? now : done);
	switch (toolName) {
		case "agents_status": {
			const agents = ids(record, "agent_id", "agent_ids");
			if (agents.length > 0) {
				return `${verb("Checking", "Checked")} agent${agents.length === 1 ? "" : "s"} ${listed(agents)}`;
			}
			if (typeof record.round_id === "string" && record.round_id.trim()) {
				return `${verb("Checking", "Checked")} round ${record.round_id.trim()}`;
			}
			return `${verb("Checking", "Checked")} the agents`;
		}
		case "requeue_agent":
		case "restart_agent":
		case "resume_agent": {
			const agent = ids(record, "agent_id", "agent_ids")[0] ?? "an agent";
			const reason =
				typeof record.reason === "string" && record.reason.trim()
					? ` (${record.reason.trim()})`
					: "";
			const extra = Number(record.extra_iterations);
			if (toolName === "requeue_agent") {
				return `${verb("Requeuing", "Requeued")} ${agent}${reason}`;
			}
			if (toolName === "restart_agent") {
				return `${verb("Restarting", "Restarted")} ${agent}`;
			}
			return `${verb("Resuming", "Resumed")} ${agent}${
				Number.isFinite(extra) && extra > 0 ? ` (+${extra} iterations)` : ""
			}`;
		}
		case "retry_failed": {
			const round =
				typeof record.round_id === "string" ? record.round_id.trim() : "";
			return `${verb("Retrying", "Retried")} the failed agents${round ? ` of ${round}` : ""}`;
		}
		case "message_agents":
		case "stop_agents": {
			const agents = ids(record, "agent", "agents");
			if (toolName === "message_agents") {
				return `${verb("Messaging", "Messaged")} ${agents.length > 0 ? listed(agents) : "every running agent"}`;
			}
			return `${verb("Stopping", "Stopped")} ${agents.length > 0 ? listed(agents) : "every running agent"}`;
		}
		case "await_agents": {
			const rounds = ids(record, "round_id", "round_ids");
			return `${verb("Waiting for", "Waited for")} ${rounds.length > 0 ? `round ${listed(rounds)}` : "the running rounds"}`;
		}
		default:
			return undefined;
	}
}

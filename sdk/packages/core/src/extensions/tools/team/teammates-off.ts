/**
 * Teammates are a setting, off by default, and a session can outlive a change
 * to it: one that used teammates can be reopened after they were switched off.
 *
 * Nothing is restored then -- the team store is not opened and no `team_*`
 * tool is offered, so the transcript's earlier team calls stay history -- and
 * that is correct, but it is also invisible. This names it once, so a user
 * reading the log after "where did my teammates go" finds the answer.
 */

/** The tool-name prefix every team tool carries. */
const TEAM_TOOL_PREFIX = "team_";

export const TEAMMATES_OFF_RESTORE_NOTE =
	"[Agents] This session used teammates, but Teammates is off in settings: the team tools are not offered and its teammates are not restored. Turn Teammates on to bring them back.";

/** Whether a transcript holds a call to any `team_*` tool. */
export function historyUsedTeammates(
	messages: readonly { content?: unknown }[] | undefined,
): boolean {
	if (!messages) {
		return false;
	}
	for (const message of messages) {
		if (!Array.isArray(message?.content)) {
			continue;
		}
		for (const block of message.content) {
			if (
				block &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "tool_use" &&
				typeof (block as { name?: unknown }).name === "string" &&
				(block as { name: string }).name.startsWith(TEAM_TOOL_PREFIX)
			) {
				return true;
			}
		}
	}
	return false;
}

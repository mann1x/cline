import type { BackgroundDelegationView } from "@cline/core";
import { useTheme } from "../hooks/use-theme";

function elapsed(startedAt: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

function truncate(text: string, width: number): string {
	return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

/**
 * The agents working while the user carries on.
 *
 * Only live runs appear. A finished one has already put its report into the
 * conversation, so a row left behind would claim work is still going on.
 *
 * Deliberately one line each and no controls of its own: this says what is
 * happening, and `/agents` is where it is acted on. A panel that both watched
 * and steered would need a selection, and there is already one in this corner
 * of the screen -- the queued prompts, which own the arrow keys.
 */
export function BackgroundAgents(props: { runs: BackgroundDelegationView[] }) {
	const theme = useTheme();
	if (props.runs.length === 0) return null;

	const paused = props.runs.filter((run) => run.status === "paused").length;

	return (
		<box
			flexDirection="column"
			border
			borderStyle="rounded"
			borderColor="gray"
			paddingX={1}
		>
			<text fg="gray">
				<em>
					Background agents ({props.runs.length}
					{paused > 0 ? `, ${paused} paused` : ""}):
				</em>
			</text>
			{props.runs.map((run) => (
				<text key={run.id}>
					<span fg={run.status === "paused" ? "yellow" : theme.accents.act}>
						{run.status === "paused" ? "⏸" : "▸"} {run.agentName}
					</span>
					<span fg="gray">
						{"  "}
						{truncate(run.prompt, 44)}
					</span>
					<span fg="gray">
						{"  "}
						{run.activity ?? "starting"}
						{run.iterations ? ` · turn ${run.iterations}` : ""} ·{" "}
						{elapsed(run.startedAt)}
					</span>
				</text>
			))}
			<text fg="gray">
				<em>/agents to pause, resume or stop them</em>
			</text>
		</box>
	);
}

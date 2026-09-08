import type { BackgroundDelegationView } from "@cline/core";
import type { ChoiceContext } from "@opentui-ui/dialog";
import { useDialogKeyboard } from "@opentui-ui/dialog/react";
import { useState } from "react";
import { useTheme } from "../../hooks/use-theme";

export interface BackgroundAgentAction {
	id: string;
	action: "pause" | "resume" | "stop";
}

/**
 * Pause, resume or stop a background agent.
 *
 * One screen rather than a run picker followed by an action picker: there are
 * three actions, two of which are the same key in two states, and asking twice
 * for that is a dialog arguing with itself. Arrows choose the run, a letter
 * does the thing.
 *
 * Resolves with one action and closes. A user with several to act on opens it
 * again, which costs a keystroke and keeps this from having to stay in step
 * with a list that changes underneath it.
 */
export function BackgroundAgentsControlContent(
	ctx: ChoiceContext<BackgroundAgentAction> & {
		runs: BackgroundDelegationView[];
	},
) {
	const theme = useTheme();
	const [selected, setSelected] = useState(0);
	const runs = ctx.runs;
	const safeSelected = Math.min(selected, Math.max(0, runs.length - 1));
	const current = runs[safeSelected];

	useDialogKeyboard((key) => {
		if (key.name === "escape") {
			ctx.dismiss();
			return;
		}
		if (key.name === "up") {
			setSelected((previous) => Math.max(0, previous - 1));
			return;
		}
		if (key.name === "down") {
			setSelected((previous) => Math.min(runs.length - 1, previous + 1));
			return;
		}
		if (!current) {
			return;
		}
		// Enter is whichever of pause/resume this run is not already doing, so
		// the common case needs no decision at all.
		if (key.name === "return" || key.name === "p") {
			ctx.resolve({
				id: current.id,
				action: current.status === "paused" ? "resume" : "pause",
			});
			return;
		}
		if (key.name === "s") {
			ctx.resolve({ id: current.id, action: "stop" });
		}
	}, ctx.dialogId);

	if (runs.length === 0) {
		return (
			<box flexDirection="column" paddingX={1}>
				<text>No agents are running in the background.</text>
				<text fg="gray" marginTop={1}>
					<em>
						/delegate-background &lt;agent&gt; &lt;task&gt; starts one. Esc to
						close.
					</em>
				</text>
			</box>
		);
	}

	return (
		<box flexDirection="column" paddingX={1}>
			<text>Background agents</text>
			<box flexDirection="column" marginTop={1}>
				{runs.map((run, index) => (
					<text
						key={run.id}
						fg={index === safeSelected ? theme.accents.act : undefined}
					>
						{index === safeSelected ? "❯ " : "  "}
						{run.status === "paused" ? "⏸ " : "▸ "}
						{run.agentName}
						<span fg="gray">
							{"  "}
							{run.prompt.length > 40
								? `${run.prompt.slice(0, 39)}…`
								: run.prompt}
							{run.activity ? `  ${run.activity}` : ""}
						</span>
					</text>
				))}
			</box>
			<text fg="gray" marginTop={1}>
				<em>
					↑/↓ choose · Enter or P{" "}
					{current?.status === "paused" ? "resume" : "pause"} · S stop · Esc
					close
				</em>
			</text>
		</box>
	);
}

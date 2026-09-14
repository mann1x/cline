import { DEFAULT_ESCALATION_SETTINGS } from "@shared/EscalationSettings"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useExtensionState } from "@/context/ExtensionStateContext"
import ScopedModelTab from "./ScopedModelTab"
import { updateSetting } from "./utils/settingsHandlers"

/** A limit the user typed. Anything that is not a positive integer is ignored. */
function readLimit(value: string): number | undefined {
	const limit = Number.parseInt(value, 10)
	return Number.isFinite(limit) && limit > 0 ? limit : undefined
}

/** A threshold box. Five of these, and they differ only in label and key. */
function Threshold({
	id,
	label,
	stored,
	fallback,
	field,
}: {
	id: string
	label: string
	stored: number | undefined
	fallback: number
	field: string
}) {
	return (
		<div className="space-y-1">
			<Label className="text-xs text-muted-foreground" htmlFor={id}>
				{label}
			</Label>
			<Input
				defaultValue={stored || fallback}
				id={id}
				min={1}
				onChange={(event) => {
					const limit = readLimit(event.target.value)
					if (limit !== undefined) {
						updateSetting("escalationSettings", { [field]: limit })
					}
				}}
				step={1}
				type="number"
			/>
		</div>
	)
}

/**
 * The API configuration panel, pointed at the expert a stuck session escalates to.
 *
 * The expert is the one model here that is deliberately *more* expensive than
 * the session's — a metered cloud account, or simply a larger local model that
 * has to be loaded. That is also why it needs a configuration of its own rather
 * than a share of the session's: an expert borrowing the lead's context window
 * would be sized down to whatever the small model was given, which is the
 * opposite of the point. Everything about how a tab holds its own configuration
 * lives in `ScopedModelTab`; this says which configuration, and what it may
 * spend.
 *
 * The budgets live here rather than in the feature panel because they are about
 * this model: how many times it may be called, and how long a conversation with
 * it is held open. Nothing here turns the expert on — that is the checkbox
 * beside the tab strip.
 */
const EscalationModelTab = () => {
	const { escalationModeApiConfiguration, escalationSettings } = useExtensionState()
	return (
		<div className="flex flex-col gap-4">
			<ScopedModelTab setting="escalationModeApiConfiguration" storedSnapshot={escalationModeApiConfiguration} />

			<div className="flex flex-col gap-2">
				<div className="grid grid-cols-2 gap-2">
					<div className="space-y-1">
						<Label className="text-xs text-muted-foreground" htmlFor="escalation-max-escalations">
							Escalations per task
						</Label>
						<Input
							defaultValue={escalationSettings?.maxEscalations ?? DEFAULT_ESCALATION_SETTINGS.maxEscalations}
							id="escalation-max-escalations"
							min={1}
							onChange={(event) => {
								const limit = readLimit(event.target.value)
								if (limit !== undefined) {
									updateSetting("escalationSettings", { maxEscalations: limit })
								}
							}}
							step={1}
							type="number"
						/>
					</div>
					<div className="space-y-1">
						<Label className="text-xs text-muted-foreground" htmlFor="escalation-max-follow-ups">
							Follow-ups per escalation
						</Label>
						<Input
							defaultValue={escalationSettings?.maxFollowUps ?? DEFAULT_ESCALATION_SETTINGS.maxFollowUps}
							id="escalation-max-follow-ups"
							min={1}
							onChange={(event) => {
								const limit = readLimit(event.target.value)
								if (limit !== undefined) {
									updateSetting("escalationSettings", { maxFollowUps: limit })
								}
							}}
							step={1}
							type="number"
						/>
					</div>
				</div>
				<p className="text-xs text-muted-foreground">
					How many times one task may hand over, and how many turns of back-and-forth each hand-over gets. A forced
					escalation — one a guard offers instead of ending the run — spends one of these like any other.
				</p>
			</div>

			<div className="flex flex-col gap-2">
				<Label className="text-xs">When a run counts as stuck</Label>
				<div className="grid grid-cols-2 gap-2">
					<Threshold
						fallback={DEFAULT_ESCALATION_SETTINGS.struggleFailedCalls}
						field="struggleFailedCalls"
						id="escalation-struggle-failed-calls"
						label="Failed tool calls"
						stored={escalationSettings?.struggleFailedCalls}
					/>
					<Threshold
						fallback={DEFAULT_ESCALATION_SETTINGS.struggleDistressHits}
						field="struggleDistressHits"
						id="escalation-struggle-distress-hits"
						label="Turns that say it is stuck"
						stored={escalationSettings?.struggleDistressHits}
					/>
					<Threshold
						fallback={DEFAULT_ESCALATION_SETTINGS.struggleWindow}
						field="struggleWindow"
						id="escalation-struggle-window"
						label="Turns looked back over"
						stored={escalationSettings?.struggleWindow}
					/>
					<Threshold
						fallback={DEFAULT_ESCALATION_SETTINGS.struggleMinIteration}
						field="struggleMinIteration"
						id="escalation-struggle-min-iteration"
						label="Earliest turn it may fire"
						stored={escalationSettings?.struggleMinIteration}
					/>
					<Threshold
						fallback={DEFAULT_ESCALATION_SETTINGS.struggleMaxPerTask}
						field="struggleMaxPerTask"
						id="escalation-struggle-max-per-task"
						label="Offers per task"
						stored={escalationSettings?.struggleMaxPerTask}
					/>
				</div>
				<p className="text-xs text-muted-foreground">
					Both halves have to agree before the expert is offered: enough failed tool calls in the window, and the model
					saying in its own words that it is stuck. Raising either number makes the offer rarer.
				</p>
				<p className="text-xs text-muted-foreground">
					Worth knowing before you tune these: a session running the change protocol rarely fails a tool call. It calls
					the check, the call succeeds, and the result says the check did not pass — so the failed-call count stays near
					zero and the offer never comes. Lowering it to 1 is the setting that makes the trigger reachable there.
				</p>
			</div>

			<div>
				<VSCodeCheckbox
					checked={escalationSettings?.requireApproval ?? DEFAULT_ESCALATION_SETTINGS.requireApproval}
					className="mb-[5px]"
					onChange={(event) =>
						updateSetting("escalationSettings", { requireApproval: !!(event.target as HTMLInputElement).checked })
					}>
					Ask before escalating
				</VSCodeCheckbox>
				<p className="text-xs text-(--vscode-descriptionForeground)">
					Shows you the brief the expert would be given, alongside the harness's own reading of why the run looks stuck
					— which is computed separately from the model's account of itself. Saying no costs nothing: the escalation
					budget does not move.
				</p>
			</div>

			<div>
				<VSCodeCheckbox
					checked={escalationSettings?.closeAfterEscalation ?? DEFAULT_ESCALATION_SETTINGS.closeAfterEscalation}
					className="mb-[5px]"
					onChange={(event) =>
						updateSetting("escalationSettings", {
							closeAfterEscalation: !!(event.target as HTMLInputElement).checked,
						})
					}>
					Close the expert's conversation after each escalation
				</VSCodeCheckbox>
				<p className="text-xs text-(--vscode-descriptionForeground)">
					Off holds the conversation open, so a hosted provider's prompt cache stays warm and a second escalation does
					not pay to send the whole exchange again. On releases it at once, which is what a local server with one slot
					needs before another model can load.
				</p>
			</div>
		</div>
	)
}

export default EscalationModelTab

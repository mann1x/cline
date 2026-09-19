import { DEFAULT_ATOMIC_PROTOCOL_SETTINGS } from "@shared/AtomicProtocolSettings"
import { DEFAULT_FOCUS_CHAIN_SETTINGS } from "@shared/FocusChainSettings"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { memo, type ReactNode } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { DebouncedTextArea } from "../common/DebouncedTextArea"
import { LoadDefaultPromptButton } from "../common/LoadDefaultPromptButton"
import PromptTemplatesSection from "../PromptTemplatesSection"
import QaCredentialsField from "../QaCredentialsField"
import Section from "../Section"
import { updateSetting } from "../utils/settingsHandlers"

// Reusable checkbox component for feature settings
interface FeatureCheckboxProps {
	checked: boolean | undefined
	onChange: (checked: boolean) => void
	label: string
	description: ReactNode
	disabled?: boolean
	isRemoteLocked?: boolean
	remoteTooltip?: string
	isVisible?: boolean
}

// Interface for feature toggle configuration
interface FeatureToggle {
	id: string
	label: string
	description: ReactNode
	settingKey: keyof UpdateSettingsRequest
	stateKey: string
}

const agentFeatures: FeatureToggle[] = [
	{
		// Upstream c3671de7d ("fix(vscode): disable subagents") deleted this row
		// and hardcoded `enableSpawnAgent: false` in the session factory. The
		// factory reads the setting again, but the row was never put back, so
		// `subagentsEnabled` has been resolving to its `?? false` default with no
		// control anywhere that could change it — the machinery is all present and
		// the model is offered none of it.
		//
		// The description says what the toggle alone buys, because it is not all
		// of it: the open-ended spawn and the team tools are additionally withheld
		// on a one-slot endpoint (see slotsAllowParallelDelegation), and that
		// withholding is otherwise visible only in the extension log.
		id: "subagents",
		label: "Subagents",
		description:
			"Let the model hand a piece of work to a subagent. Agents defined in .cline/agents are offered as soon as this is on; the open-ended spawn and the team tools also need the profile's parallel sessions above 1, because an endpoint that serves one request at a time would run them one after another rather than beside each other.",
		stateKey: "subagentsEnabled",
		settingKey: "subagentsEnabled",
	},
	{
		// Default on: it is what every build did before the switch existed, and
		// inside a coding task it is the right reading -- a turn that called
		// nothing is nearly always one that should have acted, a needless nudge
		// costs a turn and a missed one costs the task.
		id: "strong-nudges",
		label: "Strong coding nudges",
		description:
			'When a reply calls no tool, ask the model to carry on rather than ending the task there. Coding models often describe an edit instead of making it - "I\'ll fix the import", then stop - and the task ends with the file untouched; this catches that. Turn it off if you use Cerebriline mostly to ask questions: a plain answer then ends the turn, and only a reply that promises work, leaves an open transaction, or comes after the model has already used a tool is asked to continue.',
		stateKey: "strongNudgesEnabled",
		settingKey: "strongNudgesEnabled",
	},
	{
		id: "auto-compact",
		label: "Auto Compact",
		description: "Automatically compress conversation history.",
		stateKey: "useAutoCondense",
		settingKey: "useAutoCondense",
	},
]

// Not in `agentFeatures`: that table maps a state key to a flat boolean, and
// this setting is an object (`enabled` plus the reminder interval). Toggling it
// has to preserve the interval rather than replace the whole object with a
// boolean, so it gets its own row against the same `FeatureRow`.
const TASK_CHECKLIST_DESCRIPTION =
	"Ask the model to keep a checklist of the task's steps, shown under the context window and updated as it works."

const editorFeatures: FeatureToggle[] = [
	{
		id: "show-feature-tips",
		label: "Feature Tips",
		description: "Show rotating tips during the thinking phase to help you discover Cerebriline features.",
		stateKey: "showFeatureTips",
		settingKey: "showFeatureTips",
	},
	{
		id: "background-edit",
		label: "Background Edit",
		description: "Allow edits without stealing editor focus",
		stateKey: "backgroundEditEnabled",
		settingKey: "backgroundEditEnabled",
	},
	{
		id: "checkpoints",
		label: "Checkpoints",
		description: "Save progress at key points for easy rollback",
		stateKey: "enableCheckpointsSetting",
		settingKey: "enableCheckpointsSetting",
	},
	{
		id: "worktrees",
		label: "Worktrees",
		description: "Enables git worktree management for running parallel Cerebriline tasks.",
		stateKey: "worktreesEnabled",
		settingKey: "worktreesEnabled",
	},
]

const advancedFeatures: FeatureToggle[] = [
	{
		id: "hooks",
		label: "Hooks",
		description: "Enable lifecycle and tool hooks during task execution.",
		stateKey: "hooksEnabled",
		settingKey: "hooksEnabled",
	},
]

const FeatureRow = memo(
	({
		checked = false,
		onChange,
		label,
		description,
		disabled,
		isRemoteLocked,
		isVisible = true,
		remoteTooltip,
	}: FeatureCheckboxProps) => {
		if (!isVisible) {
			return null
		}

		const checkbox = (
			<div className="flex items-center justify-between w-full">
				<div>{label}</div>
				<div>
					<Switch
						checked={checked}
						className="shrink-0"
						disabled={disabled || isRemoteLocked}
						id={label}
						onCheckedChange={onChange}
						size="lg"
					/>
					{isRemoteLocked && <i className="codicon codicon-lock text-description text-sm" />}
				</div>
			</div>
		)

		return (
			<div className="flex flex-col items-start justify-between gap-4 py-3 w-full">
				<div className="space-y-0.5 flex-1 w-full">
					{isRemoteLocked ? (
						<Tooltip>
							<TooltipTrigger asChild>{checkbox}</TooltipTrigger>
							<TooltipContent className="max-w-xs" side="top">
								{remoteTooltip}
							</TooltipContent>
						</Tooltip>
					) : (
						checkbox
					)}
				</div>
				<div className="text-xs text-description">{description}</div>
			</div>
		)
	},
)

/**
 * A change-protocol limit, or nothing when the box does not hold one yet.
 *
 * proto3 puts an absent number and a zero on the wire the same way, so a
 * cleared field would arrive at the merge as "reset it to the default" rather
 * than as "leave it alone" — and a half-typed value must not be stored while it
 * is still being typed.
 */
function readLimit(value: string): number | undefined {
	const limit = Number.parseInt(value, 10)
	return Number.isFinite(limit) && limit > 0 ? limit : undefined
}

/**
 * The same read, for a field where zero is a value rather than a refusal.
 *
 * `readLimit` above rejects 0 because every field it serves is a budget, and a
 * budget of nothing is a mistyped box. Here 0 is the off switch, so rejecting
 * it would leave the behaviour permanently on.
 */
function readCompactionIndex(value: string): number | undefined {
	const index = Number.parseInt(value, 10)
	return Number.isFinite(index) && index >= 0 ? index : undefined
}

interface FeatureSettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const FeatureSettingsSection = ({ renderSectionHeader }: FeatureSettingsSectionProps) => {
	const {
		enableCheckpointsSetting,
		hooksEnabled,
		mcpDisplayMode,
		useAutoCondense,
		compactionPrompt,
		defaultCompactionPrompt,
		keepRecentMessagesAtCompaction,
		forceFullFromCompaction,
		fullCompactionPrompt,
		defaultFullCompactionPrompt,
		thinkingCompactionEnabled,
		thinkingCompactionPrompt,
		defaultThinkingCompactionPrompt,
		cappedThinkingEnabled,
		cappedThinkingPrompt,
		defaultCappedThinkingPrompt,
		compactionStrategy,
		editVerificationSettings,
		atomicProtocolSettings,
		webSearchEnabled,
		subagentsEnabled,
		strongNudgesEnabled,
		worktreesEnabled,
		backgroundEditEnabled,
		showFeatureTips,
		focusChainSettings,
	} = useExtensionState()

	// State lookup for mapped features
	const featureState: Record<string, boolean | undefined> = {
		showFeatureTips,
		enableCheckpointsSetting,
		hooksEnabled,
		useAutoCondense,
		subagentsEnabled,
		// `?? true` rather than a bare read: the default is on, and an
		// extension state that predates the key must not render as off.
		strongNudgesEnabled: strongNudgesEnabled ?? true,
		worktreesEnabled: worktreesEnabled?.user,
		backgroundEditEnabled,
	}

	// Visibility lookup for features with feature flags
	const featureVisibility: Record<string, boolean | undefined> = {
		worktreesEnabled: worktreesEnabled?.featureFlag,
	}

	return (
		<div className="mb-2">
			{renderSectionHeader("features")}
			<Section>
				<div className="mb-5 flex flex-col gap-3">
					{/* Core features */}
					<div>
						<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">Agent</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
							id="agent-features">
							{agentFeatures.map((feature) => (
								<FeatureRow
									checked={featureState[feature.stateKey]}
									description={feature.description}
									isVisible={featureVisibility[feature.stateKey] ?? true}
									key={feature.id}
									label={feature.label}
									onChange={(checked) => updateSetting(feature.settingKey, checked)}
								/>
							))}
							<FeatureRow
								checked={focusChainSettings?.enabled ?? true}
								description={TASK_CHECKLIST_DESCRIPTION}
								label="Task Checklist"
								onChange={(checked) =>
									updateSetting("focusChainSettings", {
										enabled: checked,
										// Carried through, not defaulted: dropping it here would
										// silently reset a tuned interval every time the toggle
										// is flipped.
										remindClineInterval:
											focusChainSettings?.remindClineInterval ??
											DEFAULT_FOCUS_CHAIN_SETTINGS.remindClineInterval,
									})
								}
							/>
							<div className="space-y-2 py-3">
								<Label className="text-sm font-medium text-foreground">Auto Compact Strategy</Label>
								<p className="text-xs text-muted-foreground">Controls how auto compaction rewrites context.</p>
								<Select
									disabled={!useAutoCondense}
									onValueChange={(value) => updateSetting("compactionStrategy", value)}
									value={compactionStrategy ?? "agentic"}>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="basic">Basic</SelectItem>
										<SelectItem value="agentic">Agentic</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-2 py-3">
								<Label className="text-sm font-medium text-foreground">Check Edited Files</Label>
								{/* A guard rather than an instruction. Measured on a live
								    session: list_files → browser → read_files → check_file →
								    editor → editor → editor → editor. The linter ran once,
								    before anything was touched, then four edits landed with
								    nothing checking them and sixteen problems in the file
								    afterwards. A model that ignores a linter it has already
								    run will ignore a sentence asking it to run one again. */}
								<p className="text-xs text-muted-foreground">
									Whether a task may finish with a file it changed and never checked. Nudge holds the run back
									twice and then lets it through; Require gives the same guard more room to insist.
								</p>
								<Select
									onValueChange={(value) => updateSetting("editVerificationSettings", { mode: value })}
									value={editVerificationSettings?.mode ?? "nudge"}>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="off">Off</SelectItem>
										<SelectItem value="nudge">Nudge</SelectItem>
										<SelectItem value="require">Require</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-2 py-3">
								<Label className="text-sm font-medium text-foreground">Change Protocol</Label>
								{/* The rollback is the feature. Measured across the campaign
								    this comes from, transactions that reported success and
								    failed the check were the normal case — the model had
								    fixed the error it was looking at and not the one the
								    program still had — and without a revert each of those
								    left its half-fix behind for the next attempt to build
								    on. */}
								<p className="text-xs text-muted-foreground">
									Runs a task as transactions: a few declared changes, then a check. If the check fails, every
									file goes back to what it was and the next attempt starts fresh with a record of what was
									already tried.
								</p>
								{/* The two modes differ in who decides and where the check
								    comes from, not in how a transaction is judged. On is
								    how a developer meets this — partway through the work,
								    at the bug that turns out to be worth the cost. Static
								    is how a model is measured, and a measured run must not
								    depend on what a panel happened to be showing. */}
								<p className="text-xs text-muted-foreground">
									<strong>On</strong> makes it available and you engage it per task, from the Auto-approve panel
									above the message box, where you also name that task's check. <strong>Static</strong> engages
									it on every task using the check set here, and the chat cannot change it — which is what makes
									a run repeatable.
								</p>
								<Select
									onValueChange={(value) => updateSetting("atomicProtocolSettings", { mode: value })}
									value={atomicProtocolSettings?.mode ?? "off"}>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="off">Off</SelectItem>
										<SelectItem value="on">On</SelectItem>
										<SelectItem value="static">Static</SelectItem>
									</SelectContent>
								</Select>
								{atomicProtocolSettings?.mode !== "off" ? (
									<>
										{/* The check fields are Static's. Under On they
										    belong to the task and live next to the engage
										    button, because they are decisions about the bug
										    in front of you rather than about how you work. */}
										{atomicProtocolSettings?.mode === "static" ? (
											<>
												{/* Detection answers "does this workspace still hold
										    together", which a model can leave green with the
										    asked-for thing still broken: a typecheck passes
										    over a game that no longer starts. */}
												<p className="text-xs text-muted-foreground">
													What to run to decide whether the task worked. Yours outranks anything found
													by looking at the workspace — leave it empty and the project's own test,
													typecheck or build is used instead.
												</p>
												{/* Naming it here is the way out of being asked
										    once per run. A page check is otherwise
										    reachable only by approving a proposal, and a
										    user running the same task repeatedly is then
										    approving the same check over and over. */}
												<p className="text-xs text-muted-foreground">
													For a page or a script with nothing to run it, write{" "}
													<code>cline:page index.html</code>: Cerebriline loads the file itself, runs
													it, and fails if it does not parse, throws, or never draws a frame. No browser
													and no shell.
												</p>
												<DebouncedTextArea
													initialValue={atomicProtocolSettings?.oracleCommand ?? ""}
													maxRows={3}
													minRows={1}
													onChange={(value) =>
														updateSetting("atomicProtocolSettings", { oracleCommand: value })
													}
													placeholder="node run_game.js index.html"
												/>
												{/* Plenty of check scripts report a verdict and
										    exit zero regardless. Without this, one of
										    those keeps every transaction it is pointed
										    at — including the one this protocol was
										    measured against. */}
												<p className="text-xs text-muted-foreground">
													Optional: a regular expression the output must match as well. For a check that
													prints whether it worked and exits cleanly either way.
												</p>
												<DebouncedTextArea
													initialValue={atomicProtocolSettings?.oracleExpect ?? ""}
													maxRows={2}
													minRows={1}
													onChange={(value) =>
														updateSetting("atomicProtocolSettings", { oracleExpect: value })
													}
													placeholder={'"ok":\\s*true'}
												/>
											</>
										) : null}
										{/* Targets rather than caps: nothing stops the model
										    mid-edit, and it does not obey the change count —
										    measured on the campaign this comes from, an attempt
										    asked for three made twenty-six. The attempt count is
										    the one that binds, because the protocol enforces it.
										    What the change count controls is how much unjudged
										    work a rollback throws away. */}
										<p className="text-xs text-muted-foreground">
											How much one attempt should take on before the check runs, and how many attempts the
											task gets. A smaller change count means the check runs sooner and a failed attempt
											loses less; when the attempts run out the task stops, having put back everything the
											check never passed.
										</p>
										<div className="grid grid-cols-2 gap-2">
											<div className="space-y-1">
												<Label className="text-xs text-muted-foreground" htmlFor="atomic-max-changes">
													Changes per attempt
												</Label>
												<Input
													defaultValue={
														atomicProtocolSettings?.maxChanges ??
														DEFAULT_ATOMIC_PROTOCOL_SETTINGS.maxChanges
													}
													id="atomic-max-changes"
													min={1}
													onChange={(event) => {
														const changes = readLimit(event.target.value)
														if (changes !== undefined) {
															updateSetting("atomicProtocolSettings", { maxChanges: changes })
														}
													}}
													step={1}
													type="number"
												/>
											</div>
											<div className="space-y-1">
												<Label
													className="text-xs text-muted-foreground"
													htmlFor="atomic-max-transactions">
													Attempts per task
												</Label>
												<Input
													defaultValue={
														atomicProtocolSettings?.maxTransactions ??
														DEFAULT_ATOMIC_PROTOCOL_SETTINGS.maxTransactions
													}
													id="atomic-max-transactions"
													min={1}
													onChange={(event) => {
														const transactions = readLimit(event.target.value)
														if (transactions !== undefined) {
															updateSetting("atomicProtocolSettings", {
																maxTransactions: transactions,
															})
														}
													}}
													step={1}
													type="number"
												/>
											</div>
										</div>
										{/* Only about the case with nothing to run. With a
										    check configured or detected there is nothing to
										    propose, and this changes nothing. Static's copy
										    of the switch; On keeps its own per task. */}
										{atomicProtocolSettings?.mode === "static" ? (
											<FeatureRow
												checked={atomicProtocolSettings?.proposeCheck !== false}
												description="Where nothing can be run, let the model name the check that should decide and ask you to approve it once; it can then run that check itself at any point. Off, the model's own account of its work is the verdict — weaker evidence, and measurably faster."
												label="Model proposes the check"
												onChange={(checked) =>
													updateSetting("atomicProtocolSettings", { proposeCheck: checked })
												}
											/>
										) : null}
										{/* Both are only about a check the model named, so
										    they are hidden with the switch that produces
										    one. A check you wrote is never reconsidered and
										    was never proposed. Shown under On regardless:
										    the switch is per task there, and hiding these
										    behind Static's copy of it would leave them
										    unreachable for a session that turns proposals
										    on. */}
										{atomicProtocolSettings?.mode === "on" ||
										atomicProtocolSettings?.proposeCheck !== false ? (
											<>
												<p className="text-xs text-muted-foreground">
													How many checks you are asked to judge, and when a check that has never passed
													may be replaced. A proposed check is frozen once approved, which stops the
													model weakening it until one passes — but a check that cannot pass at all then
													freezes the task into failure, so after this many discarded attempts with no
													pass at all the model may propose one replacement. Zero leaves it frozen for
													good.
												</p>
												<div className="grid grid-cols-2 gap-2">
													<div className="space-y-1">
														<Label
															className="text-xs text-muted-foreground"
															htmlFor="atomic-max-check-proposals">
															Proposals you judge
														</Label>
														<Input
															defaultValue={
																atomicProtocolSettings?.maxCheckProposals ??
																DEFAULT_ATOMIC_PROTOCOL_SETTINGS.maxCheckProposals
															}
															id="atomic-max-check-proposals"
															min={1}
															onChange={(event) => {
																const proposals = readLimit(event.target.value)
																if (proposals !== undefined) {
																	updateSetting("atomicProtocolSettings", {
																		maxCheckProposals: proposals,
																	})
																}
															}}
															step={1}
															type="number"
														/>
													</div>
													<div className="space-y-1">
														<Label
															className="text-xs text-muted-foreground"
															htmlFor="atomic-check-reconsidered-after">
															Attempts before a rethink
														</Label>
														<Input
															defaultValue={
																atomicProtocolSettings?.checkReconsideredAfter ??
																DEFAULT_ATOMIC_PROTOCOL_SETTINGS.checkReconsideredAfter
															}
															id="atomic-check-reconsidered-after"
															min={0}
															onChange={(event) => {
																// Zero is the off switch here, so it is read
																// directly rather than through `readLimit`,
																// which treats it as no answer.
																const raw = event.target.value.trim()
																const parsed = Number.parseInt(raw, 10)
																if (raw !== "" && Number.isInteger(parsed) && parsed >= 0) {
																	updateSetting("atomicProtocolSettings", {
																		checkReconsideredAfter: parsed,
																	})
																}
															}}
															step={1}
															type="number"
														/>
													</div>
												</div>
											</>
										) : null}
									</>
								) : null}
							</div>
							<QaCredentialsField />
							<FeatureRow
								checked={webSearchEnabled}
								description="Let the model search the web when the selected provider and model support it. Applies to new tasks."
								label="Web Search"
								onChange={(checked) => updateSetting("webSearchEnabled", checked)}
							/>
						</div>
					</div>

					{/* Editor features */}
					<div>
						<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">Editor</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50"
							id="optional-features">
							{editorFeatures.map((feature) => (
								<FeatureRow
									checked={featureState[feature.stateKey]}
									description={feature.description}
									isVisible={featureVisibility[feature.stateKey] ?? true}
									key={feature.id}
									label={feature.label}
									onChange={(checked) => updateSetting(feature.settingKey, checked)}
								/>
							))}
						</div>
					</div>
				</div>

				{/* Advanced */}
				<div>
					<div className="text-xs font-medium text-foreground/80 uppercase tracking-wider mb-3">Advanced</div>
					<div className="relative p-3 my-3 rounded-md border border-editor-widget-border/50" id="advanced-features">
						<div className="space-y-3">
							{advancedFeatures.map((feature) => (
								<FeatureRow
									checked={featureState[feature.stateKey]}
									description={feature.description}
									isVisible={featureVisibility[feature.stateKey] ?? true}
									key={feature.id}
									label={feature.label}
									onChange={(checked) => updateSetting(feature.settingKey, checked)}
								/>
							))}

							{/* MCP Display Mode */}
							<div className="space-y-2">
								<Label className="text-sm font-medium text-foreground">MCP Display Mode</Label>
								<p className="text-xs text-muted-foreground">Controls how MCP responses are displayed</p>
								<Select onValueChange={(v) => updateSetting("mcpDisplayMode", v)} value={mcpDisplayMode}>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="plain">Plain Text</SelectItem>
										<SelectItem value="rich">Rich Display</SelectItem>
										<SelectItem value="markdown">Markdown</SelectItem>
									</SelectContent>
								</Select>
							</div>
						</div>
					</div>
				</div>

				<PromptTemplatesSection />

				{/* Last, because it is the longest field on the page and the one
				    most people never touch.

				    The switch comes first because it decides what the field
				    below it is: the two prompts are written for two different
				    cuts and neither works under the other, so the field
				    addresses whichever one is live and keeps the other stored
				    untouched. */}
				<div className="space-y-2 pt-2">
					<div className="flex items-center justify-between w-full">
						<Label className="text-sm font-medium text-foreground">Keep Recent Messages At Compaction</Label>
						<Switch
							checked={keepRecentMessagesAtCompaction ?? true}
							className="shrink-0"
							disabled={!useAutoCondense}
							id="keepRecentMessagesAtCompaction"
							onCheckedChange={(checked) => updateSetting("keepRecentMessagesAtCompaction", checked)}
							size="lg"
						/>
					</div>
					<p className="text-xs text-muted-foreground">
						On, the summary is a preface: the most recent turns survive verbatim underneath it, and the summary is
						written to read as your own memory of the ones that did not. Off, the summary is the whole context &mdash;
						everything is discarded except the request that started the turn, and the summary has to carry the rest on
						its own. Reclaims far more, and asks far more of the model writing it.
					</p>
					<p className="text-xs text-muted-foreground">
						Leaving this on does not rule the other mode out. If a compaction keeps the recent turns and the context
						is still over the limit afterwards, the tail is dropped for that one compaction and you are told it
						happened. That is rare &mdash; it needs the conversation to have run several times past the point where
						compaction should have fired, which happens when a provider misreports its context window, or when auto
						compaction was off and has just been turned on.
					</p>
					{/* The other way the tail gets dropped, and the deliberate one. Only
					    meaningful while the switch above is on: with it off every
					    compaction already keeps nothing. */}
					<div className="space-y-1 pt-1">
						<Label className="text-xs text-muted-foreground" htmlFor="force-full-from-compaction">
							Drop the tail from compaction number
						</Label>
						<Input
							defaultValue={forceFullFromCompaction ?? 0}
							disabled={!useAutoCondense || keepRecentMessagesAtCompaction === false}
							id="force-full-from-compaction"
							min={0}
							onChange={(event) => {
								const index = readCompactionIndex(event.target.value)
								if (index !== undefined) {
									updateSetting("forceFullFromCompaction", index)
								}
							}}
							step={1}
							type="number"
						/>
					</div>
					<p className="text-xs text-muted-foreground">
						Off by default (0), which leaves the switch above in sole charge: whatever tail policy a run starts with,
						it keeps for the whole run. This defaulted to 2 and that was wrong &mdash; it meant the first compaction
						kept the tail and every later one dropped it, so no run ever used one policy. The first compaction was
						then the weak one by construction: measured on 30 first and 24 later compactions, a median &minus;30%
						leaving 20 messages against &minus;65% leaving 4, after which the context refilled and took a second
						compaction within a median of 12 turns. Set 1 to drop the tail at every compaction, or a higher number to
						bring back the old staged behaviour deliberately.
					</p>
				</div>

				<div className="space-y-2 pt-2">
					<Label className="text-sm font-medium text-foreground">
						{keepRecentMessagesAtCompaction === false ? "Full Compaction Prompt" : "Compaction Prompt"}
					</Label>
					<p className="text-xs text-muted-foreground">
						{keepRecentMessagesAtCompaction === false
							? "The instruction the summarizer is given when nothing is kept. Everything the next turn knows comes from what this produces, so it asks for a fixed set of sections rather than for detail. Leave empty for the built-in prompt."
							: "The instruction the summarizer is given when auto compaction runs. What it writes is prepended to the turns that survive, so it decides what is remembered about the ones that did not. Leave empty for the built-in prompt."}{" "}
						<code>{"{{files_read}}"}</code> and <code>{"{{files_edited}}"}</code> are substituted; the transcript is
						appended automatically. Each strategy keeps its own prompt, so switching the tickbox does not discard the
						other one.
					</p>
					{keepRecentMessagesAtCompaction === false ? (
						<>
							<DebouncedTextArea
								disabled={!useAutoCondense}
								initialValue={fullCompactionPrompt ?? ""}
								maxRows={24}
								minRows={4}
								onChange={(value) => updateSetting("fullCompactionPrompt", value)}
								placeholder={defaultFullCompactionPrompt}
							/>
							<div className="flex flex-wrap items-start gap-2">
								<LoadDefaultPromptButton
									currentValue={fullCompactionPrompt}
									defaultValue={defaultFullCompactionPrompt}
									disabled={!useAutoCondense}
									label="Full Compaction Prompt"
									onLoad={(value) => updateSetting("fullCompactionPrompt", value)}
								/>
								{fullCompactionPrompt?.trim() ? (
									<VSCodeButton
										appearance="secondary"
										onClick={() => updateSetting("fullCompactionPrompt", "")}>
										Reset to default
									</VSCodeButton>
								) : null}
							</div>
						</>
					) : (
						<>
							<DebouncedTextArea
								disabled={!useAutoCondense}
								initialValue={compactionPrompt ?? ""}
								maxRows={24}
								minRows={4}
								onChange={(value) => updateSetting("compactionPrompt", value)}
								placeholder={defaultCompactionPrompt}
							/>
							<div className="flex flex-wrap items-start gap-2">
								<LoadDefaultPromptButton
									currentValue={compactionPrompt}
									defaultValue={defaultCompactionPrompt}
									disabled={!useAutoCondense}
									label="Compaction Prompt"
									onLoad={(value) => updateSetting("compactionPrompt", value)}
								/>
								{compactionPrompt?.trim() ? (
									<VSCodeButton appearance="secondary" onClick={() => updateSetting("compactionPrompt", "")}>
										Reset to default
									</VSCodeButton>
								) : null}
							</div>
						</>
					)}
				</div>

				{/* Directly below, because it is the second half of the same
				    operation: the summary says what happened, this says how it
				    went. */}
				<div className="space-y-2 pt-2">
					<div className="flex items-center justify-between w-full">
						<Label className="text-sm font-medium text-foreground">Thinking Compaction Prompt</Label>
						<Switch
							checked={thinkingCompactionEnabled ?? true}
							className="shrink-0"
							disabled={!useAutoCondense}
							id="thinkingCompactionEnabled"
							onCheckedChange={(checked) => updateSetting("thinkingCompactionEnabled", checked)}
							size="lg"
						/>
					</div>
					<p className="text-xs text-muted-foreground">
						Compaction throws away the model&apos;s reasoning along with the turns, and with it every approach it had
						already ruled out. This is a second pass over that reasoning &mdash; what worked, what wasted time, what
						to do differently &mdash; written as the summary&apos;s own thinking block. Costs one extra model call per
						compaction. Leave empty for the built-in prompt.
					</p>
					<DebouncedTextArea
						disabled={!useAutoCondense || thinkingCompactionEnabled === false}
						initialValue={thinkingCompactionPrompt ?? ""}
						maxRows={24}
						minRows={4}
						onChange={(value) => updateSetting("thinkingCompactionPrompt", value)}
						placeholder={defaultThinkingCompactionPrompt}
					/>
					<div className="flex flex-wrap items-start gap-2">
						<LoadDefaultPromptButton
							currentValue={thinkingCompactionPrompt}
							defaultValue={defaultThinkingCompactionPrompt}
							disabled={!useAutoCondense || thinkingCompactionEnabled === false}
							label="Thinking Compaction Prompt"
							onLoad={(value) => updateSetting("thinkingCompactionPrompt", value)}
						/>
						{thinkingCompactionPrompt?.trim() ? (
							<VSCodeButton appearance="secondary" onClick={() => updateSetting("thinkingCompactionPrompt", "")}>
								Reset to default
							</VSCodeButton>
						) : null}
					</div>
				</div>

				{/* The third thing that rewrites reasoning, and the only one that
				    runs without compaction: it fires on a single capped turn,
				    whatever the transcript is doing. */}
				<div className="space-y-2 pt-2">
					<div className="flex items-center justify-between w-full">
						<Label className="text-sm font-medium text-foreground">Capped Thinking Prompt</Label>
						<Switch
							checked={cappedThinkingEnabled ?? true}
							className="shrink-0"
							id="cappedThinkingEnabled"
							onCheckedChange={(checked) => updateSetting("cappedThinkingEnabled", checked)}
							size="lg"
						/>
					</div>
					<p className="text-xs text-muted-foreground">
						A turn that runs out of thinking budget is cut mid-sentence, and the next turn re-derives the same
						reasoning from the beginning rather than continuing it. This replaces the abandoned reasoning, for the
						next request only, with a note of what it had settled. Needs a thinking budget to detect one, and stands
						down where none is known. Leave empty for the built-in prompt.
					</p>
					<DebouncedTextArea
						disabled={cappedThinkingEnabled === false}
						initialValue={cappedThinkingPrompt ?? ""}
						maxRows={24}
						minRows={4}
						onChange={(value) => updateSetting("cappedThinkingPrompt", value)}
						placeholder={defaultCappedThinkingPrompt}
					/>
					<div className="flex flex-wrap items-start gap-2">
						<LoadDefaultPromptButton
							currentValue={cappedThinkingPrompt}
							defaultValue={defaultCappedThinkingPrompt}
							disabled={cappedThinkingEnabled === false}
							label="Capped Thinking Prompt"
							onLoad={(value) => updateSetting("cappedThinkingPrompt", value)}
						/>
						{cappedThinkingPrompt?.trim() ? (
							<VSCodeButton appearance="secondary" onClick={() => updateSetting("cappedThinkingPrompt", "")}>
								Reset to default
							</VSCodeButton>
						) : null}
					</div>
				</div>
			</Section>
		</div>
	)
}
export default memo(FeatureSettingsSection)

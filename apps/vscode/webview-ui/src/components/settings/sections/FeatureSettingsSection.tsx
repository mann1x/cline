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
		description: "Show rotating tips during the thinking phase to help you discover Cline features.",
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
		description: "Enables git worktree management for running parallel Cline tasks.",
		stateKey: "worktreesEnabled",
		settingKey: "worktreesEnabled",
	},
]

const experimentalFeatures: FeatureToggle[] = [
	{
		id: "yolo",
		label: "Yolo Mode",
		description:
			"Execute tasks without user's confirmation. Auto-switches from Plan to Act mode and disables the ask question tool. Use with extreme caution.",
		stateKey: "yoloModeToggled",
		settingKey: "yoloModeToggled",
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

interface FeatureSettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const FeatureSettingsSection = ({ renderSectionHeader }: FeatureSettingsSectionProps) => {
	const {
		enableCheckpointsSetting,
		hooksEnabled,
		mcpDisplayMode,
		yoloModeToggled,
		useAutoCondense,
		compactionPrompt,
		defaultCompactionPrompt,
		thinkingCompactionEnabled,
		thinkingCompactionPrompt,
		defaultThinkingCompactionPrompt,
		cappedThinkingEnabled,
		cappedThinkingPrompt,
		defaultCappedThinkingPrompt,
		compactionStrategy,
		editVerificationSettings,
		atomicProtocolSettings,
		subagentsEnabled,
		worktreesEnabled,
		remoteConfigSettings,
		backgroundEditEnabled,
		showFeatureTips,
		focusChainSettings,
	} = useExtensionState()

	const isYoloRemoteLocked = remoteConfigSettings?.yoloModeToggled !== undefined

	// State lookup for mapped features
	const featureState: Record<string, boolean | undefined> = {
		showFeatureTips,
		enableCheckpointsSetting,
		hooksEnabled,
		useAutoCondense,
		subagentsEnabled,
		worktreesEnabled: worktreesEnabled?.user,
		backgroundEditEnabled,
		yoloModeToggled: isYoloRemoteLocked ? remoteConfigSettings?.yoloModeToggled : yoloModeToggled,
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
									already tried. Auto engages only where something can be run to judge the change; Always
									engages anyway and asks the model to judge its own work, which is the weaker of the two.
								</p>
								<Select
									onValueChange={(value) => updateSetting("atomicProtocolSettings", { mode: value })}
									value={atomicProtocolSettings?.mode ?? "off"}>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="off">Off</SelectItem>
										<SelectItem value="auto">Auto</SelectItem>
										<SelectItem value="always">Always</SelectItem>
									</SelectContent>
								</Select>
								{atomicProtocolSettings?.mode !== "off" ? (
									<>
										{/* Detection answers "does this workspace still hold
										    together", which a model can leave green with the
										    asked-for thing still broken: a typecheck passes
										    over a game that no longer starts. */}
										<p className="text-xs text-muted-foreground">
											What to run to decide whether the task worked. Yours outranks anything found by
											looking at the workspace — leave it empty and the project's own test, typecheck or
											build is used instead.
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
											Optional: a regular expression the output must match as well. For a check that prints
											whether it worked and exits cleanly either way.
										</p>
										<DebouncedTextArea
											initialValue={atomicProtocolSettings?.oracleExpect ?? ""}
											maxRows={2}
											minRows={1}
											onChange={(value) => updateSetting("atomicProtocolSettings", { oracleExpect: value })}
											placeholder={'"ok":\\s*true'}
										/>
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
									</>
								) : null}
							</div>
							<QaCredentialsField />
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

					{/* Experimental features */}
					<div>
						<div className="text-xs font-medium uppercase tracking-wider mb-3 text-warning/80">Experimental</div>
						<div
							className="relative p-3 pt-0 my-3 rounded-md border border-editor-widget-border/50 w-full"
							id="experimental-features">
							{experimentalFeatures.map((feature) => (
								<FeatureRow
									checked={featureState[feature.stateKey]}
									description={feature.description}
									disabled={feature.id === "yolo" && isYoloRemoteLocked}
									isRemoteLocked={feature.id === "yolo" && isYoloRemoteLocked}
									isVisible={featureVisibility[feature.stateKey] ?? true}
									key={feature.id}
									label={feature.label}
									onChange={(checked) => updateSetting(feature.settingKey, checked)}
									remoteTooltip="This setting is managed by your organization's remote configuration"
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
				    most people never touch. */}
				<div className="space-y-2 pt-2">
					<Label className="text-sm font-medium text-foreground">Compaction Prompt</Label>
					<p className="text-xs text-muted-foreground">
						The instruction the summarizer is given when auto compaction runs. The summary replaces the turns it
						stands for, so this decides what survives. Leave empty for the built-in prompt.{" "}
						<code>{"{{files_read}}"}</code> and <code>{"{{files_edited}}"}</code> are substituted; the transcript is
						appended automatically.
					</p>
					<DebouncedTextArea
						disabled={!useAutoCondense}
						initialValue={compactionPrompt ?? ""}
						maxRows={24}
						minRows={4}
						onChange={(value) => updateSetting("compactionPrompt", value)}
						placeholder={defaultCompactionPrompt}
					/>
					{compactionPrompt?.trim() ? (
						<VSCodeButton appearance="secondary" onClick={() => updateSetting("compactionPrompt", "")}>
							Reset to default
						</VSCodeButton>
					) : null}
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
					{thinkingCompactionPrompt?.trim() ? (
						<VSCodeButton appearance="secondary" onClick={() => updateSetting("thinkingCompactionPrompt", "")}>
							Reset to default
						</VSCodeButton>
					) : null}
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
					{cappedThinkingPrompt?.trim() ? (
						<VSCodeButton appearance="secondary" onClick={() => updateSetting("cappedThinkingPrompt", "")}>
							Reset to default
						</VSCodeButton>
					) : null}
				</div>
			</Section>
		</div>
	)
}
export default memo(FeatureSettingsSection)

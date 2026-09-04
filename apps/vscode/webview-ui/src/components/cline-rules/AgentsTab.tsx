import { parseApiConfigurationProfiles } from "@shared/api-config-profiles"
import { AgentInfo, AgentsResponse, DeleteAgentRequest, EmptyRequest, SaveAgentRequest } from "@shared/proto/index.cline"
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { FileServiceClient } from "@/services/grpc-client"

/**
 * Authoring subagents from the UI, because a format you can only discover by
 * reading source is a feature most people never find (#55).
 *
 * The file stays the artifact: this writes `<workspace>/.cline/agents/*.md` and
 * `~/.cline/agents/*.md`, which is what both the extension and the CLI read.
 * Keeping agents in extension state instead would have given the extension
 * agents the CLI cannot see.
 */

/** The session's own connection, when no profile is named. */
const SESSION_PROFILE = "__session__"

interface StarterAgent {
	label: string
	hint: string
	description: string
	systemPrompt: string
	tools: string[]
}

/**
 * Something to start from, rather than an empty form.
 *
 * The hard part of writing an agent is not the fields, it is knowing what a
 * good `description` sounds like — it is the only thing the lead reads when it
 * decides whether to hand work over, so a vague one produces an agent that is
 * never chosen. Each starter is a worked example of that sentence.
 */
const STARTERS: StarterAgent[] = [
	{
		label: "Reviewer",
		hint: "Reads a change and reports what is wrong with it",
		description:
			"Reviews a change against the surrounding code and reports defects. Use after edits are made, before the work is called done.",
		systemPrompt:
			"You review code that has just been changed.\n\nRead the changed files and the code around them. Report defects: logic that is wrong, cases that are not handled, and places the change disagrees with how the rest of the file works.\n\nReport findings. Do not edit files.",
		tools: ["read_files", "search_codebase"],
	},
	{
		label: "Researcher",
		hint: "Answers questions about how the codebase works",
		description:
			"Answers questions about how something in this codebase works, from its source. Use when a question needs several files read before it can be answered.",
		systemPrompt:
			"You answer questions about this codebase from its source.\n\nFind the code that actually decides the behaviour being asked about, and quote it with its file and line. If the answer differs from what the names suggest, say so.\n\nAnswer the question. Do not edit files.",
		tools: ["read_files", "search_codebase"],
	},
	{
		label: "Test writer",
		hint: "Writes tests for code that already exists",
		description:
			"Writes tests for existing code, matching the conventions of the tests already in the repository. Use when new behaviour needs covering.",
		systemPrompt:
			"You write tests for code that already exists.\n\nRead the existing tests first and match their structure, naming and assertions. Cover the behaviour that would actually break, not the trivial path.\n\nRun the test command when you have written them, and report the result.",
		tools: [],
	},
	{
		label: "Empty",
		hint: "Start from nothing",
		description: "",
		systemPrompt: "",
		tools: [],
	},
]

function emptyAgent(isGlobal: boolean): AgentInfo {
	return AgentInfo.create({
		name: "",
		description: "",
		path: "",
		isGlobal,
		tools: [],
		skills: [],
		providerId: "",
		modelId: "",
		profile: "",
		maxIterations: 0,
		systemPrompt: "",
	})
}

/**
 * One line saying where an agent lives and what it runs on.
 *
 * A profile can be deleted long after an agent was written to name it, and
 * nothing rewrites the agent file when that happens. The agent then fails on
 * its first call with an error the list gave no warning of, so a name that no
 * longer resolves is called out here rather than shown as if it were fine.
 */
function agentSubtitle(agent: AgentInfo, profileNames: string[]): string {
	const where = agent.isGlobal ? "Global" : "Workspace"
	if (agent.profile) {
		const missing = !profileNames.includes(agent.profile)
		return `${where} · ${agent.profile}${missing ? " (missing)" : ""}`
	}
	if (agent.modelId) {
		return `${where} · ${agent.modelId}`
	}
	return `${where} · session's model`
}

interface AgentsTabProps {
	/**
	 * Where a dropdown's popup is rendered. The rules modal closes on any click
	 * outside itself, and a popup portalled to document.body counts as outside.
	 */
	dropdownContainer?: HTMLElement | null
}

const AgentsTab: React.FC<AgentsTabProps> = ({ dropdownContainer }) => {
	const { apiConfigurationProfiles } = useExtensionState()
	const [state, setState] = useState<AgentsResponse | undefined>()
	const [draft, setDraft] = useState<AgentInfo | undefined>()
	const [originalPath, setOriginalPath] = useState<string>("")
	const [error, setError] = useState<string>("")
	const [saving, setSaving] = useState(false)

	const profileNames = useMemo(
		() => parseApiConfigurationProfiles(apiConfigurationProfiles).map((profile) => profile.name),
		[apiConfigurationProfiles],
	)

	const load = useCallback(() => {
		FileServiceClient.refreshAgents(EmptyRequest.create({}))
			.then(setState)
			.catch((loadError) => setError(String(loadError)))
	}, [])

	useEffect(() => {
		load()
	}, [load])

	const startNew = (starter: StarterAgent) => {
		setError("")
		setOriginalPath("")
		setDraft({
			...emptyAgent(state?.hasWorkspace === true),
			description: starter.description,
			systemPrompt: starter.systemPrompt,
			tools: starter.tools.filter((tool) => state?.availableTools.includes(tool) !== false),
		})
	}

	const startEdit = (agent: AgentInfo) => {
		setError("")
		setOriginalPath(agent.path)
		setDraft({ ...agent })
	}

	const save = () => {
		if (!draft) {
			return
		}
		setSaving(true)
		setError("")
		FileServiceClient.saveAgentFile(SaveAgentRequest.create({ agent: draft, originalPath }))
			.then((response) => {
				setState(response)
				setDraft(undefined)
				setOriginalPath("")
			})
			.catch((saveError) => setError(saveError instanceof Error ? saveError.message : String(saveError)))
			.finally(() => setSaving(false))
	}

	const remove = (agent: AgentInfo) => {
		setError("")
		FileServiceClient.deleteAgentFile(DeleteAgentRequest.create({ path: agent.path }))
			.then(setState)
			.catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)))
	}

	const toggleTool = (tool: string) => {
		if (!draft) {
			return
		}
		const next = draft.tools.includes(tool) ? draft.tools.filter((entry) => entry !== tool) : [...draft.tools, tool]
		setDraft({ ...draft, tools: next })
	}

	if (draft) {
		const nameOk = draft.name.trim().length > 0
		const descriptionOk = draft.description.trim().length > 0
		const promptOk = draft.systemPrompt.trim().length > 0

		return (
			<div className="flex flex-col gap-4">
				{error && (
					<div className="px-3 py-2 bg-vscode-inputValidation-errorBackground border-l-[3px] border-vscode-inputValidation-errorBorder text-xs">
						{error}
					</div>
				)}

				<div className="space-y-1">
					<Label htmlFor="agent-name">Name</Label>
					<Input
						autoFocus
						id="agent-name"
						onChange={(event) => setDraft({ ...draft, name: event.target.value })}
						placeholder="reviewer"
						value={draft.name}
					/>
					<p className="text-xs text-description">How the model refers to it, and the name of its file.</p>
				</div>

				<div className="space-y-1">
					<Label htmlFor="agent-description">When to use it</Label>
					<Input
						id="agent-description"
						onChange={(event) => setDraft({ ...draft, description: event.target.value })}
						placeholder="Reviews a change and reports what is wrong with it."
						value={draft.description}
					/>
					<p className="text-xs text-description">
						The only thing read when deciding whether to hand work over. Say what it does and when — a vague
						description produces an agent that is never chosen.
					</p>
				</div>

				<div className="space-y-1">
					<Label htmlFor="agent-profile">Runs on</Label>
					<Select
						onValueChange={(value) => setDraft({ ...draft, profile: value === SESSION_PROFILE ? "" : value })}
						value={draft.profile || SESSION_PROFILE}>
						<SelectTrigger className="w-full" id="agent-profile">
							<SelectValue />
						</SelectTrigger>
						<SelectContent container={dropdownContainer ?? undefined}>
							<SelectItem value={SESSION_PROFILE}>The session's own model</SelectItem>
							{/*
							 * A profile the agent names but that no longer exists is
							 * offered as an item of its own. Without it the trigger
							 * renders empty -- the agent looks like it runs on the
							 * session's model, when in fact it fails on its first
							 * call -- and there is nothing to replace.
							 */}
							{draft.profile && !profileNames.includes(draft.profile) && (
								<SelectItem value={draft.profile}>{draft.profile} (missing)</SelectItem>
							)}
							{profileNames.map((name) => (
								<SelectItem key={name} value={name}>
									{name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{draft.profile && !profileNames.includes(draft.profile) ? (
						<p className="text-xs text-error">
							The profile “{draft.profile}” no longer exists, so this agent fails when it is called. Pick another
							one, or the session's own model, and save.
						</p>
					) : null}
					<p className="text-xs text-description">
						A saved configuration profile carries the provider, the model and the context window together, so this is
						also how an agent runs on a different provider than the session.
					</p>
				</div>

				<div className="space-y-1">
					<Label>Tools</Label>
					<p className="text-xs text-description">
						Leave everything unchecked to give it the session's full set. Check some to restrict it to those.
					</p>
					<div className="flex flex-wrap gap-1 pt-1">
						{(state?.availableTools ?? []).map((tool) => {
							const selected = draft.tools.includes(tool)
							return (
								<button
									className={`px-2 py-0.5 rounded text-xs border ${
										selected
											? "bg-vscode-button-background text-vscode-button-foreground border-transparent"
											: "bg-transparent text-description border-vscode-panel-border"
									}`}
									key={tool}
									onClick={() => toggleTool(tool)}
									type="button">
									{tool}
								</button>
							)
						})}
					</div>
				</div>

				<div className="space-y-1">
					<Label htmlFor="agent-prompt">Prompt</Label>
					<textarea
						className="w-full min-h-[8rem] bg-input-background text-input-foreground border border-vscode-panel-border rounded p-2 text-xs font-mono"
						id="agent-prompt"
						onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })}
						placeholder="You review code that has just been changed…"
						value={draft.systemPrompt}
					/>
					<p className="text-xs text-description">What it does, and what it must not do. This is its whole brief.</p>
				</div>

				<div className="space-y-1">
					<Label htmlFor="agent-scope">Available in</Label>
					<Select
						onValueChange={(value) => setDraft({ ...draft, isGlobal: value === "global" })}
						value={draft.isGlobal ? "global" : "workspace"}>
						<SelectTrigger className="w-full" id="agent-scope">
							<SelectValue />
						</SelectTrigger>
						<SelectContent container={dropdownContainer ?? undefined}>
							<SelectItem value="workspace">This workspace only</SelectItem>
							<SelectItem value="global">Every workspace</SelectItem>
						</SelectContent>
					</Select>
					{!state?.hasWorkspace && (
						<p className="text-xs text-description">No folder is open, so a new agent can only be global.</p>
					)}
				</div>

				<div className="flex gap-2 pb-2">
					<Button disabled={!nameOk || !descriptionOk || !promptOk || saving} onClick={save}>
						{saving ? "Saving…" : "Save agent"}
					</Button>
					<Button
						onClick={() => {
							setDraft(undefined)
							setError("")
						}}
						variant="secondary">
						Cancel
					</Button>
				</div>
			</div>
		)
	}

	const agents = state?.agents ?? []

	return (
		<div className="flex flex-col gap-3">
			{error && (
				<div className="px-3 py-2 bg-vscode-inputValidation-errorBackground border-l-[3px] border-vscode-inputValidation-errorBorder text-xs">
					{error}
				</div>
			)}

			{state?.errors.map((entry) => (
				<div
					className="px-3 py-2 bg-vscode-inputValidation-warningBackground border-l-[3px] border-vscode-inputValidation-warningBorder text-xs"
					key={entry}>
					{entry}
				</div>
			))}

			{agents.length > 0 ? (
				<div className="flex flex-col gap-0">
					{agents.map((agent) => (
						<div
							className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-list-hover-background"
							key={agent.path || agent.name}>
							<div className="flex-1 min-w-0">
								<div className="text-sm truncate">{agent.name}</div>
								<div className="text-xs text-description truncate">{agentSubtitle(agent, profileNames)}</div>
							</div>
							<Button
								aria-label={`Edit ${agent.name}`}
								onClick={() => startEdit(agent)}
								size="icon"
								variant="ghost">
								<PencilIcon className="size-3.5" />
							</Button>
							<Button aria-label={`Delete ${agent.name}`} onClick={() => remove(agent)} size="icon" variant="ghost">
								<Trash2Icon className="size-3.5" />
							</Button>
						</div>
					))}
				</div>
			) : (
				<p className="text-xs text-description">
					No agents yet. Start from one of these — you can change everything afterwards.
				</p>
			)}

			<div className="flex flex-col gap-1">
				{STARTERS.map((starter) => (
					<button
						className="flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-list-hover-background"
						key={starter.label}
						onClick={() => startNew(starter)}
						type="button">
						<PlusIcon className="size-3.5 shrink-0" />
						<span className="text-sm">{starter.label}</span>
						<span className="text-xs text-description truncate">{starter.hint}</span>
					</button>
				))}
			</div>
		</div>
	)
}

export default AgentsTab

import { getShippedToolCallSignatures, loadConfiguredAgentConfigs } from "@cline/core"
import { resolveAgentConfigSearchPaths, resolveAgentsConfigDirPath } from "@cline/shared/storage"
import { AgentInfo, AgentsResponse } from "@shared/proto/cline/file"
import fs from "fs/promises"
import path from "path"
import { HostProvider } from "@/hosts/host-provider"

/**
 * Reading, writing and deleting the files that define subagents.
 *
 * The file is the artifact and stays that way. The tab is an editor over
 * `<workspace>/.cline/agents/*.md` and `~/.cline/agents/*.md`, which is what
 * both hosts already read — storing agents in extension state instead would
 * have given the extension agents the CLI cannot see.
 */

/**
 * Tools a subagent must never be handed, whatever the picker offers.
 *
 * Delegation is the pair: a sub-agent that spawns its own arrives at the slot
 * gate with its parent's slot still held, and on a one-slot endpoint that is
 * the hang the gate exists to prevent. `submit_and_exit` is how a sub-agent
 * returns, so it is not the user's to remove either.
 */
const TOOLS_NOT_OFFERED = new Set(["spawn_agent", "submit_and_exit"])

/** Frontmatter keys, in the order they are written. */
const FRONTMATTER_ORDER = ["name", "description", "profile", "providerId", "modelId", "tools", "skills", "maxIterations"]

/**
 * A YAML scalar that cannot be read as anything but the string it is.
 *
 * Always quoted rather than quoted-when-necessary. A description is free text
 * a user typed, and the shapes that change meaning unquoted are the ordinary
 * ones — `Reviews code: carefully` is a mapping, `yes` is a boolean, `1.0` is
 * a number — so guessing which need it is a bug waiting for the right
 * sentence. Double quotes with the two escapes YAML defines for them.
 */
function yamlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/**
 * A file name that cannot escape the agents directory or collide with the
 * shell. The agent's `name` is the identity the model sees; this is only where
 * it is kept.
 */
export function agentFileName(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
	return `${slug || "agent"}.md`
}

async function primaryWorkspacePath(): Promise<string | undefined> {
	const workspacePaths = await HostProvider.workspace.getWorkspacePaths({})
	return workspacePaths.paths[0]
}

/**
 * The two directories, resolved the same way the runtime resolves them.
 *
 * Returned even when they do not exist: a tab that cannot say where a new
 * agent would go is the same tab that leaves a user guessing, which is what
 * #55 was.
 */
export async function agentDirectories(): Promise<{
	global: string
	workspace?: string
	searchPaths: string[]
}> {
	const workspaceRoot = await primaryWorkspacePath()
	return {
		global: resolveAgentsConfigDirPath(),
		...(workspaceRoot ? { workspace: path.join(workspaceRoot, ".cline", "agents") } : {}),
		searchPaths: resolveAgentConfigSearchPaths(workspaceRoot).filter(Boolean),
	}
}

/** Tool names an agent may be restricted to, from the runtime's own list. */
function availableToolNames(): string[] {
	return getShippedToolCallSignatures()
		.map((signature) => signature.name)
		.filter((name) => !TOOLS_NOT_OFFERED.has(name))
		.sort((a, b) => a.localeCompare(b))
}

/** Lists what is on disk now. Never throws for a file that will not parse. */
export async function listAgents(): Promise<AgentsResponse> {
	const directories = await agentDirectories()
	const loaded = loadConfiguredAgentConfigs({
		searchPaths: directories.searchPaths,
	})

	const agents = loaded.configs.map((config) =>
		AgentInfo.create({
			name: config.name,
			description: config.description,
			path: config.path ?? "",
			isGlobal: config.path ? path.dirname(config.path) === directories.global : true,
			tools: config.tools ?? [],
			skills: config.skills ?? [],
			providerId: config.providerId ?? "",
			modelId: config.modelId ?? "",
			profile: config.profile ?? "",
			maxIterations: config.maxIterations ?? 0,
			systemPrompt: config.systemPrompt,
		}),
	)

	return AgentsResponse.create({
		agents,
		availableTools: availableToolNames(),
		searchPaths: loaded.searchPaths,
		errors: loaded.errors.map((entry) => `${entry.path}: ${entry.error.message}`),
		hasWorkspace: directories.workspace !== undefined,
	})
}

/**
 * Renders an agent back to the file format.
 *
 * Only the keys the user actually set are written. An empty `tools` list is
 * absence, not "no tools": the loader reads a missing `tools` as "every tool
 * the session has", and a file that pinned an empty list would produce an
 * agent that can do nothing at all.
 */
export function renderAgentFile(agent: AgentInfo): string {
	const frontmatter: Record<string, unknown> = {
		name: agent.name.trim(),
		description: agent.description.trim(),
	}
	if (agent.profile) {
		frontmatter.profile = agent.profile
	}
	if (agent.providerId) {
		frontmatter.providerId = agent.providerId
	}
	if (agent.modelId) {
		frontmatter.modelId = agent.modelId
	}
	if (agent.tools.length > 0) {
		frontmatter.tools = agent.tools
	}
	if (agent.skills.length > 0) {
		frontmatter.skills = agent.skills
	}
	if (agent.maxIterations > 0) {
		frontmatter.maxIterations = agent.maxIterations
	}

	const lines = FRONTMATTER_ORDER.filter((key) => key in frontmatter).map((key) => {
		const value = frontmatter[key]
		if (Array.isArray(value)) {
			return [`${key}:`, ...value.map((entry) => `  - ${yamlString(String(entry))}`)].join("\n")
		}
		return typeof value === "number" ? `${key}: ${value}` : `${key}: ${yamlString(String(value))}`
	})
	return `---\n${lines.join("\n")}\n---\n\n${agent.systemPrompt.trim()}\n`
}

/**
 * Writes one agent, and removes the file it used to be in.
 *
 * A rename changes the file name, and moving between global and workspace
 * changes the directory. Without removing the original, either edit leaves two
 * agents on disk where the user edited one — and since the loader takes the
 * first of a duplicated name, the stale copy can be the one that wins.
 */
export async function writeAgent(agent: AgentInfo, originalPath: string | undefined): Promise<void> {
	const name = agent.name.trim()
	if (!name) {
		throw new Error("An agent needs a name.")
	}
	if (!agent.description.trim()) {
		throw new Error("An agent needs a description: it is what the lead reads when it chooses one.")
	}
	if (!agent.systemPrompt.trim()) {
		throw new Error("An agent needs a prompt saying what it does.")
	}

	const directories = await agentDirectories()
	const directory = agent.isGlobal ? directories.global : directories.workspace
	if (!directory) {
		throw new Error("No workspace folder is open, so a workspace agent has nowhere to go. Save it as global instead.")
	}

	const target = path.join(directory, agentFileName(name))
	await fs.mkdir(directory, { recursive: true })
	await fs.writeFile(target, renderAgentFile(agent), "utf-8")

	if (originalPath && path.resolve(originalPath) !== path.resolve(target)) {
		await fs.rm(originalPath, { force: true })
	}
}

/** Removes one agent file. A path that is already gone is not an error. */
export async function removeAgent(filePath: string): Promise<void> {
	if (!filePath) {
		throw new Error("No agent file to delete.")
	}
	const directories = await agentDirectories()
	const parent = path.dirname(path.resolve(filePath))
	const allowed = [directories.global, directories.workspace]
		.filter(Boolean)
		.map((directory) => path.resolve(directory as string))
	// The path came back over the wire, so it is checked rather than trusted:
	// only a file that sits directly in one of the two agents directories can
	// be removed from here.
	if (!allowed.includes(parent)) {
		throw new Error("That file is not in an agents directory.")
	}
	await fs.rm(filePath, { force: true })
}

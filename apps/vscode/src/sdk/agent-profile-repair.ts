import { parseApiConfigurationProfiles } from "@shared/api-config-profiles"
import type { AgentInfo } from "@shared/proto/cline/file"
import { ShowMessageType } from "@shared/proto/host/window"
import { listAgents, writeAgent } from "@/core/controller/file/agent-files"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"

/**
 * Offer to repair agents that name a saved profile which no longer exists.
 *
 * Nothing rewrites an agent file when a profile is deleted, so the agent keeps
 * pointing at a name that resolves to nothing and fails on its first call --
 * partway through a task, which reads as the subagent being broken rather than
 * as configuration that went stale months after it was written.
 *
 * The repair happens here rather than by sending the user to the settings UI
 * because everything it needs is already on this side: the profiles that exist
 * and the agent files that name them. Picking one rewrites the file.
 */

/** One offer per agent-and-dead-profile, so a declined prompt does not return every session. */
const offered = new Set<string>()

/** Only for tests: forget what has already been offered. */
export function resetAgentProfileRepairOffers(): void {
	offered.clear()
}

const SESSION_MODEL_CHOICE = "Use the session's own model"
const PICK_ACTION = "Pick a profile"

/**
 * The modal's buttons are the profiles themselves, so a long list would produce
 * a dialog nobody can read. Past this the file is the better place to work.
 */
const MAX_OFFERED_PROFILES = 6
const OPEN_FILE_CHOICE = "Open the agent file"

function offerKey(agent: AgentInfo): string {
	return `${agent.path} ${agent.profile}`
}

function describe(agents: AgentInfo[]): string {
	if (agents.length === 1) {
		const agent = agents[0]
		return `Subagent "${agent.name}" runs on the API configuration profile "${agent.profile}", which no longer exists. It will fail when it is called.`
	}
	return `${agents.length} subagents run on API configuration profiles that no longer exist, and will fail when they are called: ${agents
		.map((agent) => `"${agent.name}" (${agent.profile})`)
		.join(", ")}.`
}

async function repair(agent: AgentInfo, profileNames: string[]): Promise<void> {
	const choices =
		profileNames.length > MAX_OFFERED_PROFILES
			? [...profileNames.slice(0, MAX_OFFERED_PROFILES), OPEN_FILE_CHOICE]
			: [...profileNames, SESSION_MODEL_CHOICE]

	const picked = (
		await HostProvider.window.showMessage({
			type: ShowMessageType.WARNING,
			message: `What should "${agent.name}" run on instead of "${agent.profile}"?`,
			options: { modal: true, items: choices },
		})
	).selectedOption

	if (!picked) {
		return
	}
	if (picked === OPEN_FILE_CHOICE) {
		if (agent.path) {
			await HostProvider.window.openFile({ filePath: agent.path })
		}
		return
	}

	// An empty profile is absence, which the loader reads as "the session's own
	// configuration" -- the same thing the agent would have done with no profile
	// key at all.
	await writeAgent({ ...agent, profile: picked === SESSION_MODEL_CHOICE ? "" : picked }, agent.path || undefined)

	await HostProvider.window.showMessage({
		type: ShowMessageType.INFORMATION,
		message:
			picked === SESSION_MODEL_CHOICE
				? `"${agent.name}" now runs on the session's own model.`
				: `"${agent.name}" now runs on "${picked}".`,
		options: { items: [] },
	})
}

/**
 * Checks the agent files against the saved profiles and, if any name one that
 * is gone, offers to repoint them.
 *
 * Never throws and never blocks: a session must start whether or not this can
 * read the agent directory, so callers fire it and move on.
 */
export async function offerAgentProfileRepair(storedProfiles: string | undefined): Promise<void> {
	try {
		const profileNames = parseApiConfigurationProfiles(storedProfiles).map((profile) => profile.name)
		const { agents } = await listAgents()
		const broken = agents.filter((agent) => agent.profile && !profileNames.includes(agent.profile))
		const unoffered = broken.filter((agent) => !offered.has(offerKey(agent)))
		if (unoffered.length === 0) {
			return
		}
		for (const agent of unoffered) {
			offered.add(offerKey(agent))
		}

		// With no profiles saved there is nothing to repoint them at, so the
		// notice is the whole of what can be offered.
		if (profileNames.length === 0) {
			await HostProvider.window.showMessage({
				type: ShowMessageType.WARNING,
				message: `${describe(unoffered)} There are no saved profiles to point them at.`,
				options: { items: [] },
			})
			return
		}

		const action = (
			await HostProvider.window.showMessage({
				type: ShowMessageType.WARNING,
				message: describe(unoffered),
				options: { items: [PICK_ACTION] },
			})
		).selectedOption

		if (action !== PICK_ACTION) {
			return
		}
		for (const agent of unoffered) {
			await repair(agent, profileNames)
		}
	} catch (error) {
		Logger.warn(`[agents] Could not check agent profiles: ${error instanceof Error ? error.message : String(error)}`)
	}
}

import { type RemoteTerminalsConfig, type RemoteWorkspaceRecord, removeRemoteWorkspace } from "@cline/core"
import { StateManager } from "@/core/storage/StateManager"
import {
	addRemoteWorkspace,
	expiredRemoteWorkspaces,
	isUsableRemoteTerminal,
	markRemoteWorkspacesDeleted,
	parseRemoteTerminals,
	parseRemoteWorkspaces,
} from "@/shared/remote-terminals"
import { Logger } from "@/shared/services/Logger"

/**
 * The Remote terminals tab as the configuration core builds the remote tools
 * from, or `undefined` while the tab's switch is off. Read again on every call:
 * the tab can change mid-session.
 */
export function readRemoteTerminalsConfig(): RemoteTerminalsConfig | undefined {
	const state = StateManager.get()
	if (state.getGlobalSettingsKey("remoteTerminalsEnabled") !== true) {
		return undefined
	}
	const stored = parseRemoteTerminals(state.getGlobalSettingsKey("remoteTerminals"))
	return {
		openWebUiUrl: stored.openWebUiUrl,
		apiKey: state.getSecretKey("openWebUiApiKey")?.trim() || undefined,
		terminals: stored.terminals.filter(isUsableRemoteTerminal).map((terminal) => ({
			name: terminal.name,
			machineId: terminal.machineId,
			...(terminal.description ? { description: terminal.description } : {}),
		})),
	}
}

function readRegistry() {
	return parseRemoteWorkspaces(StateManager.get().getGlobalStateKey("remoteWorkspaces"))
}

function writeRegistry(entries: ReturnType<typeof readRegistry>): void {
	StateManager.get().setGlobalState("remoteWorkspaces", JSON.stringify(entries))
}

/** A session used a machine for the first time: remember it, for the retention sweep. */
export function recordRemoteWorkspace(record: RemoteWorkspaceRecord): void {
	try {
		writeRegistry(addRemoteWorkspace(readRegistry(), record, Date.now()))
	} catch (error) {
		Logger.error("[RemoteTerminals] could not record a workspace:", error)
	}
}

/**
 * Conversations were deleted: their workspaces start the retention clock. The
 * folders stay on the machines until the sweep finds them expired.
 */
export function markRemoteWorkspacesDeletedFor(taskIds: readonly string[]): void {
	if (taskIds.length === 0) return
	try {
		const entries = readRegistry()
		if (entries.length === 0) return
		writeRegistry(markRemoteWorkspacesDeleted(entries, new Set(taskIds), Date.now()))
	} catch (error) {
		Logger.error("[RemoteTerminals] could not mark workspaces deleted:", error)
	}
}

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000
let lastSweep = 0
let sweeping: Promise<void> | undefined

/**
 * Removes the workspaces whose conversation was deleted more than the tab's
 * retention ago. At most every six hours; a removal that fails stays listed
 * and is tried again at the next sweep. Needs the Open WebUI URL and key, not
 * the tools' switch: turning the tools off must not strand the folders.
 */
export function sweepRemoteWorkspaces(now = Date.now()): Promise<void> {
	if (sweeping || now - lastSweep < SWEEP_INTERVAL_MS) return sweeping ?? Promise.resolve()
	lastSweep = now
	sweeping = (async () => {
		try {
			const state = StateManager.get()
			// Any deletion path counts, not only the one that calls
			// `markRemoteWorkspacesDeletedFor`: a workspace whose conversation is
			// no longer in the history starts its clock when the sweep notices.
			const known = new Set((state.getGlobalStateKey("taskHistory") ?? []).map((item) => item.id))
			const orphaned = readRegistry()
				.filter((entry) => entry.deletedAt === undefined && !known.has(entry.workspaceId))
				.map((entry) => entry.workspaceId)
			if (orphaned.length > 0) {
				writeRegistry(markRemoteWorkspacesDeleted(readRegistry(), new Set(orphaned), now))
			}
			const stored = parseRemoteTerminals(state.getGlobalSettingsKey("remoteTerminals"))
			const apiKey = state.getSecretKey("openWebUiApiKey")?.trim()
			const expired = expiredRemoteWorkspaces(readRegistry(), stored.retentionDays, now)
			if (expired.length === 0 || !stored.openWebUiUrl || !apiKey) return
			const config: RemoteTerminalsConfig = { openWebUiUrl: stored.openWebUiUrl, apiKey, terminals: [] }
			const removed = new Set<string>()
			for (const entry of expired) {
				try {
					await removeRemoteWorkspace(config, entry)
					removed.add(`${entry.machineId}\u0000${entry.workspaceId}`)
					Logger.log(`[RemoteTerminals] removed ${entry.path} on ${entry.terminal}`)
				} catch (error) {
					Logger.error(`[RemoteTerminals] could not remove ${entry.path} on ${entry.terminal}:`, error)
				}
			}
			if (removed.size > 0) {
				writeRegistry(readRegistry().filter((entry) => !removed.has(`${entry.machineId}\u0000${entry.workspaceId}`)))
			}
		} finally {
			sweeping = undefined
		}
	})()
	return sweeping
}

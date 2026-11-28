/**
 * The Remote terminals tab's stored settings (`remoteTerminals`, one JSON
 * string) and the workspace registry (`remoteWorkspaces`), read the same way by
 * the host and the webview. The Open WebUI API key is a secret and never here.
 */

export interface StoredRemoteTerminal {
	name: string
	machineId: string
	description?: string
	/** Off keeps the entry without offering it. Absent means on. */
	enabled?: boolean
}

export interface StoredRemoteTerminals {
	openWebUiUrl: string
	/** Days a deleted conversation's workspace is kept before it is removed. */
	retentionDays: number
	terminals: StoredRemoteTerminal[]
}

export const DEFAULT_REMOTE_RETENTION_DAYS = 7

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : ""
}

export function parseRemoteTerminals(raw: string | undefined): StoredRemoteTerminals {
	let parsed: Record<string, unknown> | undefined
	try {
		parsed = raw ? record(JSON.parse(raw)) : undefined
	} catch {
		parsed = undefined
	}
	const days = Number(parsed?.retentionDays)
	const terminals = Array.isArray(parsed?.terminals) ? parsed.terminals : []
	return {
		openWebUiUrl: text(parsed?.openWebUiUrl),
		retentionDays: Number.isFinite(days) && days >= 0 ? Math.floor(days) : DEFAULT_REMOTE_RETENTION_DAYS,
		terminals: terminals.flatMap((entry) => {
			const item = record(entry)
			if (!item) return []
			const terminal: StoredRemoteTerminal = { name: text(item.name), machineId: text(item.machineId) }
			const description = text(item.description)
			if (description) terminal.description = description
			if (item.enabled === false) terminal.enabled = false
			return [terminal]
		}),
	}
}

export function serializeRemoteTerminals(settings: StoredRemoteTerminals): string {
	return JSON.stringify(settings)
}

/** A terminal the tools may offer: named, pointed at a machine, not switched off. */
export function isUsableRemoteTerminal(terminal: StoredRemoteTerminal): boolean {
	return terminal.enabled !== false && !!terminal.name.trim() && !!terminal.machineId.trim()
}

/** Terminal names are what the model uses, so they must be unique, ignoring case. */
export function duplicateRemoteTerminalNames(terminals: readonly StoredRemoteTerminal[]): string[] {
	const seen = new Map<string, number>()
	for (const terminal of terminals) {
		const key = terminal.name.trim().toLowerCase()
		if (key) seen.set(key, (seen.get(key) ?? 0) + 1)
	}
	return [...seen].filter(([, count]) => count > 1).map(([name]) => name)
}

export interface RemoteWorkspaceEntry {
	terminal: string
	machineId: string
	workspaceId: string
	path: string
	/** Epoch millis of the first use. */
	firstUsed: number
	/** Epoch millis when its conversation was deleted; absent while it exists. */
	deletedAt?: number
}

export function parseRemoteWorkspaces(raw: string | undefined): RemoteWorkspaceEntry[] {
	let parsed: unknown
	try {
		parsed = raw ? JSON.parse(raw) : []
	} catch {
		return []
	}
	if (!Array.isArray(parsed)) return []
	return parsed.flatMap((entry) => {
		const item = record(entry)
		if (!item) return []
		const workspace: RemoteWorkspaceEntry = {
			terminal: text(item.terminal),
			machineId: text(item.machineId),
			workspaceId: text(item.workspaceId),
			path: text(item.path),
			firstUsed: typeof item.firstUsed === "number" ? item.firstUsed : 0,
		}
		if (typeof item.deletedAt === "number") workspace.deletedAt = item.deletedAt
		return workspace.machineId && workspace.workspaceId ? [workspace] : []
	})
}

/** The registry with one more workspace, or unchanged when it is already listed. */
export function addRemoteWorkspace(
	entries: readonly RemoteWorkspaceEntry[],
	entry: Omit<RemoteWorkspaceEntry, "firstUsed" | "deletedAt">,
	now: number,
): RemoteWorkspaceEntry[] {
	if (entries.some((known) => known.machineId === entry.machineId && known.workspaceId === entry.workspaceId)) {
		return [...entries]
	}
	return [...entries, { ...entry, firstUsed: now }]
}

/** Marks every workspace of these sessions as deleted now (the retention clock starts). */
export function markRemoteWorkspacesDeleted(
	entries: readonly RemoteWorkspaceEntry[],
	workspaceIds: ReadonlySet<string>,
	now: number,
): RemoteWorkspaceEntry[] {
	return entries.map((entry) =>
		workspaceIds.has(entry.workspaceId) && entry.deletedAt === undefined ? { ...entry, deletedAt: now } : entry,
	)
}

/** The workspaces whose conversation was deleted more than `retentionDays` ago. */
export function expiredRemoteWorkspaces(
	entries: readonly RemoteWorkspaceEntry[],
	retentionDays: number,
	now: number,
): RemoteWorkspaceEntry[] {
	const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
	return entries.filter((entry) => entry.deletedAt !== undefined && entry.deletedAt <= cutoff)
}

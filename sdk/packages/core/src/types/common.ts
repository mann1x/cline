import { SESSION_STATUS_VALUES } from "@cline/shared";

export const SESSION_STATUSES = SESSION_STATUS_VALUES;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const NON_TERMINAL_SESSION_STATUSES = [
	"idle",
	"running",
	"pending",
] as const satisfies readonly SessionStatus[];

export type NonTerminalSessionStatus =
	(typeof NON_TERMINAL_SESSION_STATUSES)[number];

export type TerminalSessionStatus = Exclude<
	SessionStatus,
	NonTerminalSessionStatus
>;

export function isTerminalSessionStatus(
	status: SessionStatus,
): status is TerminalSessionStatus {
	return !NON_TERMINAL_SESSION_STATUSES.includes(
		status as NonTerminalSessionStatus,
	);
}

export function isNonTerminalSessionStatus(
	status: SessionStatus,
): status is NonTerminalSessionStatus {
	return !isTerminalSessionStatus(status);
}

/**
 * Metadata keys written when a session is declared dead by the stale-session
 * reconciler.
 *
 * Shared because two places have to agree on them: the reconciler that writes
 * them, and the status write that clears them when the session turns out to be
 * alive after all.
 */
export const SESSION_TERMINAL_MARKER_KEYS = [
	"terminal_marker",
	"terminal_marker_at",
	"terminal_marker_pid",
	"terminal_marker_source",
] as const;

/** Strip the reconciler's death certificate from a metadata bag. */
export function withoutSessionTerminalMarkers(
	metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
	if (!metadata) {
		return undefined;
	}
	const next = { ...metadata };
	let changed = false;
	for (const key of SESSION_TERMINAL_MARKER_KEYS) {
		if (key in next) {
			delete next[key];
			changed = true;
		}
	}
	return changed ? next : metadata;
}

export const SessionSource = {
	CORE: "core",
	CLI: "cli",
	SUBAGENT: "subagent",
	DESKTOP: "desktop",
	KANBAN: "kanban",
	API: "api",
	WEB: "web",
	VSCODE: "vscode",
	ENTERPRISE: "enterprise",
	IDE: "ide",
	JETBRAINS: "jetbrains",
	NEOVIM: "neovim",
	UNKNOWN: "unknown",
} as const;

export type BuiltinSessionSource =
	(typeof SessionSource)[keyof typeof SessionSource];

export type SessionSource = BuiltinSessionSource | (string & {});

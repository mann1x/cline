import { normalizeQaCredentials, type QaCredential, type RejectedQaCredential } from "@cline/core"
import { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"

/**
 * The user's QA credentials, read out of VS Code's secret storage.
 *
 * A secret and not a setting, because settings travel to the webview as one
 * `state_json` string and these must never be in it. What the settings view gets
 * instead is the list of *names*, which is also all the model ever sees.
 *
 * Read on demand rather than captured at session start: the set is editable
 * while a session runs, and the tool description is rebuilt for every model
 * request, so a credential added mid-session is usable on the next request.
 */
export function readQaCredentials(): QaCredential[] {
	const stored = StateManager.get().getSecretKey("qaCredentials")
	if (!stored) {
		return []
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(stored)
	} catch {
		// Never log the payload itself: it is the secret. Losing the set is
		// recoverable by re-entering it; printing it to the output channel is not.
		Logger.log("[QaCredentials] Stored credentials could not be parsed; treating as none configured")
		return []
	}
	if (!Array.isArray(parsed)) {
		Logger.log("[QaCredentials] Stored credentials were not a list; treating as none configured")
		return []
	}
	const { credentials, rejected } = normalizeQaCredentials(
		parsed.filter((entry): entry is QaCredential => {
			return (
				typeof entry === "object" &&
				entry !== null &&
				typeof (entry as QaCredential).name === "string" &&
				typeof (entry as QaCredential).value === "string"
			)
		}),
	)
	logRejected(rejected)
	return credentials
}

function logRejected(rejected: RejectedQaCredential[]): void {
	for (const entry of rejected) {
		// Names, never values. A rejected credential is one the user believes is
		// configured, so saying nothing would leave a QA run failing for a reason
		// nothing reports.
		Logger.log(`[QaCredentials] ${entry.name} is not in use: ${entry.reason}`)
	}
}

/** What the settings view is allowed to know: the names, and nothing else. */
export function readQaCredentialNames(): string[] {
	return readQaCredentials().map((credential) => credential.name)
}

/**
 * Apply a change to the stored set.
 *
 * A delta rather than a wholesale write because the only thing that edits this
 * is the settings view, and the settings view has never been told the values --
 * it knows the names. So a credential the user did not touch has to survive by
 * being left alone here, not by being sent back.
 *
 * `set` adds or replaces by name; `remove` deletes by name. Both are applied
 * against what is stored right now, and the result is re-validated as a whole,
 * so a change cannot leave the store holding something the reader would reject.
 */
export function updateQaCredentials(update: { set?: QaCredential[]; remove?: string[] }): RejectedQaCredential[] {
	const removed = new Set(update.remove ?? [])
	const replaced = new Map((update.set ?? []).map((credential) => [credential.name, credential]))
	const merged: QaCredential[] = []
	for (const existing of readQaCredentials()) {
		if (removed.has(existing.name)) {
			continue
		}
		merged.push(replaced.get(existing.name) ?? existing)
		replaced.delete(existing.name)
	}
	for (const added of replaced.values()) {
		if (!removed.has(added.name)) {
			merged.push(added)
		}
	}

	const { credentials: accepted, rejected } = normalizeQaCredentials(merged)
	StateManager.get().setSecret("qaCredentials", accepted.length > 0 ? JSON.stringify(accepted) : undefined)
	logRejected(rejected)
	return rejected
}

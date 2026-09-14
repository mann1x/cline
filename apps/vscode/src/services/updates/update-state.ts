/**
 * The updater's own two facts: when it last looked, and what the user skipped.
 *
 * Not in `StateManager`. That store is a typed union of keys which is exported
 * to `~/.cline/data/` and shared across VS Code, the CLI and JetBrains — and
 * these two are neither shared nor interesting to anything else: one throttles
 * a GitHub request, the other remembers a button someone pressed. Adding them
 * there would widen a schema that several hosts read, for bookkeeping that
 * belongs to one install.
 *
 * So it is a small file beside the download directory the updater already owns.
 * Every read tolerates it being absent, truncated or garbage, because the one
 * behaviour that must never happen is an unreadable state file stopping the
 * extension from starting — the worst a lost file can cost is one extra check.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"

export interface UpdateState {
	/** Epoch ms of the last completed check. */
	lastCheckedAt?: number
	/** A version the user asked not to be told about again. */
	skippedVersion?: string
}

export function updateStatePath(globalStoragePath: string): string {
	return path.join(globalStoragePath, "updates", "state.json")
}

export async function readUpdateState(globalStoragePath: string): Promise<UpdateState> {
	try {
		const body = await fs.readFile(updateStatePath(globalStoragePath), "utf8")
		const parsed: unknown = JSON.parse(body)
		if (!parsed || typeof parsed !== "object") {
			return {}
		}
		const record = parsed as Record<string, unknown>
		return {
			...(typeof record.lastCheckedAt === "number" ? { lastCheckedAt: record.lastCheckedAt } : {}),
			...(typeof record.skippedVersion === "string" ? { skippedVersion: record.skippedVersion } : {}),
		}
	} catch {
		// Absent on a fresh install, and unparseable if a disk filled mid-write.
		// Both mean "nothing is known", which is the correct starting state.
		return {}
	}
}

export async function writeUpdateState(globalStoragePath: string, state: UpdateState): Promise<void> {
	const file = updateStatePath(globalStoragePath)
	try {
		await fs.mkdir(path.dirname(file), { recursive: true })
		await fs.writeFile(file, JSON.stringify(state), "utf8")
	} catch {
		// Losing this costs one extra check on the next window. It must never
		// propagate: this runs on the activation path.
	}
}

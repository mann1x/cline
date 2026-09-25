import type { Dirent } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import path from "node:path"

/**
 * One session's footprint on disk, split by what wrote it.
 *
 * Everything a session writes lives under its own directory: the lead's
 * transcript, manifest and compaction state; one `agent_*.messages.json` per
 * delegated agent; and `agent-overlays/<toolCallId>/`, where each delegated
 * agent's writes land as private copies of workspace files. That is also why
 * deleting the session removes all of it -- the delete takes the directory
 * whole. Checkpoints are the one thing kept elsewhere (git refs in the
 * workspace), and their objects are shared with the repository, so they are
 * counted by the caller rather than sized here.
 */
export interface SessionFootprint {
	totalBytes: number
	sessionBytes: number
	agentTranscriptBytes: number
	overlayBytes: number
}

export const AGENT_OVERLAYS_DIR = "agent-overlays"

const AGENT_TRANSCRIPT = /^agent_.+\.messages\.json$/

type Bucket = "session" | "agent" | "overlay"

/**
 * Measure a session directory, or `undefined` when it does not exist.
 *
 * `lstat`, never `stat`: an overlay can hold symlinks copied up from the
 * workspace, and following one would count the target -- possibly outside the
 * session, possibly the whole workspace -- as the session's own bytes.
 */
export async function measureSessionDir(dir: string): Promise<SessionFootprint | undefined> {
	const footprint: SessionFootprint = {
		totalBytes: 0,
		sessionBytes: 0,
		agentTranscriptBytes: 0,
		overlayBytes: 0,
	}
	let root: Dirent[]
	try {
		root = await readdir(dir, { withFileTypes: true })
	} catch {
		return undefined
	}
	const add = (bucket: Bucket, bytes: number) => {
		footprint.totalBytes += bytes
		if (bucket === "overlay") {
			footprint.overlayBytes += bytes
		} else if (bucket === "agent") {
			footprint.agentTranscriptBytes += bytes
		} else {
			footprint.sessionBytes += bytes
		}
	}
	const walk = async (current: string, entries: Dirent[], bucket: Bucket | undefined): Promise<void> => {
		for (const entry of entries) {
			const full = path.join(current, entry.name)
			if (entry.isDirectory()) {
				const inner = bucket ?? (entry.name === AGENT_OVERLAYS_DIR ? "overlay" : "session")
				let children: Dirent[]
				try {
					children = await readdir(full, { withFileTypes: true })
				} catch {
					continue
				}
				await walk(full, children, inner)
				continue
			}
			let size: number
			try {
				size = (await lstat(full)).size
			} catch {
				// Removed between listing and measuring: it is no longer on disk.
				continue
			}
			add(bucket ?? (AGENT_TRANSCRIPT.test(entry.name) ? "agent" : "session"), size)
		}
	}
	await walk(dir, root, undefined)
	return footprint
}

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SCAN_IGNORED_DIRECTORIES } from "./oracle";

/**
 * The undo a transaction is built on.
 *
 * The rollback is the whole protocol: if the undo is unreliable, every
 * transaction after the first measures wreckage rather than a fresh attempt.
 * Cline's checkpoints cannot serve here — `beginWorktreeRestoreTransaction`
 * runs `git rev-parse --is-inside-work-tree` and throws on anything that is
 * not a repository, so a workspace that is a plain directory would have no
 * undo at all. Worse is the quiet failure: a sibling project's git snapshot
 * had `git add --sparse` fail on git 2.30, swallowed it, wrote the empty tree,
 * and reported success while reverting nothing.
 *
 * So this is a copy with a checksum manifest and no git in it anywhere. It is
 * slower than a commit and it cannot lie about what it holds.
 */
export interface Snapshot {
	/** Absolute paths, with the content each held when the transaction opened. */
	readonly files: ReadonlyMap<string, { hash: string; body: Buffer }>;
	/** The root the snapshot covers. */
	readonly root: string;
	/** Files that existed but were too large to hold; never rolled back. */
	readonly skipped: readonly string[];
}

export interface SnapshotLimits {
	/** Most files a snapshot will hold before it gives up on covering the tree. */
	maxFiles?: number;
	/** Largest single file held, in bytes. */
	maxFileBytes?: number;
	/** Most bytes held in total. */
	maxTotalBytes?: number;
}

/**
 * A workspace is not a test fixture. These bounds exist so that engaging the
 * protocol on a repository with a 400 MB asset directory degrades to "some
 * files are not covered, and it says so" rather than to reading the whole tree
 * into memory.
 */
const DEFAULT_LIMITS: Required<SnapshotLimits> = {
	maxFiles: 5_000,
	maxFileBytes: 4 * 1024 * 1024,
	maxTotalBytes: 128 * 1024 * 1024,
};

function hashOf(body: Buffer): string {
	return createHash("sha256").update(body).digest("hex");
}

/**
 * Read every file under `root` that a transaction could plausibly change.
 *
 * Taken at the open of every transaction rather than once per task: a kept
 * transaction becomes the base the next one rolls back to, which is what makes
 * a sequence of them additive rather than a single undo point.
 */
export async function takeSnapshot(
	root: string,
	limits: SnapshotLimits = {},
): Promise<Snapshot> {
	const bounds = { ...DEFAULT_LIMITS, ...limits };
	const files = new Map<string, { hash: string; body: Buffer }>();
	const skipped: string[] = [];
	let total = 0;

	const walk = async (dir: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SCAN_IGNORED_DIRECTORIES.has(entry.name)) {
					continue;
				}
				await walk(full);
				continue;
			}
			// Symlinks are recorded as skipped rather than followed: restoring
			// one by writing its target's bytes over it would replace the link
			// with a copy, which is a change of its own.
			if (!entry.isFile()) {
				skipped.push(full);
				continue;
			}
			if (files.size >= bounds.maxFiles || total >= bounds.maxTotalBytes) {
				skipped.push(full);
				continue;
			}
			let body: Buffer;
			try {
				const stat = await fs.stat(full);
				if (stat.size > bounds.maxFileBytes) {
					skipped.push(full);
					continue;
				}
				body = await fs.readFile(full);
			} catch {
				skipped.push(full);
				continue;
			}
			total += body.byteLength;
			files.set(full, { hash: hashOf(body), body });
		}
	};

	await walk(root);
	return { files, root, skipped };
}

export interface RestoreReport {
	/** Files put back because their contents had changed. */
	restored: string[];
	/** Files the transaction created, and which are now gone again. */
	removed: string[];
	/** Files the transaction deleted, and which are now back. */
	recreated: string[];
	/** Paths the snapshot never held, listed so nobody assumes they reverted. */
	uncovered: string[];
}

/**
 * Put the tree back exactly as the snapshot found it.
 *
 * Deletions are undone as carefully as edits, which is not hypothetical: a
 * model was measured deleting the file under test twelve times in one
 * transaction to get a clean slate for a whole-file write, and the last
 * deletion outlived the transaction.
 */
export async function restoreSnapshot(
	snapshot: Snapshot,
	limits: SnapshotLimits = {},
): Promise<RestoreReport> {
	const report: RestoreReport = {
		restored: [],
		removed: [],
		recreated: [],
		uncovered: [...snapshot.skipped],
	};

	const now = await takeSnapshot(snapshot.root, limits);

	for (const [filePath, before] of snapshot.files) {
		const after = now.files.get(filePath);
		if (!after) {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, before.body);
			report.recreated.push(filePath);
			continue;
		}
		if (after.hash !== before.hash) {
			await fs.writeFile(filePath, before.body);
			report.restored.push(filePath);
		}
	}

	for (const filePath of now.files.keys()) {
		if (!snapshot.files.has(filePath)) {
			await fs.rm(filePath, { force: true });
			report.removed.push(filePath);
		}
	}

	return report;
}

/** Whether anything under the snapshot's root differs from it now. */
export async function snapshotIsClean(
	snapshot: Snapshot,
	limits: SnapshotLimits = {},
): Promise<boolean> {
	const now = await takeSnapshot(snapshot.root, limits);
	if (now.files.size !== snapshot.files.size) {
		return false;
	}
	for (const [filePath, before] of snapshot.files) {
		if (now.files.get(filePath)?.hash !== before.hash) {
			return false;
		}
	}
	return true;
}

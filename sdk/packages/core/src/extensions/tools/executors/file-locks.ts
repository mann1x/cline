/**
 * Serialise this process's own access to a file.
 *
 * There was no locking of any kind before this: `editor`, `sed -i` and the
 * snapshot engine all called `fs.writeFile` directly, and `read_files` read
 * directly. Two agents running in parallel could interleave anywhere, and the
 * shape of the damage is not a torn byte — it is a lost update:
 *
 *   A reads the file        (100 lines)
 *   B reads the file        (100 lines)
 *   A writes its edit       (101 lines)
 *   B writes its edit       (101 lines, built from what it read before A wrote)
 *
 * B's write is complete and well-formed and silently contains none of A's work.
 * Nothing reports it, because nothing failed. An edit is a read-modify-write
 * and its three steps have to be one step with respect to other writers, which
 * is what this does.
 *
 * **In-process only, and that bound is the honest part.** A lock held in a Map
 * says nothing to a second VS Code window, a `git` process, or the user's own
 * editor. Those are caught after the fact by the file stamps in
 * `read-receipts.ts` — the model is told its view is stale and made to look
 * again — which is detection rather than exclusion. The two are complementary
 * and neither replaces the other: this one prevents the race it can see, the
 * stamps notice the one it cannot.
 *
 * **Why not an OS lock.** An advisory lock file would cover the cross-process
 * case, and it brings the problem it is famous for: a crashed holder leaves a
 * lock nobody will ever release, so it needs staleness detection, which needs a
 * timeout, which is a guess that either deadlocks a slow write or breaks a
 * correct one. The parallel agents this repository actually runs are in one
 * process. The cross-process case is rarer, already detected, and not worth
 * buying a class of hang for.
 *
 * Fair and FIFO: waiters are served in arrival order, because the chain is a
 * promise chain. A lock is released even when the work throws — the failure
 * path is the one where holding a lock forever would be worst.
 */

/** The tail of each path's queue. Absent means nothing is holding it. */
const queues = new Map<string, Promise<unknown>>();

/**
 * The key two paths are compared by.
 *
 * Case-insensitive on Windows for the same reason the read receipts are: the
 * two sides come from different places — the model types the path, the executor
 * resolves it — and a comparison that misses hands out two locks for one file,
 * which is worse than no lock at all because it looks like it worked.
 */
function lockKey(filePath: string): string {
	return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

export async function withFileLock<T>(
	filePath: string,
	run: () => Promise<T>,
): Promise<T> {
	const key = lockKey(filePath);
	const ahead = queues.get(key) ?? Promise.resolve();
	// The chain never rejects, so one caller's failure cannot reject every
	// waiter behind it. The failure belongs to its own caller and nobody else.
	const mine = ahead.then(run, run);
	queues.set(
		key,
		mine.then(
			() => undefined,
			() => undefined,
		),
	);
	try {
		return await mine;
	} finally {
		// Drop the entry when this call was the last in the queue, so a session
		// that touches ten thousand files does not hold ten thousand resolved
		// promises. Checked by identity: if someone queued behind us, the tail
		// is theirs and it is not ours to remove.
		queueMicrotask(() => {
			const tail = queues.get(key);
			if (tail !== undefined) {
				void tail.then(() => {
					if (queues.get(key) === tail) {
						queues.delete(key);
					}
				});
			}
		});
	}
}

/** Whether anything is queued for this path. For tests and diagnostics. */
export function isFileLocked(filePath: string): boolean {
	return queues.has(lockKey(filePath));
}

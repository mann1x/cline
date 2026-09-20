/**
 * Edits that have been typed but not yet saved.
 *
 * Every debounced field in the settings panel waits before it writes — the
 * numeric ones wait 800ms, because a shorter wait stored `0.9` as `9` and
 * `65536` as `6553` while the user was still typing. That wait is correct, and
 * it is also a window in which the panel and `providers.json` disagree.
 *
 * Measured on a live install: a session ran with `temp 0.700 / repeat_penalty
 * 1.250 / presence_penalty 0.150` — read off the server's own sampler dump —
 * while the profile saved from that same panel carried no sampler at all. The
 * user pressed Update inside the debounce window, so the profile captured the
 * state from before the values were typed, and the values themselves landed in
 * `providers.json` a moment later, where only the *run* could see them. Three
 * profiles were saved empty that afternoon.
 *
 * So anything that reads the stored configuration as though it were what the
 * user is looking at has to end the wait first. A field registers here while
 * it holds an unsaved edit; a boundary — Update, Done, leaving the tab —
 * flushes them all and waits for the writes to land. A revert discards them
 * instead, because a pending write that fires *after* a revert puts the
 * discarded value straight back.
 */

/** One field's unsaved edit, as the boundary needs to see it. */
export interface PendingEdit {
	/** Whether this field is actually holding something unsaved. */
	pending: () => boolean
	/** Save it now. May return a promise; the boundary waits for it. */
	flush: () => unknown
	/** Drop it, and put the field back to what is stored. */
	discard: () => void
}

const edits = new Set<PendingEdit>()

/** Registers for the lifetime of the field. Returns the unregister. */
export function registerPendingEdit(edit: PendingEdit): () => void {
	edits.add(edit)
	return () => {
		edits.delete(edit)
	}
}

/** Whether any field is holding an edit that has not reached the store. */
export function hasPendingEdits(): boolean {
	for (const edit of edits) {
		if (edit.pending()) {
			return true
		}
	}
	return false
}

/**
 * Save every pending edit and wait for the writes.
 *
 * The waiting is the point: `flush` starts a write, and a caller that captures
 * the configuration without awaiting it captures the value from before the
 * edit — which is the bug this module exists for. Failures are swallowed per
 * field so one refused write cannot stop the rest from saving.
 */
export async function flushPendingEdits(): Promise<void> {
	const results: unknown[] = []
	// Copied first: a flush can unmount a field, and mutating the set while
	// iterating it would skip whatever follows.
	for (const edit of [...edits]) {
		if (!edit.pending()) {
			continue
		}
		try {
			results.push(edit.flush())
		} catch {
			// A field that cannot save is not a reason to leave the others unsaved.
		}
	}
	await Promise.allSettled(results)
}

/**
 * Drop every pending edit.
 *
 * For revert, and for anything else that replaces what the panel is showing: a
 * debounce that fires after the replacement would write the value the user
 * just asked to discard.
 */
export function discardPendingEdits(): void {
	for (const edit of [...edits]) {
		if (!edit.pending()) {
			continue
		}
		try {
			edit.discard()
		} catch {
			// Same reasoning as the flush above.
		}
	}
}

/** Test-only: the registry outlives any one component, which is the point. */
export function __resetPendingEdits(): void {
	edits.clear()
}

import type { ApiConfigurationSnapshot } from "@shared/api-config-snapshot"

/**
 * The write path for a tab that stores its whole configuration in one string.
 *
 * Vision and Agents keep their configuration in a single settings string rather
 * than in providers.json, and every field in the panel writes to it. The
 * string arrives as a prop, so it only changes after a round trip through the
 * host and back into extension state — which is far too slow to be the base
 * for the *next* write.
 *
 * Measured (mann1x/cline#67): editing the Ollama context window fires two
 * writes from one `onChange` — `write({ contextWindow })` and, because a model
 * is selected, `commitModelSelection(...)`. Both built their patch from the
 * same render's snapshot, so the second landed last and put back a
 * `providerConfig` with no `contextWindow` in it. The panel then matched the
 * saved profile exactly, so no Update button appeared, and Done had nothing to
 * keep. The same shape loses a request timeout typed straight after a context
 * change, which is why the report reads as "it's a mess" rather than as one
 * field.
 *
 * So the snapshot lives here instead of in a prop:
 *
 * - **Applied synchronously.** A patch mutates the held snapshot before the
 *   call returns, so the second write in a turn builds on the first.
 * - **Persisted in order.** Writes are chained, never issued in parallel, so
 *   the last one to be applied is the last one to be stored.
 * - **Adopted, not overwritten.** An incoming prop is taken only when nothing
 *   is in flight; otherwise it is an echo of a write we have already moved past.
 */
export type SnapshotPatch = (current: ApiConfigurationSnapshot) => ApiConfigurationSnapshot

export interface ScopedSnapshotWriter {
	/** The snapshot as it stands, including writes not yet persisted. */
	current(): ApiConfigurationSnapshot
	/** Apply a patch now, persist it after every earlier patch has been stored. */
	mutate(patch: SnapshotPatch): Promise<void>
	/** Take an externally-supplied snapshot, unless our own writes are in flight. */
	adopt(next: ApiConfigurationSnapshot): void
	/** Whether a write is still on its way to the host. */
	pending(): boolean
}

export function createScopedSnapshotWriter(
	initial: ApiConfigurationSnapshot,
	persist: (snapshot: ApiConfigurationSnapshot) => Promise<void>,
): ScopedSnapshotWriter {
	let snapshot = initial
	let inFlight = 0
	let queue: Promise<void> = Promise.resolve()

	return {
		current: () => snapshot,
		pending: () => inFlight > 0,
		adopt: (next: ApiConfigurationSnapshot) => {
			// A prop that arrives while our own writes are unacknowledged is at
			// best equal to what we hold and at worst the state before them.
			// Taking it would undo an edit the user has already made.
			if (inFlight === 0) {
				snapshot = next
			}
		},
		mutate: async (patch: SnapshotPatch) => {
			snapshot = patch(snapshot)
			const toPersist = snapshot
			inFlight += 1
			const run = queue.then(() => persist(toPersist))
			// The queue must survive a rejected write, or one failure wedges
			// every later edit in the panel.
			queue = run.catch(() => {})
			try {
				await run
			} finally {
				inFlight -= 1
			}
		},
	}
}

/**
 * The three edits a scoped tab makes, as patches.
 *
 * Kept out of the component so the sequence that broke can be tested as the
 * sequence it is, rather than through a rendered panel.
 */
export const scopedSnapshotPatches = {
	/** A providers.json-shaped field: base URL, context window, sampler. */
	providerSettings:
		(patch: Record<string, unknown>): SnapshotPatch =>
		(current) => ({
			...current,
			providerConfig: { ...(current.providerConfig ?? {}), ...patch },
		}),

	/** The committed model, with the per-model overrides that travel with it. */
	modelSelection:
		(selection: { modelId: string; overrides?: Record<string, unknown> }): SnapshotPatch =>
		(current) => ({
			...current,
			providerConfig: {
				...(current.providerConfig ?? {}),
				selectedModelId: selection.modelId,
				selectedModelOverrides: selection.overrides,
			},
		}),

	/**
	 * A settings-panel field, which replaces the settings half wholesale.
	 *
	 * `providerConfig` is carried from the snapshot as it stands. Reading it
	 * from the render's copy is what let a settings edit roll back a provider
	 * edit made moments earlier in the same interaction.
	 */
	settings:
		(captured: ApiConfigurationSnapshot): SnapshotPatch =>
		(current) => ({
			...captured,
			...(current.providerConfig ? { providerConfig: current.providerConfig } : {}),
		}),
}

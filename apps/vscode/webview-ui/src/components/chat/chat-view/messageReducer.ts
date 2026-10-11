import type { ClineMessage, TurnState } from "@shared/ExtensionMessage"

// Convergent-replica reducer for the webview's clineMessages transcript.
//
// The webview receives the same conversation over two unordered, fire-and-forget channels
// (incremental partial messages and full state snapshots). This reducer makes the transcript
// converge to the correct set under ANY arrival order, duplication, or loss, using three
// extension-stamped quantities:
//
//   - ts    : message identity / merge key (one process-wide monotonic id; see MessageIdMinter)
//   - seq   : freshness within an epoch (higher seq = newer copy of the same ts)
//   - epoch : conversation/replica fence (newer epoch replaces; older is dropped)
//
// The reducer is a pure function so it can be exhaustively unit-tested (including
// property-based, order-independent tests) with no React/gRPC/timers.

/**
 * The webview's replica of the conversation transcript plus the fence/freshness high-water
 * marks needed to reject stale traffic. `messages` is kept as an array (rendering order) and
 * mirrors what the UI consumes.
 */
export interface ReplicaState {
	messages: ClineMessage[]
	/** Highest epoch applied. Messages/snapshots from an older epoch are dropped. */
	epoch: number
	/** Highest per-message seq applied per ts. Used to ignore older copies of the same ts. */
	seqByTs: Map<number, number>
	/** Highest state snapshot version applied. Older snapshots are ignored wholesale. */
	stateVersion: number
	/**
	 * The authoritative UI mode for the current turn. Moves forward by `turnState.seq` only, so a
	 * late/out-of-order snapshot carrying an older phase (e.g. "idle") can never revert a newer
	 * phase (e.g. "streaming"). `undefined` for classic/legacy state with no turnState.
	 */
	turnState?: TurnState
}

/** Create an empty replica. */
export function createReplicaState(): ReplicaState {
	return { messages: [], epoch: 0, seqByTs: new Map(), stateVersion: 0, turnState: undefined }
}

/**
 * Effective epoch of an incoming item. Unstamped (classic/legacy) items use 0, which equals
 * a fresh replica's epoch, so they merge rather than being dropped.
 */
function epochOf(item: { epoch?: number }): number {
	return item.epoch ?? 0
}

function seqOf(message: ClineMessage): number {
	return message.seq ?? 0
}

/** Replace the replica's transcript wholesale at a new epoch (new task / history load). */
function resetTo(epoch: number, messages: ClineMessage[], stateVersion: number, turnState?: TurnState): ReplicaState {
	const seqByTs = new Map<number, number>()
	for (const m of messages) {
		const existing = seqByTs.get(m.ts)
		if (existing === undefined || seqOf(m) >= existing) {
			seqByTs.set(m.ts, seqOf(m))
		}
	}
	return { messages: [...messages], epoch, seqByTs, stateVersion, turnState }
}

/**
 * Apply a TurnState update, gated by `seq`. The replica keeps the highest-seq TurnState and
 * ignores older ones, so a late/out-of-order "streaming" can never overwrite a newer
 * "completed" (and vice-versa). Returns the same state when ignored.
 */
export function applyTurnState(state: ReplicaState, incoming: TurnState | undefined): ReplicaState {
	if (!incoming) {
		return state
	}
	if (state.turnState !== undefined && incoming.seq <= state.turnState.seq) {
		return state
	}
	return { ...state, turnState: incoming }
}

/**
 * Apply one incoming ClineMessage (from the partial-message stream OR from within a state
 * snapshot). Returns the same state object when the message is stale/ignored, or a new state
 * when it changes the transcript.
 *
 * Rules:
 *  - older epoch  -> drop (straggler from a previous task/render)
 *  - newer epoch  -> advance the fence, but do NOT discard the existing transcript on the
 *                    strength of a single message. The authoritative wholesale replace for a
 *                    new task/render comes from a full state snapshot (applyStateSnapshot); a
 *                    lone newer-epoch *partial* (e.g. a bookkeeping api_req_started that raced
 *                    ahead of its snapshot) must not empty a live conversation — that would
 *                    strand the webview at messages.length === 0 and route Enter to newTask().
 *                    So we bump the epoch and append/merge this one message; the snapshot that
 *                    follows will reconcile to the true new-task transcript.
 *  - same epoch   -> upsert by ts, keeping the higher seq
 */
export function applyMessage(state: ReplicaState, incoming: ClineMessage): ReplicaState {
	const incomingEpoch = epochOf(incoming)

	if (incomingEpoch < state.epoch) {
		return state
	}

	if (incomingEpoch > state.epoch) {
		// Advance the fence without throwing away an existing transcript. Carry the prior
		// messages forward at the new epoch and merge this one in; a subsequent newer-epoch
		// snapshot performs the real wholesale replace when a genuine new task begins.
		const advanced: ReplicaState = {
			messages: [...state.messages],
			epoch: incomingEpoch,
			seqByTs: new Map(state.seqByTs),
			stateVersion: state.stateVersion,
			turnState: state.turnState,
		}
		return applyMessage(advanced, incoming)
	}

	// Same epoch: merge by ts, keep highest seq.
	const existingSeq = state.seqByTs.get(incoming.ts)
	const index = state.messages.findIndex((m) => m.ts === incoming.ts)

	if (index !== -1) {
		// A copy of this ts already exists. Keep ours unless the incoming is at least as fresh.
		if (existingSeq !== undefined && seqOf(incoming) < existingSeq) {
			return state
		}
		const messages = [...state.messages]
		messages[index] = incoming
		const seqByTs = new Map(state.seqByTs)
		seqByTs.set(incoming.ts, Math.max(existingSeq ?? 0, seqOf(incoming)))
		return { ...state, messages, seqByTs }
	}

	// New ts at the current epoch — append.
	const messages = [...state.messages, incoming]
	const seqByTs = new Map(state.seqByTs)
	seqByTs.set(incoming.ts, seqOf(incoming))
	return { ...state, messages, seqByTs }
}

/** Whether two copies of a message would render the same. Nested values are compared by their JSON. */
function sameMessage(a: ClineMessage, b: ClineMessage): boolean {
	if (a === b) {
		return true
	}
	const aKeys = Object.keys(a) as (keyof ClineMessage)[]
	if (aKeys.length !== Object.keys(b).length) {
		return false
	}
	for (const key of aKeys) {
		const x = a[key]
		const y = b[key]
		if (x === y) {
			continue
		}
		if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) {
			return false
		}
		if (JSON.stringify(x) !== JSON.stringify(y)) {
			return false
		}
	}
	return true
}

/**
 * Merge a same-epoch snapshot's messages into the replica: the result `applyMessage` gives when
 * called once per message, reached in one pass.
 *
 * Called once per message, it copied the transcript array and the seq map for every message of
 * every snapshot -- quadratic in the length of the conversation: 81 ms for 2,000 rows, against
 * snapshots arriving every 50 ms while a turn streams. The webview fell behind, the snapshots it
 * had not reached queued in its memory, and the panel died (2026-10-11).
 *
 * A message whose incoming copy would render the same keeps the object the replica already
 * holds, so a row that did not change is not handed to React as a new one, and a snapshot that
 * changes nothing returns the same state.
 */
function mergeSnapshotMessages(state: ReplicaState, snapshotMessages: ClineMessage[]): ReplicaState {
	// Anything fenced differently takes the general path, which knows how to move the fence.
	if (snapshotMessages.some((message) => epochOf(message) !== state.epoch)) {
		let next = state
		for (const message of snapshotMessages) {
			next = applyMessage(next, message)
		}
		return next
	}

	// First index per ts, as `findIndex` would find it.
	const indexByTs = new Map<number, number>()
	for (let i = 0; i < state.messages.length; i++) {
		const ts = state.messages[i].ts
		if (!indexByTs.has(ts)) {
			indexByTs.set(ts, i)
		}
	}

	let messages = state.messages
	let seqByTs = state.seqByTs
	let changed = false
	const beginChange = (): void => {
		if (!changed) {
			messages = [...state.messages]
			seqByTs = new Map(state.seqByTs)
			changed = true
		}
	}

	for (const incoming of snapshotMessages) {
		const index = indexByTs.get(incoming.ts)
		const incomingSeq = seqOf(incoming)
		if (index === undefined) {
			beginChange()
			indexByTs.set(incoming.ts, messages.length)
			messages.push(incoming)
			seqByTs.set(incoming.ts, incomingSeq)
			continue
		}
		const existingSeq = seqByTs.get(incoming.ts)
		if (existingSeq !== undefined && incomingSeq < existingSeq) {
			continue
		}
		const nextSeq = Math.max(existingSeq ?? 0, incomingSeq)
		const unchanged = sameMessage(messages[index], incoming)
		if (unchanged && existingSeq === nextSeq) {
			continue
		}
		beginChange()
		if (!unchanged) {
			messages[index] = incoming
		}
		seqByTs.set(incoming.ts, nextSeq)
	}

	return changed ? { ...state, messages, seqByTs } : state
}

/**
 * Apply a full state snapshot's transcript.
 *
 *  - older epoch        -> drop entirely
 *  - newer epoch        -> replace the transcript wholesale (new task / history load)
 *  - same epoch:
 *      - older/equal stateVersion -> ignore (a newer snapshot already applied)
 *      - newer stateVersion       -> MERGE each message by ts/seq (NEVER truncate). This is the
 *                                    fix for "last message missing": a snapshot that lacks a
 *                                    message the partial stream already delivered cannot drop it.
 *
 * `snapshotEpoch`/`snapshotVersion` default to 0 (unstamped classic/legacy) which merges.
 *
 * `snapshotTurnState` (when present) is applied through the same seq gate as applyTurnState: a
 * newer epoch adopts it wholesale; otherwise it only advances the replica's turnState if its
 * seq is higher. This is what stops a late/stale snapshot from reverting "streaming" -> "idle".
 */
export function applyStateSnapshot(
	state: ReplicaState,
	snapshotMessages: ClineMessage[],
	snapshotEpoch = 0,
	snapshotVersion = 0,
	snapshotTurnState?: TurnState,
): ReplicaState {
	if (snapshotEpoch < state.epoch) {
		return state
	}

	if (snapshotEpoch > state.epoch) {
		// New task/render: replace transcript AND adopt the snapshot's turnState wholesale.
		return resetTo(snapshotEpoch, snapshotMessages, snapshotVersion, snapshotTurnState)
	}

	// Same epoch.
	if (snapshotVersion !== 0 && snapshotVersion <= state.stateVersion) {
		// A newer (or equal) snapshot already applied for the transcript — but a turnState with a
		// higher seq may still need to move the UI forward, so don't bail before the seq gate.
		return applyTurnState(state, snapshotTurnState)
	}

	// Merge each message; never shrink the transcript for the same task/epoch.
	let next = mergeSnapshotMessages(state, snapshotMessages)
	if (snapshotVersion > next.stateVersion) {
		next = next === state ? { ...state } : next
		next.stateVersion = snapshotVersion
	}
	// Gate turnState by seq so a stale snapshot cannot revert a newer phase.
	next = applyTurnState(next, snapshotTurnState)
	return next
}

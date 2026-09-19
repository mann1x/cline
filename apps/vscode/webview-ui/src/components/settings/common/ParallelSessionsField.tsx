import { useProviderConfig } from "@/hooks/useProviderConfig"
import { DebouncedTextField } from "./DebouncedTextField"

/**
 * The bounds, named here for the label and the placeholder only.
 *
 * The values that reach storage are clamped by the provider config store, which
 * reads `normalizeParallelSessions` from `@cline/llms` — the one authority on
 * the range. That package cannot be imported here: it is a Node package and
 * pulls in `undici`, which does not resolve in the webview bundle. So this file
 * says what the field *shows* and never decides what it stores.
 */
const MIN_PARALLEL_SESSIONS = 1
const MAX_PARALLEL_SESSIONS = 10

function parseTyped(value: string | number | undefined): number | undefined {
	const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value
	if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
		return undefined
	}
	return parsed
}

/**
 * How many requests this endpoint serves at once, per profile.
 *
 * A local server has a fixed number of slots — `OLLAMA_NUM_PARALLEL` for
 * Ollama, `--parallel N` for llama.cpp and opencoti — and a request that finds
 * none free is not refused, it is *queued*, silently. Spawning four agents
 * against a one-slot server runs one and leaves three waiting, and the run
 * reads as slow rather than blocked. A hosted provider has the same shape for a
 * different reason: a plan allows so many concurrent requests.
 *
 * Neither number is on the wire — a plan's allowance is not published and
 * Ollama does not report `OLLAMA_NUM_PARALLEL` — so it is typed here rather
 * than discovered, and it lives beside the context window because it belongs to
 * the same thing: one profile's arrangement with one endpoint.
 *
 * The exception is an elastic opencoti — PolyKV admission, or the elastic slot
 * controller. There the server decides how many it will take, so there is no
 * fixed number to describe, and this field changes meaning rather than going
 * unread: it becomes a ceiling of the user's own, applied on top of whatever
 * the engine would have allowed. Empty hands the decision to the engine
 * entirely. The session probes `/props` for which of the two cases it is in;
 * this field cannot, which is why the copy explains both.
 */
export const ParallelSessionsField = ({ providerId }: { providerId: string }) => {
	const { config, write } = useProviderConfig(providerId as never)
	// Same reason the Ollama context-window field waits: the debounced input
	// fires onChange for its initial value shortly after mount, so rendering
	// before the provider config resolves would persist a blank over a stored
	// number.
	if (config === undefined) {
		return null
	}
	const stored = parseTyped(config.parallelSessions)

	return (
		<DebouncedTextField
			initialValue={stored ? String(stored) : ""}
			numeric
			onChange={(value) => {
				const next = parseTyped(value)
				if (next === stored) {
					return
				}
				// Zero clears it, as with the context window; cleared reads back as
				// one, which is what `--parallel` and a basic plan give you.
				void write({ parallelSessions: next ?? 0 }).catch((error) =>
					console.error("Failed to update parallel sessions:", error),
				)
			}}
			placeholder={`Default: ${MIN_PARALLEL_SESSIONS}`}
			style={{ width: "100%" }}>
			<span className="font-semibold">Parallel Sessions</span>
		</DebouncedTextField>
	)
}

export const PARALLEL_SESSIONS_DESCRIPTION =
	`How many requests this endpoint serves at once — ${MIN_PARALLEL_SESSIONS} to ${MAX_PARALLEL_SESSIONS}. ` +
	"Ollama's OLLAMA_NUM_PARALLEL, or --parallel for llama.cpp and opencoti; for a hosted provider, what your plan allows. " +
	"It bounds how many subagents run at once: a server with no free slot queues the request instead of refusing it, so " +
	"spawning more agents than there are slots makes a run slower, not faster."

/**
 * The sentence that follows it on an elastic server, where the field means
 * something else.
 */
const PARALLEL_SESSIONS_ELASTIC_NOTE =
	" With PolyKV or elastic slots on, opencoti decides for itself how many it will take — there is no fixed count to " +
	"state. A number here is then a ceiling of your own, applied on top of the engine's answer; leave it empty to let the " +
	"engine decide alone."

/**
 * The copy under the field, for the provider it is being shown for.
 *
 * opencoti gets an extra sentence rather than different text: the shared
 * paragraph is still true of a plain opencoti, which has a fixed `--parallel`
 * count like any other llama.cpp server, and only stops being true once one of
 * the two elastic controllers is armed. Nothing in the webview can tell which,
 * so both are stated.
 */
export function parallelSessionsDescription(providerId: string): string {
	return providerId === "opencoti"
		? PARALLEL_SESSIONS_DESCRIPTION + PARALLEL_SESSIONS_ELASTIC_NOTE
		: PARALLEL_SESSIONS_DESCRIPTION
}

export default ParallelSessionsField

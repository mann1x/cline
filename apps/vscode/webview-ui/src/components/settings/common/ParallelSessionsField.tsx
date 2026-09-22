import { StringRequest } from "@shared/proto/cline/common"
import { useEffect, useState } from "react"
import { useProviderConfig } from "@/hooks/useProviderConfig"
import { ModelsServiceClient } from "@/services/grpc-client"
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
 * entirely. Which case applies is the server's to say, so the panel asks it:
 * see {@link useOpencotiEngineMode}.
 */
export const ParallelSessionsField = ({ providerId, engine }: { providerId: string; engine?: OpencotiEngineMode }) => {
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
				// Returned so a boundary that flushes this field can wait for it.
				return write({ parallelSessions: next ?? 0 }).catch((error) =>
					console.error("Failed to update parallel sessions:", error),
				)
			}}
			placeholder={engineDecides(engine) ? "Empty: the engine decides" : `Default: ${MIN_PARALLEL_SESSIONS}`}
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
 * What an opencoti server says about how it decides concurrency.
 *
 * - `polykv` / `elastic`: one of the two controllers is armed, the server
 *   decides, and the field is a ceiling of the user's own.
 * - `fixed`: the server answered and has neither on. It has a `--parallel`
 *   count like any llama.cpp server, and empty means one.
 * - `unknown`: not answered yet, or not answerable.
 *
 * PolyKV is named over elastic slots when both are on: it is the one whose
 * admission control actually says yes or no to the next agent.
 */
export type OpencotiEngineMode = "polykv" | "elastic" | "fixed" | "unknown"

function engineDecides(engine: OpencotiEngineMode | undefined): boolean {
	return engine === "polykv" || engine === "elastic"
}

const PARALLEL_SESSIONS_CEILING =
	"A number here is then a ceiling of your own, applied on top of the engine's answer; leave it empty to let the " +
	"engine decide alone."

/**
 * The copy under the field, for the provider it is being shown for.
 *
 * On opencoti the extra sentence depends on what the server says, because the
 * advice is opposite in the two cases. On an elastic one, empty hands the
 * decision to the engine. On a plain one, which has a fixed `--parallel` count
 * like any llama.cpp server, empty means one and nothing else is deciding --
 * telling the user to leave it empty there is how a profile ends up running
 * one agent at a time on a server that could have run four.
 *
 * Every other provider, and opencoti before anything is known, gets the text
 * that is true whatever the answer.
 */
export function parallelSessionsDescription(providerId: string, engine?: OpencotiEngineMode): string {
	if (providerId !== "opencoti") {
		return PARALLEL_SESSIONS_DESCRIPTION
	}
	switch (engine) {
		case "polykv":
			return `${PARALLEL_SESSIONS_DESCRIPTION} PolyKV admission is on here, so the server decides for itself how many it will take — there is no fixed count to state. ${PARALLEL_SESSIONS_CEILING}`
		case "elastic":
			return `${PARALLEL_SESSIONS_DESCRIPTION} Elastic slots are on here, so the server grows its slot count as load arrives — there is no fixed count to state. ${PARALLEL_SESSIONS_CEILING}`
		case "fixed":
			return `${PARALLEL_SESSIONS_DESCRIPTION} This server has neither PolyKV nor elastic slots on, so its count is fixed by --parallel and this field should match it.`
		default:
			return `${PARALLEL_SESSIONS_DESCRIPTION} The server could not be asked whether it decides this itself. If it has PolyKV or elastic slots on, it does, and ${PARALLEL_SESSIONS_CEILING.charAt(0).toLowerCase()}${PARALLEL_SESSIONS_CEILING.slice(1)}`
	}
}

/**
 * Ask the configured opencoti server which case the field is in.
 *
 * `undefined` for every other provider, which is never asked. Read once per
 * provider, as the PolyKV status strip does and through the same host read:
 * there is nothing here worth a timer, and the base URL comes from the stored
 * config on the host side, so the panel cannot be pointed somewhere else.
 */
export function useOpencotiEngineMode(providerId: string | undefined): OpencotiEngineMode | undefined {
	const [mode, setMode] = useState<OpencotiEngineMode | undefined>()

	useEffect(() => {
		if (providerId !== "opencoti") {
			setMode(undefined)
			return
		}
		let cancelled = false
		setMode("unknown")
		ModelsServiceClient.readPolykvStatus(StringRequest.create({ value: providerId }))
			.then((status) => {
				if (cancelled) {
					return
				}
				setMode(!status.reachable ? "unknown" : status.poolsEnabled ? "polykv" : status.elastic ? "elastic" : "fixed")
			})
			.catch(() => {
				if (!cancelled) {
					setMode("unknown")
				}
			})
		return () => {
			cancelled = true
		}
	}, [providerId])

	return mode
}

export default ParallelSessionsField

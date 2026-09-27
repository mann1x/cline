import type { OllamaReachabilityResponse } from "@shared/proto/cline/models"
import { OllamaReachabilityRequest } from "@shared/proto/cline/models"
import { useEffect, useState } from "react"
import { ModelsServiceClient } from "@/services/grpc-client"

/**
 * Whether the chat input's Ollama or xOllama server answers, kept current
 * while the panel is open.
 *
 * A dead server used to be found out by sending a message and reading the
 * error that came back. The chat box is where the user is looking, so it says
 * so there, before the message is written.
 *
 * Polled, because nothing tells the webview a server came up or went away:
 * quickly while something is wrong, so a fixed URL or a restarted server clears
 * the warning within seconds, and slowly while all is well. Each poll is one
 * `GET /api/tags` from the extension host -- see `readOllamaReachability`.
 */

/** The providers this applies to. Others have no cheap "are you there". */
export const REACHABILITY_PROVIDERS = new Set(["ollama", "xollama"])
export const RECHECK_WHILE_DOWN_MS = 15_000
export const RECHECK_WHILE_UP_MS = 60_000

export interface ReachabilityProblem {
	/** "down": nothing answers. "model": the server answers without the model. */
	kind: "down" | "model"
	/** The whole diagnosis, for the empty input's placeholder. */
	message: string
}

const PROVIDER_LABEL: Record<string, string> = { ollama: "Ollama", xollama: "xOllama" }

function isLoopback(origin: string): boolean {
	try {
		const host = new URL(origin).hostname
		return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.")
	} catch {
		return false
	}
}

/**
 * What to tell the user, or nothing when all is well.
 *
 * Says what was asked and what came back, then where the fix is. xOllama gets
 * one more line: it binds loopback unless XOLLAMA_HOST says otherwise, so a
 * remote xOllama that refuses is most often that, not the URL. Its app's
 * "Expose to the network" set only OLLAMA_HOST before 0.34.2-xollama.2, so the
 * variable is named rather than only the switch.
 */
export function describeReachability(
	providerId: string,
	modelId: string | undefined,
	status: OllamaReachabilityResponse | undefined,
): ReachabilityProblem | undefined {
	if (!status) {
		return undefined
	}
	const label = PROVIDER_LABEL[providerId] ?? providerId
	if (!status.reachable) {
		const why = status.error ? ` (${status.error})` : ""
		const expose =
			providerId === "xollama" && !isLoopback(status.baseUrl)
				? ` On that machine xOllama listens on 127.0.0.1 unless XOLLAMA_HOST=0.0.0.0:<port> is set, which "Expose to the network" does from 0.34.2-xollama.2.`
				: ""
		return {
			kind: "down",
			message: `${label} at ${status.baseUrl} is not reachable${why}. Check the base URL in the provider settings, or whether the server is running.${expose}`,
		}
	}
	if (modelId && status.modelFound === false) {
		return {
			kind: "model",
			message: `${label} at ${status.baseUrl} does not have ${modelId}. Pull it there, or choose another model.`,
		}
	}
	return undefined
}

export function useOllamaReachability(providerId: string | undefined, modelId: string | undefined) {
	const [status, setStatus] = useState<OllamaReachabilityResponse | undefined>()
	const applies = providerId !== undefined && REACHABILITY_PROVIDERS.has(providerId)

	useEffect(() => {
		setStatus(undefined)
		if (!applies || !providerId) {
			return
		}
		let cancelled = false
		let timer: ReturnType<typeof setTimeout> | undefined
		const check = async () => {
			let next: OllamaReachabilityResponse | undefined
			try {
				next = await ModelsServiceClient.readOllamaReachability(
					OllamaReachabilityRequest.create({ providerId, ...(modelId ? { modelId } : {}) }),
				)
			} catch {
				// The host could not be asked. That says nothing about the server,
				// and a warning drawn from it would be a guess.
				next = undefined
			}
			if (cancelled) {
				return
			}
			setStatus(next)
			const wrong = next !== undefined && (!next.reachable || next.modelFound === false)
			timer = setTimeout(check, wrong ? RECHECK_WHILE_DOWN_MS : RECHECK_WHILE_UP_MS)
		}
		void check()
		return () => {
			cancelled = true
			if (timer) {
				clearTimeout(timer)
			}
		}
	}, [applies, providerId, modelId])

	return applies ? describeReachability(providerId as string, modelId, status) : undefined
}

import { StringRequest } from "@shared/proto/cline/common"
import type { RetrievalAction, RetrievalActionResult, RetrievalStatus } from "@shared/retrieval-status"
import { useCallback, useEffect, useRef, useState } from "react"
import { StateServiceClient } from "@/services/grpc-client"

/** How often a running download is looked at again. */
const INSTALL_POLL_MS = 2000

export interface RetrievalStatusHandle {
	/** Undefined until the host has answered once. */
	status: RetrievalStatus | undefined
	/** What the last action did, or why it did not. */
	message: string | undefined
	error: string | undefined
	busy: boolean
	run: (action: RetrievalAction) => Promise<RetrievalActionResult | undefined>
	/** Ask for something without it counting as an action: no busy state, and the last message stays. */
	ask: (action: RetrievalAction) => Promise<RetrievalActionResult | undefined>
}

/**
 * The engine under the Library and Memory panels, as the host reports it:
 * read when the panel opens, again after everything the panel does, and
 * every two seconds while LanceDB is downloading or documents are being
 * embedded.
 */
export function useRetrievalStatus(): RetrievalStatusHandle {
	const [status, setStatus] = useState<RetrievalStatus>()
	const [message, setMessage] = useState<string>()
	const [error, setError] = useState<string>()
	const [busy, setBusy] = useState(false)
	const alive = useRef(true)

	const call = useCallback(async (action: RetrievalAction): Promise<RetrievalActionResult | undefined> => {
		try {
			const response = await StateServiceClient.retrievalAction(StringRequest.create({ value: JSON.stringify(action) }))
			const result = JSON.parse(response.value) as RetrievalActionResult
			if (alive.current) {
				setStatus(result.status)
			}
			return result
		} catch (cause) {
			if (alive.current) {
				setError(cause instanceof Error ? cause.message : String(cause))
			}
			return undefined
		}
	}, [])

	const run = useCallback(
		async (action: RetrievalAction) => {
			setBusy(true)
			setMessage(undefined)
			setError(undefined)
			const result = await call(action)
			if (alive.current) {
				setMessage(result?.message)
				if (result && !result.ok) {
					setError(result.error)
				}
				setBusy(false)
			}
			return result
		},
		[call],
	)

	useEffect(() => {
		alive.current = true
		void call({ action: "status" })
		return () => {
			alive.current = false
		}
	}, [call])

	// Anything the host is still doing is followed until it is done.
	const installing =
		status?.lancedb.installing === true ||
		status?.embedJobs?.library?.running === true ||
		status?.embedJobs?.memory?.running === true ||
		status?.codeIndex?.running === true
	useEffect(() => {
		if (!installing) {
			return
		}
		const timer = setInterval(() => void call({ action: "status" }), INSTALL_POLL_MS)
		return () => clearInterval(timer)
	}, [installing, call])

	return { status, message, error, busy, run, ask: call }
}

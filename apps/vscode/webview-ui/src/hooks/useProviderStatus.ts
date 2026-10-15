import { StringRequest } from "@shared/proto/cline/common"
import { useCallback, useEffect, useRef, useState } from "react"
import { ModelsServiceClient } from "@/services/grpc-client"

/**
 * Whether the selected provider's endpoint answers, for the status dot beside
 * the API Provider label.
 *
 * Checked when the settings show, when the provider changes, when its
 * settings change (debounced, so typing a URL is one check, not one per key),
 * and when the dot is pressed. Each check is one free read from the extension
 * host -- see `readProviderStatus`. Not polled: the chat input already watches
 * Ollama and xOllama, and nothing here is worth a request a minute to a paid
 * API.
 */

export type ProviderStatusState = "unknown" | "ready" | "fail"

export interface ProviderStatusView {
	state: ProviderStatusState
	/** What was asked and what came back, for the tooltip. */
	detail: string
	/** A check is in flight; the state shown is the last answer. */
	checking: boolean
	recheck: () => void
}

/** How long settings must sit still before they are checked. */
export const SETTINGS_SETTLE_MS = 1200

const NOT_YET = "Not checked yet."

export function toProviderStatusState(state: string | undefined): ProviderStatusState {
	return state === "ready" || state === "fail" ? state : "unknown"
}

/**
 * @param settings The provider's stored entry as `useProviderConfig` shares
 *   it. That store replaces the object on every read and write of the entry
 *   and at no other time, so a new object is a settings change -- including a
 *   key swapped for one of the same length, which the redacted fields alone
 *   would not show. The first entry to arrive is the mount's own read, which
 *   the provider check already covers, so it does not check again.
 */
export function useProviderStatus(providerId: string | undefined, settings: object | undefined): ProviderStatusView {
	const [state, setState] = useState<ProviderStatusState>("unknown")
	const [detail, setDetail] = useState(NOT_YET)
	const [checking, setChecking] = useState(false)
	// Only the newest check may set the result: a slow answer for the previous
	// provider must not paint the new one.
	const generation = useRef(0)

	const check = useCallback(async () => {
		if (!providerId) {
			return
		}
		const mine = ++generation.current
		setChecking(true)
		try {
			const response = await ModelsServiceClient.readProviderStatus(StringRequest.create({ value: providerId }))
			if (mine !== generation.current) {
				return
			}
			setState(toProviderStatusState(response.state))
			setDetail(response.detail || NOT_YET)
		} catch (error) {
			if (mine !== generation.current) {
				return
			}
			// The extension host could not be asked. That says nothing about the
			// provider, so it is not painted red.
			setState("unknown")
			setDetail(`Could not check: ${error instanceof Error ? error.message : String(error)}`)
		} finally {
			if (mine === generation.current) {
				setChecking(false)
			}
		}
	}, [providerId])

	// A new provider (or the first render) starts grey and is checked at once;
	// the same provider with changed settings is checked once they settle. One
	// effect, because a provider switch changes both and must check once.
	const checkedProvider = useRef<string | undefined>(undefined)
	const lastSettings = useRef<object | undefined>(undefined)
	useEffect(() => {
		const previous = lastSettings.current
		lastSettings.current = settings
		if (checkedProvider.current !== providerId) {
			checkedProvider.current = providerId
			generation.current++
			setState("unknown")
			setDetail(NOT_YET)
			setChecking(false)
			void check()
			return
		}
		if (previous === undefined || previous === settings) {
			return
		}
		const timer = setTimeout(() => void check(), SETTINGS_SETTLE_MS)
		return () => clearTimeout(timer)
	}, [providerId, settings, check])

	const recheck = useCallback(() => void check(), [check])
	return { state, detail, checking, recheck }
}

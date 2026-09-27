import { OllamaReachabilityRequest, type XollamaModelStatusResponse } from "@shared/proto/cline/models"
import { useEffect, useState } from "react"
import { ModelsServiceClient } from "@/services/grpc-client"
import { PolykvStatusStrip } from "./PolykvStatusStrip"

/**
 * What the selected xOllama model is, and so who manages its KV pools.
 *
 * Asked when the model is chosen (xollama mail #414), because the answer
 * decides what Cerebriline sends. A council model's pools belong to xOllama and
 * the lead sends it no pool controls. A plain model is pooled by Cerebriline,
 * as on opencoti, but only where the model keeps seats for it
 * (`session.client_pools`): without them the engine refuses every create, and
 * saying so here is the difference between "PolyKV is off" and "PolyKV is
 * silently not working".
 */
export function describeXollamaModel(status: XollamaModelStatusResponse): string {
	if (status.council) {
		return "Council model: xOllama runs the council and manages its KV pools. Cerebriline sends it no pool controls; agents on this model run as plain chats."
	}
	if (status.clientPools <= 0) {
		return 'Plain model with no pool seats for Cerebriline, so its prompt is not pooled. Set "session.client_pools" for the model in xOllama (or XOLLAMA_POLYKV_CLIENT_POOLS) to share it through PolyKV.'
	}
	const seats = `${status.clientPools} pool ${status.clientPools === 1 ? "seat" : "seats"}`
	if (status.engine === undefined) {
		return `Plain model with ${seats} for Cerebriline. Its engine is not running yet; the first turn loads it and the next one is pooled.`
	}
	if (status.engine !== "opencoti") {
		return `Plain model with ${seats}, but served by ${status.engine}, which has no PolyKV. Nothing is pooled.`
	}
	return `Plain model with ${seats} for Cerebriline: it shares the system prompt and tools of every conversation through PolyKV.`
}

export const XollamaModelStrip = ({ modelId }: { modelId?: string }) => {
	const [status, setStatus] = useState<XollamaModelStatusResponse | undefined>()

	useEffect(() => {
		setStatus(undefined)
		if (!modelId) {
			return
		}
		let cancelled = false
		ModelsServiceClient.readXollamaModelStatus(OllamaReachabilityRequest.create({ providerId: "xollama", modelId }))
			.then((next) => {
				if (!cancelled) {
					setStatus(next)
				}
			})
			.catch(() => {
				// Nothing known is nothing said: the chat input already reports a
				// server that does not answer.
			})
		return () => {
			cancelled = true
		}
	}, [modelId])

	if (!status?.reachable) {
		return null
	}
	return (
		<div className="mt-[6px] text-xs text-(--vscode-descriptionForeground)" data-testid="xollama-model-strip">
			<div>{describeXollamaModel(status)}</div>
			{status.polykv && <PolykvStatusStrip providerId="xollama" status={status.polykv} />}
		</div>
	)
}

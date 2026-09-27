import { OllamaReachabilityRequest, type XollamaModelStatusResponse } from "@shared/proto/cline/models"
import { useEffect, useRef, useState } from "react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useProviderConfig } from "@/hooks/useProviderConfig"
import { ModelsServiceClient } from "@/services/grpc-client"
import { DebouncedTextField } from "./DebouncedTextField"
import { PolykvSection } from "./PolykvSection"
import { PolykvStatusStrip } from "./PolykvStatusStrip"

type PolykvSettings = NonNullable<NonNullable<ReturnType<typeof useProviderConfig>["config"]>["polykv"]>

/**
 * The conversation's window on a plain xOllama model (context_window_v1):
 * opencoti's two window fields, in xOllama's own settings section.
 *
 * Asked through `placement.num_ctx` / `num_ctx_min` and never through the
 * model's `num_ctx`, which is the model load (xollama #424). The grant comes
 * back as `X-Context-Window`, and a resumed conversation asks for exactly
 * that window again. Writes compose from what was last sent, as in
 * `PolykvSection`, so two quick edits cannot put back each other's field.
 */
export const XollamaWindowFields = () => {
	const { config, write } = useProviderConfig("xollama" as never)
	const pending = useRef<PolykvSettings | undefined>(undefined)
	const inFlight = useRef(0)
	if (config === undefined) {
		return null
	}
	const polykv: PolykvSettings = pending.current ?? config.polykv ?? {}
	const patch = (changes: Partial<PolykvSettings>) => {
		const next = { ...(pending.current ?? config.polykv ?? {}), ...changes } as PolykvSettings
		pending.current = next
		inFlight.current += 1
		return write({ polykv: next })
			.catch((error) => console.error("Failed to update the xOllama window settings:", error))
			.finally(() => {
				inFlight.current -= 1
				if (inFlight.current === 0) {
					pending.current = undefined
				}
			})
	}
	return (
		<div className="mt-[8px] flex flex-col gap-1">
			<div className="flex items-center justify-between w-full">
				<Label className="text-xs font-medium text-foreground" htmlFor="xollama-book-window">
					Book a context window
				</Label>
				<Switch
					checked={polykv.dynamicContextSize === true}
					className="shrink-0"
					id="xollama-book-window"
					onCheckedChange={(checked) => patch({ dynamicContextSize: checked })}
					size="default"
				/>
			</div>
			<p className="text-xs m-0">
				Asks the engine to guarantee this model's context size for the conversation, so another session cannot take the
				cells out from under it. Off, the engine decides. A resumed conversation asks for exactly the window it was
				granted.
			</p>
			{polykv.dynamicContextSize === true && (
				<div className="mt-[4px]">
					<DebouncedTextField
						initialValue={polykv.contextFloor !== undefined ? String(polykv.contextFloor) : ""}
						numeric
						onChange={(value) => {
							const parsed = value.trim() === "" ? undefined : Number(value)
							const next = parsed !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
							if (next === polykv.contextFloor) {
								return
							}
							return patch({ contextFloor: next })
						}}
						placeholder="Default: none — all or nothing"
						style={{ width: "100%" }}>
						<span className="font-semibold">Never go below</span>
					</DebouncedTextField>
					<p className="text-xs mt-[5px]">
						The smallest window still worth opening with, in tokens. Below it the conversation is refused at once
						rather than opened too small.
					</p>
				</div>
			)}
		</div>
	)
}

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
	// Seats are pools alive at once (xollama model-settings.mdx, 509024be): a
	// lead that books a window holds 2, each concurrent swarm tree 3, and a
	// continuation compaction freezes the lead into one more. eleven2go,
	// 2026-09-27: with 5 seats a lead and one agent tree took all of them and
	// the lead's compaction was refused "pool seq-id reservoir exhausted".
	const room =
		status.clientPools < 5
			? ` A lead that books a window holds 2 seats, each concurrent swarm 3 and a lead's compaction 1 more, so ${status.clientPools} ${status.clientPools === 1 ? "seat is" : "seats are"} short of a lead and a swarm together (5); a swarm then gets fewer layers and shares less.`
			: status.clientPools < 6
				? ` A lead and a swarm take all ${status.clientPools}; a lead that compacts while its swarm runs needs one more (6), or its compaction runs without a frozen pool and prefills the transcript again.`
				: ""
	return `Plain model with ${seats} for Cerebriline: it shares the system prompt and tools of every conversation through PolyKV.${room}`
}

/**
 * Whether Cerebriline drives this model's pools: a plain model with seats for
 * it, on an engine that has pools (or one not started yet, which on a model
 * with seats is opencoti's).
 */
export function xollamaPoolsClients(status: XollamaModelStatusResponse): boolean {
	return !status.council && status.clientPools > 0 && (status.engine === undefined || status.engine === "opencoti")
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
			{xollamaPoolsClients(status) ? (
				<PolykvSection engine="xollama" providerId="xollama" windowNegotiation={status.windowNegotiation} />
			) : (
				!status.council && status.windowNegotiation && <XollamaWindowFields />
			)}
			{status.polykv && <PolykvStatusStrip providerId="xollama" status={status.polykv} />}
		</div>
	)
}

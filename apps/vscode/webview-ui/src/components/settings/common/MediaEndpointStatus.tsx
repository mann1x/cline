import { type MediaEndpointKind, type MediaEndpointStatus, parseMediaEndpointStatus } from "@shared/media-endpoint-status"
import { StringRequest } from "@shared/proto/cline/common"
import { useEffect, useState } from "react"
import { ModelsServiceClient } from "@/services/grpc-client"

export const MEDIA_SERVER_NAMES = {
	opencoti: "opencoti",
	xollama: "xOllama",
	openai: "OpenAI-compatible",
	unknown: "not answering",
} as const

/**
 * What the next session will do with one kind of media tool, asked of the host.
 *
 * The host holds the session provider's key and can ask each server what it
 * serves; a tab can do neither. Asked again whenever `trigger` changes -- pass
 * what the tab stores -- and never on an interval: the endpoint is the user's,
 * and an unbounded poll hammers a metered one for as long as the pane is open.
 */
export function useMediaEndpointStatus(kind: MediaEndpointKind, trigger: string): MediaEndpointStatus {
	const [status, setStatus] = useState<MediaEndpointStatus>({})
	// biome-ignore lint/correctness/useExhaustiveDependencies: `trigger` is what changed, not an input to the request
	useEffect(() => {
		let current = true
		ModelsServiceClient.readMediaEndpoint(StringRequest.create({ value: kind }))
			.then((response) => {
				if (current) {
					setStatus(parseMediaEndpointStatus(response?.value))
				}
			})
			.catch((error) => console.error(`Failed to read the ${kind} endpoint status:`, error))
		return () => {
			current = false
		}
	}, [kind, trigger])
	return status
}

/** The models to offer in a tab's picker: the provider's when the tool goes there, the typed endpoint's otherwise. */
export function mediaPickerModels(status: MediaEndpointStatus): string[] {
	return status.resolved?.source === "provider" ? (status.provider?.models ?? []) : (status.typedModels ?? [])
}

interface MediaEndpointStatusLinesProps {
	status: MediaEndpointStatus
	/** The tool this is about, as the model calls it. */
	tool: string
	/** What the provider does when it serves this, e.g. "generates images". */
	serves: string
	/** What it lacks when it does not, e.g. "no image engine loaded". */
	lacks: string
	/** Whether the tab's "use the session's provider" box is ticked. */
	useProvider: boolean
	/** The label of the box that switches the tool off. */
	toggle: string
}

/**
 * Where a tool goes and why, in the two or three sentences every media tab
 * needs: what the session's provider is, where the tool resolves, and the
 * warning that a typed endpoint is offered even though it is not answering.
 */
export const MediaEndpointStatusLines = ({ status, tool, serves, lacks, useProvider, toggle }: MediaEndpointStatusLinesProps) => (
	<>
		{useProvider && status.provider ? (
			<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
				{status.provider.serves
					? `The current provider is ${MEDIA_SERVER_NAMES[status.provider.server]} and ${serves}.`
					: status.provider.server === "openai"
						? "The current provider is neither opencoti nor xOllama, so the endpoint below is used."
						: `The current provider is ${MEDIA_SERVER_NAMES[status.provider.server]} but has ${lacks}, so the endpoint below is used.`}
			</p>
		) : null}
		{status.resolved ? (
			<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
				<code>{tool}</code> goes to{" "}
				{status.resolved.source === "provider" ? "the session's provider" : "the endpoint below"} (
				{MEDIA_SERVER_NAMES[status.resolved.server]}), model <code>{status.resolved.model}</code>.
				{status.resolved.warning ? (
					<span className="text-(--vscode-editorWarning-foreground)">
						{" "}
						The tool is still offered, but {status.resolved.warning}. Untick "{toggle}" if you do not want it.
					</span>
				) : null}
			</p>
		) : status.disabled ? (
			<p className="text-xs mt-1 text-(--vscode-errorForeground)">
				<code>{tool}</code> is not offered: {status.disabled}.
			</p>
		) : null}
	</>
)

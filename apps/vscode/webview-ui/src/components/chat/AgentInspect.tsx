import type { SubagentStatusItem } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/cline/common"
import type { SubagentOutputUpdate } from "@shared/proto/cline/task"
import { ArrowLeftIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { TaskServiceClient } from "@/services/grpc-client"
import { applySubagentOutputUpdate, type InspectChunk, inspectToolHeading } from "./subagentOutputView"

/** Within this many pixels of the bottom counts as following the stream. */
const FOLLOW_SLACK_PX = 16

/** The agent's current step as the host streams it, while this is mounted. */
function useSubagentOutput(cancelId: string): InspectChunk[] {
	const [chunks, setChunks] = useState<InspectChunk[]>([])
	useEffect(() => {
		setChunks([])
		const cancel = TaskServiceClient.subscribeSubagentOutput(StringRequest.create({ value: cancelId }), {
			onResponse: (update: SubagentOutputUpdate) => setChunks((current) => applySubagentOutputUpdate(current, update)),
			onError: (error: unknown) => console.error("Inspect stream failed:", error),
			onComplete: () => {},
		})
		return cancel
	}, [cancelId])
	return chunks
}

/**
 * What the model is generating for this agent, as it generates it: its
 * thinking, its answer and the tool calls it writes, since its latest request
 * began. The row's Output line says what it is doing ("Writing editor call:
 * 8,327 characters"); this is the text itself.
 *
 * It follows the newest output; scrolling up stops that, and scrolling back
 * to the bottom resumes it.
 */
export function AgentInspect({ agent, onBack }: { agent: SubagentStatusItem & { cancelId: string }; onBack: () => void }) {
	const chunks = useSubagentOutput(agent.cancelId)
	const scroller = useRef<HTMLDivElement>(null)
	const following = useRef(true)

	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on each new chunk, to keep the newest in view.
	useEffect(() => {
		const element = scroller.current
		if (element && following.current) {
			element.scrollTop = element.scrollHeight
		}
	}, [chunks])

	const onScroll = () => {
		const element = scroller.current
		if (element) {
			following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK_PX
		}
	}

	const empty =
		agent.status === "pending"
			? "Queued: nothing generated yet."
			: "Nothing generated yet in this step. Waiting for the model."

	return (
		<div className="mt-1.5">
			<div className="flex items-center gap-2 text-[10px]">
				<button
					aria-label="Back to the agent's details"
					className="flex shrink-0 cursor-pointer items-center gap-1 rounded-xs border border-editor-group-border bg-transparent px-1.5 py-[1px] text-foreground opacity-80 hover:opacity-100"
					onClick={onBack}
					title="Back to the instructions, activity and output"
					type="button">
					<ArrowLeftIcon className="size-2.5" />
					<span>Back</span>
				</button>
				<span className="opacity-60">Live output: the current step, newest last</span>
			</div>
			<div
				className="mt-1 h-[28vh] min-h-32 overflow-y-auto rounded-xs border border-editor-group-border bg-editor-background px-2 py-1.5 font-mono text-[10.5px] leading-snug"
				onScroll={onScroll}
				ref={scroller}>
				{chunks.length === 0 ? (
					<div className="opacity-60">{empty}</div>
				) : (
					chunks.map((chunk, index) => (
						// Order is the identity here: chunks only ever join the last or clear.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above.
						<div className={index > 0 ? "mt-1.5" : ""} key={index}>
							{chunk.kind === "tool" && (
								<div className="text-[10px] font-medium text-link opacity-80">{inspectToolHeading(chunk)}</div>
							)}
							<pre
								className={`m-0 whitespace-pre-wrap break-words font-mono ${
									chunk.kind === "reasoning"
										? "italic opacity-60"
										: chunk.kind === "tool"
											? "opacity-85"
											: "opacity-95"
								}`}>
								{chunk.text}
							</pre>
						</div>
					))
				)}
			</div>
		</div>
	)
}

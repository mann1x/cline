import { type SubagentOutputChunk as CoreChunk, subagentOutput } from "@cline/core"
import type { StringRequest } from "@shared/proto/cline/common"
import type { SubagentOutputChunk, SubagentOutputUpdate } from "@shared/proto/cline/task"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"

/**
 * How often what streamed is sent, at most. The model emits one event per
 * token; one webview message per token is the cost this view must not add to
 * a swarm, and a tenth of a second still reads as live.
 */
const FLUSH_MS = 100

function toProto(chunk: CoreChunk): SubagentOutputChunk {
	return {
		kind: chunk.kind,
		text: chunk.text,
		...(chunk.toolName ? { toolName: chunk.toolName } : {}),
		...(chunk.toolCallId ? { toolCallId: chunk.toolCallId } : {}),
	}
}

/**
 * Stream one sub-agent's current step to the row that is inspecting it: the
 * step so far, then what follows.
 *
 * The id is the one the spawn tool announced on the row, as for
 * cancelSubagent. An agent that has not written yet -- queued, prefilling --
 * or one that has ended streams an empty step rather than failing: the row
 * closes the view when the agent leaves it.
 */
export async function subscribeSubagentOutput(
	_controller: Controller,
	request: StringRequest,
	responseStream: StreamingResponseHandler<SubagentOutputUpdate>,
	requestId?: string,
): Promise<void> {
	const id = request.value?.trim()
	if (!id) {
		return
	}
	let reset = false
	let pending: SubagentOutputChunk[] = []
	let timer: ReturnType<typeof setTimeout> | undefined
	let closed = false

	const send = async (update: SubagentOutputUpdate) => {
		try {
			await responseStream(update, false)
		} catch (error) {
			Logger.error(`[Agents] inspect stream for ${id} failed:`, error)
			close()
		}
	}
	const flush = () => {
		timer = undefined
		if (closed || (!reset && pending.length === 0)) {
			return
		}
		const update: SubagentOutputUpdate = { reset, chunks: pending }
		reset = false
		pending = []
		void send(update)
	}

	const { snapshot, unsubscribe } = subagentOutput.subscribe(id, (event) => {
		if (event.type === "step") {
			reset = true
			pending = []
		} else {
			const last = pending[pending.length - 1]
			if (last && last.kind === event.chunk.kind && last.toolCallId === event.chunk.toolCallId) {
				last.text += event.chunk.text
			} else {
				pending.push(toProto(event.chunk))
			}
		}
		timer ??= setTimeout(flush, FLUSH_MS)
	})

	function close() {
		if (closed) {
			return
		}
		closed = true
		if (timer) {
			clearTimeout(timer)
		}
		unsubscribe()
	}

	if (requestId) {
		getRequestRegistry().registerRequest(requestId, close, { type: "subagentOutput_subscription" }, responseStream)
	}
	await send({ reset: true, chunks: snapshot.map(toProto) })
}

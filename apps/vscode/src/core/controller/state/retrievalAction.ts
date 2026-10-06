import { String as ProtoString, type StringRequest } from "@shared/proto/cline/common"
import { runRetrievalAction } from "@/sdk/retrieval-status"
import type { Controller } from ".."

/**
 * The Library and Memory panels' one call: a JSON action in, the result and
 * the status after it out. See `runRetrievalAction`.
 */
export async function retrievalAction(_controller: Controller, request: StringRequest): Promise<ProtoString> {
	return ProtoString.create({ value: JSON.stringify(await runRetrievalAction(request.value)) })
}

import { describe, expect, it } from "vitest"
import type { ClineMessage } from "../ExtensionMessage"
import { convertClineMessageToProto, convertProtoToClineMessage } from "./cline-message"

/**
 * The failure this guards against is a field that is written and never read
 * back: the host stamps it, the conversion drops it, and the box renders
 * without a time while nothing anywhere reports an error.
 */
describe("the run duration survives the proto round trip", () => {
	const completion: ClineMessage = {
		ts: 1_700_000_000_000,
		type: "say",
		say: "completion_result",
		text: "The task is finished.",
	}

	it("carries the duration there and back", () => {
		const message = { ...completion, runDurationMs: 1_680_000 }

		const roundTripped = convertProtoToClineMessage(convertClineMessageToProto(message))

		expect(roundTripped.runDurationMs).toBe(1_680_000)
	})

	// 0 is the proto default for every row that was never timed, and it must
	// not come back as a run that took no time at all.
	it("leaves an untimed row untimed rather than zero", () => {
		const roundTripped = convertProtoToClineMessage(convertClineMessageToProto(completion))

		expect(roundTripped.runDurationMs).toBeUndefined()
	})
})

import { OpencotiWindowUnavailableError } from "@cline/llms"
import { describe, expect, it } from "vitest"
import { ClineError, ClineErrorType } from "../services/error/ClineError"
import { reshapeErrorForWebview } from "./message-translator"

describe("the Can't resume card's payload", () => {
	it("carries the refusal's numbers to the webview under its own code", () => {
		const refusal = new OpencotiWindowUnavailableError({
			asked: 262_144,
			floor: 262_144,
			largestAdmissible: 131_072,
			resume: true,
		})
		const payload = reshapeErrorForWebview({ message: refusal.message }, "opencoti", "m", "unknown")
		const parsed = ClineError.parse(payload)
		expect(parsed?.isErrorType(ClineErrorType.OpencotiWindowUnavailable)).toBe(true)
		expect(parsed?._error.details).toMatchObject({
			asked: 262_144,
			floor: 262_144,
			largestAdmissible: 131_072,
			resume: true,
		})
		// The machine tail is for the parser, not the reader.
		expect(parsed?._error.message).not.toContain("opencoti_window_unavailable")
	})
})

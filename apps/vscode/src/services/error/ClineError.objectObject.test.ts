import { describe, expect, it } from "vitest"
import { ClineError, clineErrorMessageOf } from "./ClineError"

// Reported from pandorum, against a repeat_last_n the server rejected. The
// chat showed two lines:
//
//   [object Object]
//   {"error":{"code":400,"message":"Field 'repeat_last_n': Value must be …"}}
//
// ErrorRow renders the parsed message and then the raw payload when they
// differ, so the first line is what ClineError made of the body. A body shaped
// {"error":{…}} has no message at the top level, and the old chain's next
// reachable term was String(error).
const BODY = JSON.stringify({
	error: {
		code: 400,
		message: "Field 'repeat_last_n': Value must be between 0 <= value <= 2147483647, but got -1",
		type: "invalid_request_error",
	},
})

describe("the message a provider error carries", () => {
	it("reads the nested message rather than stringifying the body", () => {
		const parsed = ClineError.parse(BODY)

		expect(parsed?.message).toContain("repeat_last_n")
		expect(parsed?.message).not.toBe("[object Object]")
		expect(parsed?._error?.message).not.toBe("[object Object]")
	})

	it("never returns [object Object] for an object with no message anywhere", () => {
		const message = clineErrorMessageOf({ some: "shape", nested: { deep: 1 } })

		expect(message).not.toBe("[object Object]")
		expect(message).toContain("some")
	})

	it("prefers a top-level message when there is one", () => {
		expect(clineErrorMessageOf({ message: "plain", error: { message: "nested" } })).toBe("plain")
	})

	it("reaches the other shapes providers use", () => {
		expect(clineErrorMessageOf({ error: { message: "from error.error" } })).toBe("from error.error")
		expect(clineErrorMessageOf({ response: { message: "from response" } })).toBe("from response")
		expect(clineErrorMessageOf({ cause: { message: "from cause" } })).toBe("from cause")
		expect(clineErrorMessageOf({ data: { error: { message: "from data" } } })).toBe("from data")
	})

	it("ignores a blank message instead of returning it", () => {
		expect(clineErrorMessageOf({ message: "   ", error: { message: "real" } })).toBe("real")
	})

	it("survives an error object it cannot serialize", () => {
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic

		expect(clineErrorMessageOf(cyclic)).toBe("Unknown error")
	})
})

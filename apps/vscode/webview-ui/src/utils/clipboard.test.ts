import { beforeEach, describe, expect, it, vi } from "vitest"

const copyToClipboard = vi.fn().mockResolvedValue({})
vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: {
		copyToClipboard: (...args: unknown[]) => copyToClipboard(...args),
	},
}))

import { writeToClipboard } from "./clipboard"

/** Replace the webview clipboard for one test. */
function withWebviewClipboard(writeText: () => Promise<void>): void {
	Object.defineProperty(globalThis.navigator, "clipboard", {
		configurable: true,
		value: { writeText },
	})
}

describe("writeToClipboard", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("uses the webview clipboard when it works, and does not call the host", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined)
		withWebviewClipboard(writeText)

		await expect(writeToClipboard("the reasoning")).resolves.toBe(true)
		expect(writeText).toHaveBeenCalledWith("the reasoning")
		expect(copyToClipboard).not.toHaveBeenCalled()
	})

	it("falls back to the host when the webview clipboard rejects", async () => {
		// The reported failure: a panel that does not have focus rejects here,
		// and every copy button in this UI treated that as done.
		withWebviewClipboard(vi.fn().mockRejectedValue(new Error("not focused")))

		await expect(writeToClipboard("the reasoning")).resolves.toBe(true)
		expect(copyToClipboard).toHaveBeenCalledWith(expect.objectContaining({ value: "the reasoning" }))
	})

	it("reports failure when neither can write", async () => {
		withWebviewClipboard(vi.fn().mockRejectedValue(new Error("not focused")))
		copyToClipboard.mockRejectedValueOnce(new Error("host is gone"))

		await expect(writeToClipboard("the reasoning")).resolves.toBe(false)
	})

	it("refuses to write nothing", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined)
		withWebviewClipboard(writeText)

		await expect(writeToClipboard("")).resolves.toBe(false)
		await expect(writeToClipboard("   \n ")).resolves.toBe(false)
		await expect(writeToClipboard(undefined)).resolves.toBe(false)
		// Overwriting a clipboard the user was relying on with an empty string
		// is a worse outcome than not copying.
		expect(writeText).not.toHaveBeenCalled()
		expect(copyToClipboard).not.toHaveBeenCalled()
	})
})

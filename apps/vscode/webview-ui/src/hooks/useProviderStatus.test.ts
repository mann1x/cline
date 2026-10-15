import { ProviderStatusResponse } from "@shared/proto/cline/models"
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ModelsServiceClient } from "@/services/grpc-client"
import { SETTINGS_SETTLE_MS, useProviderStatus } from "./useProviderStatus"

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: { readProviderStatus: vi.fn() },
}))

const read = vi.mocked(ModelsServiceClient.readProviderStatus)
const answer = (state: string, detail = `${state} detail`) => ProviderStatusResponse.create({ state, detail })

beforeEach(() => {
	read.mockReset()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("useProviderStatus", () => {
	it("starts grey and turns green when the endpoint answers", async () => {
		read.mockResolvedValue(answer("ready", "http://box/v1/models answered (HTTP 200)."))
		const { result } = renderHook(() => useProviderStatus("openai", undefined))
		expect(result.current.state).toBe("unknown")
		await waitFor(() => expect(result.current.state).toBe("ready"))
		expect(result.current.detail).toBe("http://box/v1/models answered (HTTP 200).")
		expect(read).toHaveBeenCalledTimes(1)
		expect(read.mock.calls[0][0].value).toBe("openai")
	})

	it("turns red on a failed check", async () => {
		read.mockResolvedValue(answer("fail"))
		const { result } = renderHook(() => useProviderStatus("anthropic", undefined))
		await waitFor(() => expect(result.current.state).toBe("fail"))
	})

	it("stays grey, not red, when the extension host cannot be asked", async () => {
		read.mockRejectedValue(new Error("host gone"))
		const { result } = renderHook(() => useProviderStatus("openai", undefined))
		await waitFor(() => expect(result.current.detail).toBe("Could not check: host gone"))
		expect(result.current.state).toBe("unknown")
	})

	it("checks again when pressed", async () => {
		read.mockResolvedValueOnce(answer("fail")).mockResolvedValueOnce(answer("ready"))
		const { result } = renderHook(() => useProviderStatus("openai", undefined))
		await waitFor(() => expect(result.current.state).toBe("fail"))
		act(() => result.current.recheck())
		await waitFor(() => expect(result.current.state).toBe("ready"))
		expect(read).toHaveBeenCalledTimes(2)
	})

	it("does not let a late answer for the previous provider paint the new one", async () => {
		let releaseOld: (value: ProviderStatusResponse) => void = () => {}
		read.mockImplementationOnce(() => new Promise((resolve) => (releaseOld = resolve))).mockResolvedValueOnce(
			answer("fail", "new provider"),
		)
		const { result, rerender } = renderHook(({ id }) => useProviderStatus(id, undefined), {
			initialProps: { id: "openai" },
		})
		rerender({ id: "anthropic" })
		await waitFor(() => expect(result.current.detail).toBe("new provider"))
		await act(async () => releaseOld(answer("ready", "old provider")))
		expect(result.current.state).toBe("fail")
		expect(result.current.detail).toBe("new provider")
	})

	it("checks once more after a settings change settles, and not for the first config read", async () => {
		vi.useFakeTimers()
		read.mockResolvedValue(answer("ready"))
		const first = {}
		const { rerender } = renderHook(({ settings }) => useProviderStatus("openai", settings), {
			initialProps: { settings: undefined as object | undefined },
		})
		expect(read).toHaveBeenCalledTimes(1)
		// The mount's own read arriving is not a change.
		rerender({ settings: first })
		await act(async () => vi.advanceTimersByTime(SETTINGS_SETTLE_MS * 2))
		expect(read).toHaveBeenCalledTimes(1)
		// Two writes in quick succession are one check, after they settle.
		rerender({ settings: {} })
		await act(async () => vi.advanceTimersByTime(SETTINGS_SETTLE_MS / 2))
		rerender({ settings: {} })
		await act(async () => vi.advanceTimersByTime(SETTINGS_SETTLE_MS - 1))
		expect(read).toHaveBeenCalledTimes(1)
		await act(async () => vi.advanceTimersByTime(1))
		expect(read).toHaveBeenCalledTimes(2)
	})

	it("asks nothing without a provider", () => {
		const { result } = renderHook(() => useProviderStatus(undefined, undefined))
		expect(result.current.state).toBe("unknown")
		expect(read).not.toHaveBeenCalled()
	})
})

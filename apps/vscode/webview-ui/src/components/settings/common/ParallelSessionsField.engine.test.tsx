import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ readOpencotiEngine: vi.fn() }))

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: { readOpencotiEngine: mocks.readOpencotiEngine },
}))

import { useOpencotiEngineMode } from "./ParallelSessionsField"

function engine(overrides: { reachable?: boolean; poolsEnabled?: boolean; elastic?: boolean }) {
	return { reachable: true, poolsEnabled: false, elastic: false, ...overrides }
}

describe("asking opencoti which case the field is in", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("never asks on any other provider", () => {
		const { result } = renderHook(() => useOpencotiEngineMode("ollama"))
		expect(result.current).toBeUndefined()
		expect(mocks.readOpencotiEngine).not.toHaveBeenCalled()
	})

	// PolyKV is named when both are on: its admission control is what says yes
	// or no to the next agent.
	it.each([
		[{ poolsEnabled: true, elastic: true }, "polykv"],
		[{ elastic: true }, "elastic"],
		[{}, "fixed"],
		[{ reachable: false }, "unknown"],
	] as const)("reads %j as %s", async (answer, expected) => {
		mocks.readOpencotiEngine.mockResolvedValue(engine(answer))
		const { result } = renderHook(() => useOpencotiEngineMode("opencoti"))
		await waitFor(() => expect(result.current).toBe(expected))
	})

	// A failed read is not "fixed": telling someone their server has neither
	// controller on because the question failed would be a guess wearing a
	// fact's clothes.
	it("reads a failed request as unknown, not as fixed", async () => {
		mocks.readOpencotiEngine.mockRejectedValue(new Error("no host"))
		const { result } = renderHook(() => useOpencotiEngineMode("opencoti"))
		await waitFor(() => expect(mocks.readOpencotiEngine).toHaveBeenCalledTimes(1))
		await waitFor(() => expect(result.current).toBe("unknown"))
	})
})

import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PolykvStatusStrip } from "./PolykvStatusStrip"

const mocks = vi.hoisted(() => ({ readPolykvStatus: vi.fn() }))

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: { readPolykvStatus: mocks.readPolykvStatus },
}))

function status(overrides: Record<string, unknown> = {}) {
	return {
		reachable: true,
		release: "c7",
		poolsEnabled: true,
		elastic: true,
		elasticReason: "saturated, hold",
		slotsLive: 3,
		slotsMax: 8,
		pools: [],
		sessions: [],
		...overrides,
	}
}

describe("the PolyKV status strip", () => {
	beforeEach(() => {
		mocks.readPolykvStatus.mockReset()
	})

	it("shows the elastic state and the engine's own reason", async () => {
		mocks.readPolykvStatus.mockResolvedValue(status())
		render(<PolykvStatusStrip providerId="opencoti" />)

		expect(await screen.findByText(/3 of 8/)).toBeInTheDocument()
		// Verbatim: "saturated, hold" and "kv headroom exhausted" ask for
		// different fixes, and one word for both throws that away.
		expect(screen.getByText(/saturated, hold/)).toBeInTheDocument()
	})

	// A server with no pools and a server that is not there are different
	// things, and the panel has to say which.
	it("says a server is unreachable rather than showing it as empty", async () => {
		mocks.readPolykvStatus.mockResolvedValue(status({ reachable: false, poolsEnabled: false, elastic: false }))
		render(<PolykvStatusStrip providerId="opencoti" />)

		expect(await screen.findByText(/could not be reached/i)).toBeInTheDocument()
	})

	it("names a pin that nothing references, because it blocks reclaim forever", async () => {
		mocks.readPolykvStatus.mockResolvedValue(
			status({
				poolsMax: 4,
				pools: [
					{ poolId: "0", pinned: true, ephemeral: false, orphanedPin: false, children: 1, prefixLen: 12859 },
					{ poolId: "1", parent: "0", pinned: true, ephemeral: false, orphanedPin: true, children: 0 },
				],
			}),
		)
		render(<PolykvStatusStrip providerId="opencoti" />)

		expect(await screen.findByText(/2 of 4/)).toBeInTheDocument()
		expect(screen.getByText(/orphaned pin/i)).toBeInTheDocument()
	})

	it("lists sessions by their own id", async () => {
		mocks.readPolykvStatus.mockResolvedValue(
			status({
				sessions: [
					{ sessionId: "lead", tps: 41.2, active: true },
					{ sessionId: "worker-1", active: true },
				],
			}),
		)
		render(<PolykvStatusStrip providerId="opencoti" />)

		expect(await screen.findByText("lead")).toBeInTheDocument()
		expect(screen.getByText("worker-1")).toBeInTheDocument()
		// A processing slot with no EWMA yet is warming, not idle.
		expect(screen.getByText(/warming/i)).toBeInTheDocument()
	})

	// It reads /props, /polykv/pools and /polykv/tps once, on demand. Nothing
	// here polls, and nothing here may ever reach /capacity: on c7 every GET of
	// that folds the engine's admission learner.
	it("reads once and does not poll", async () => {
		mocks.readPolykvStatus.mockResolvedValue(status())
		render(<PolykvStatusStrip providerId="opencoti" />)

		await waitFor(() => expect(mocks.readPolykvStatus).toHaveBeenCalledTimes(1))
		await new Promise((resolve) => setTimeout(resolve, 60))
		expect(mocks.readPolykvStatus).toHaveBeenCalledTimes(1)
	})

	it("says so when the read fails instead of rendering a blank strip", async () => {
		mocks.readPolykvStatus.mockRejectedValue(new Error("no transport"))
		render(<PolykvStatusStrip providerId="opencoti" />)

		expect(await screen.findByText(/could not be reached/i)).toBeInTheDocument()
	})
})

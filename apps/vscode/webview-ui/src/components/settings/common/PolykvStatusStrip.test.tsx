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
		// A repeated proto field always decodes to an array, never to
		// undefined. The fixture is hand-built, so it has to say so too --
		// omitting one is how a hand-built fixture stops resembling the message
		// it stands in for, and the component then crashes only in production.
		allocations: [],
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

	// Present only once the server says the plain GET is read-only. The strip
	// renders whatever the host sent; the decision not to ask lives one layer
	// down, and absent here means the question was not asked.
	it("shows the KV headroom when the server let it be read", async () => {
		mocks.readPolykvStatus.mockResolvedValue(status({ kvHeadroomPct: 62.5, kvCellsFree: 640000, kvCellsTotal: 1048576 }))
		render(<PolykvStatusStrip providerId="opencoti" />)

		expect(await screen.findByText(/62.5% KV headroom/)).toBeInTheDocument()
		expect(screen.getByText(/640,000 of 1,048,576 cells/)).toBeInTheDocument()
	})

	// The sliding-window ring is a separate account, so it gets a separate
	// line. Adding it to the base figures, or showing either as the total,
	// is the misreading the split exists to prevent.
	it("keeps the sliding-window arm on its own line", async () => {
		mocks.readPolykvStatus.mockResolvedValue(
			status({ kvCellsFree: 100, kvCellsTotal: 200, swaActive: true, swaCellsFree: 4096, swaCellsTotal: 8192 }),
		)
		render(<PolykvStatusStrip providerId="opencoti" />)

		expect(await screen.findByText(/sliding window/i)).toBeInTheDocument()
		expect(screen.getByText(/4,096 of 8,192/)).toBeInTheDocument()
	})

	it("shows nothing about headroom when the server was never asked", async () => {
		mocks.readPolykvStatus.mockResolvedValue(status())
		render(<PolykvStatusStrip providerId="opencoti" />)

		await waitFor(() => expect(mocks.readPolykvStatus).toHaveBeenCalledTimes(1))
		expect(screen.queryByText(/KV headroom/)).not.toBeInTheDocument()
		expect(screen.queryByText(/sliding window/i)).not.toBeInTheDocument()
	})

	// A session's pool binding, on the builds that report a real one.
	it("names the pool a session is bound to when the server reports it", async () => {
		mocks.readPolykvStatus.mockResolvedValue(
			status({ sessions: [{ sessionId: "lead", tps: 20, active: true, poolId: "3" }] }),
		)
		render(<PolykvStatusStrip providerId="opencoti" />)

		expect(await screen.findByText(/pool #3/)).toBeInTheDocument()
	})

	// A session's window is not the server's free capacity, and saying so is
	// wrong in the most misleading direction: a full server with one idle
	// session would read as nearly empty.
	it("says whose window the headroom belongs to when it is not the server's", async () => {
		mocks.readPolykvStatus.mockResolvedValue(
			status({ kvHeadroomPct: 12.5, kvCellsFree: 8192, kvCellsTotal: 65536, kvScope: "session", kvScopeOwner: "lead" }),
		)
		render(<PolykvStatusStrip providerId="opencoti" />)

		expect(await screen.findByText(/window of lead/i)).toBeInTheDocument()
		expect(screen.queryByText(/KV headroom/)).not.toBeInTheDocument()
	})

	it("calls it the server's headroom only when it is", async () => {
		mocks.readPolykvStatus.mockResolvedValue(
			status({ kvHeadroomPct: 62.5, kvCellsFree: 640000, kvCellsTotal: 1048576, kvScope: "server" }),
		)
		render(<PolykvStatusStrip providerId="opencoti" />)

		expect(await screen.findByText(/62.5% KV headroom/)).toBeInTheDocument()
		expect(screen.queryByText(/window of/i)).not.toBeInTheDocument()
	})

	// What a new session could book right now, which is the number that decides
	// whether a conversation opens at all.
	it("shows the largest window still admissible", async () => {
		mocks.readPolykvStatus.mockResolvedValue(status({ largestAdmissible: 262144, guaranteed: true }))
		render(<PolykvStatusStrip providerId="opencoti" />)

		expect(await screen.findByText(/262,144 largest admissible/)).toBeInTheDocument()
	})

	// Raw pressure, shown as the percentage the compaction threshold is set
	// against -- not the server's legacy ramp, which would disagree with the
	// number in the setting beside it.
	it("lists each session's window and its raw pressure", async () => {
		mocks.readPolykvStatus.mockResolvedValue(
			status({
				allocations: [{ sessionId: "lead", window: 262144, used: 131072, free: 131072, pressure: 0.5, pools: 3 }],
			}),
		)
		render(<PolykvStatusStrip providerId="opencoti" />)

		expect(await screen.findByText(/131,072 of 262,144/)).toBeInTheDocument()
		expect(screen.getByText(/50% full/)).toBeInTheDocument()
		expect(screen.getByText(/3 pools/)).toBeInTheDocument()
	})
})

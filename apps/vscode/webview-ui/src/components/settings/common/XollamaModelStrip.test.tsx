import { PolykvStatusResponse, XollamaModelStatusResponse } from "@shared/proto/cline/models"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ModelsServiceClient } from "@/services/grpc-client"
import { describeXollamaModel, XollamaModelStrip } from "./XollamaModelStrip"

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: { readXollamaModelStatus: vi.fn(), readPolykvStatus: vi.fn() },
}))
const config = vi.hoisted(() => ({ write: vi.fn(async () => undefined), polykv: {} as Record<string, unknown> }))
vi.mock("@/hooks/useProviderConfig", () => ({
	useProviderConfig: () => ({ config: { polykv: config.polykv }, write: config.write }),
}))

const read = vi.mocked(ModelsServiceClient.readXollamaModelStatus)
const status = (fields: Partial<XollamaModelStatusResponse>) =>
	XollamaModelStatusResponse.create({ reachable: true, council: false, clientPools: 0, ...fields })

describe("what an xOllama model is", () => {
	it("leaves a council's pools to xOllama", () => {
		expect(describeXollamaModel(status({ council: true, clientPools: 4 }))).toMatch(
			/^Council model: xOllama runs the council/,
		)
	})

	it("names the setting a plain model without seats needs", () => {
		expect(describeXollamaModel(status({}))).toContain('"session.client_pools"')
	})

	it("tells a model that is not running from one whose engine has no PolyKV", () => {
		expect(describeXollamaModel(status({ clientPools: 2 }))).toContain("not running yet")
		expect(describeXollamaModel(status({ clientPools: 2, engine: "llamacpp" }))).toContain("served by llamacpp")
		expect(describeXollamaModel(status({ clientPools: 1, engine: "opencoti" }))).toContain("1 pool seat for Cerebriline")
	})
})

describe("the strip", () => {
	beforeEach(() => {
		read.mockReset()
	})

	it("asks about the selected model and shows the engine's status it was given", async () => {
		read.mockResolvedValue(
			status({
				clientPools: 2,
				engine: "opencoti",
				polykv: PolykvStatusResponse.create({ reachable: true, poolsEnabled: true, slotsLive: 1, slotsMax: 4 }),
			}),
		)
		render(<XollamaModelStrip modelId="qwen3:8b" />)
		await waitFor(() => expect(screen.getByTestId("xollama-model-strip")).toBeTruthy())
		expect(read.mock.calls[0]?.[0]).toMatchObject({ providerId: "xollama", modelId: "qwen3:8b" })
		expect(screen.getByText(/1 of 4 slots live/)).toBeTruthy()
		// Given, not fetched: the provider URL is not the model's engine.
		expect(ModelsServiceClient.readPolykvStatus).not.toHaveBeenCalled()
	})

	it("says nothing when no model is chosen or the server does not answer", async () => {
		const { container } = render(<XollamaModelStrip />)
		expect(read).not.toHaveBeenCalled()
		expect(container.textContent).toBe("")
		read.mockResolvedValue(XollamaModelStatusResponse.create({ reachable: false }))
		const second = render(<XollamaModelStrip modelId="m" />)
		await waitFor(() => expect(read).toHaveBeenCalled())
		expect(second.container.textContent).toBe("")
	})
})

describe("the window fields", () => {
	beforeEach(() => {
		read.mockReset()
		config.write.mockClear()
	})

	it("offer booking a window on a plain model of a server that negotiates one, and write it to the section", async () => {
		read.mockResolvedValue(status({ clientPools: 0, windowNegotiation: true }))
		render(<XollamaModelStrip modelId="m" />)
		const toggle = await screen.findByLabelText("Book a context window")
		fireEvent.click(toggle)
		expect(config.write).toHaveBeenCalledWith({ polykv: { dynamicContextSize: true } })
	})

	it("become the whole PolyKV section on a plain model with seats", async () => {
		read.mockResolvedValue(status({ clientPools: 2, engine: "opencoti", windowNegotiation: true }))
		render(<XollamaModelStrip modelId="m" />)
		await screen.findByLabelText("PolyKV")
		expect(screen.getByLabelText("Book a context window")).toBeTruthy()
		expect(screen.getByLabelText("Allow swarms")).toBeTruthy()
		expect(screen.getByText("Per-session throughput floor")).toBeTruthy()
		// opencoti's alone: offered here they would read as set and do nothing.
		expect(screen.queryByLabelText("Compact as a continuation")).toBeNull()
		expect(screen.queryByLabelText("Keep the prefix resident")).toBeNull()
		expect(screen.queryByText("Compact at pool pressure")).toBeNull()
		// The model's engine status is the strip's, not the server root's.
		expect(ModelsServiceClient.readPolykvStatus).not.toHaveBeenCalled()
		fireEvent.click(screen.getByLabelText("Allow swarms"))
		expect(config.write).toHaveBeenCalledWith({ polykv: { swarm: true } })
	})

	it("are not offered on a council, or by a server that cannot negotiate", async () => {
		read.mockResolvedValue(status({ council: true, windowNegotiation: true }))
		const council = render(<XollamaModelStrip modelId="c" />)
		await waitFor(() => expect(screen.getByTestId("xollama-model-strip")).toBeTruthy())
		expect(screen.queryByLabelText("Book a context window")).toBeNull()
		council.unmount()

		read.mockResolvedValue(status({ clientPools: 2 }))
		render(<XollamaModelStrip modelId="m" />)
		await waitFor(() => expect(screen.getByTestId("xollama-model-strip")).toBeTruthy())
		expect(screen.queryByLabelText("Book a context window")).toBeNull()
	})
})

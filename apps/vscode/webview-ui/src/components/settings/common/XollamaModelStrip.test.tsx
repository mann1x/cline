import { PolykvStatusResponse, XollamaModelStatusResponse } from "@shared/proto/cline/models"
import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ModelsServiceClient } from "@/services/grpc-client"
import { describeXollamaModel, XollamaModelStrip } from "./XollamaModelStrip"

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: { readXollamaModelStatus: vi.fn(), readPolykvStatus: vi.fn() },
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

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	formatRemaining,
	formatResetsIn,
	formatUsed,
	OllamaCloudLimitLine,
	OllamaCloudUsageHeaderToggle,
	OllamaCloudUsageStrip,
} from "./OllamaCloudUsage"

const readOllamaCloudUsage = vi.fn()

vi.mock("@/services/grpc-client", () => ({
	ModelsServiceClient: {
		readOllamaCloudUsage: (...args: unknown[]) => readOllamaCloudUsage(...args),
	},
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, href }: { children?: React.ReactNode; href?: string }) => <a href={href}>{children}</a>,
}))

const updateSetting = vi.fn()
const extensionState: { showCloudUsageInTaskHeader?: boolean } = {}

vi.mock("../utils/settingsHandlers", () => ({
	updateSetting: (...args: unknown[]) => updateSetting(...args),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => extensionState,
}))

const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000 + 30_000).toISOString()

/** The reporter's legacy plan, as the host maps it. */
function legacy(overrides: Record<string, unknown> = {}) {
	return {
		state: "ok",
		session: { remainingPercent: 99.97, resetsAt: inHours(2) },
		weekly: { remainingPercent: 68.35, resetsAt: inHours(50) },
		purchasedBalanceUsd: 31.88733,
		usage: [
			{ range: "24h", requestCount: 244 },
			{ range: "7d", requestCount: 1530 },
			{ range: "30d", requestCount: 5012 },
		],
		readAt: new Date().toISOString(),
		includedExhausted: false,
		cloudModel: true,
		...overrides,
	}
}

beforeEach(() => {
	readOllamaCloudUsage.mockReset()
	updateSetting.mockReset()
	delete extensionState.showCloudUsageInTaskHeader
})

describe("formatting", () => {
	it("never rounds what is left upwards", () => {
		expect(formatRemaining(99.97)).toBe("99.9%")
		expect(formatRemaining(68.35)).toBe("68.3%")
		expect(formatRemaining(100)).toBe("100%")
		expect(formatRemaining(0)).toBe("0%")
	})

	it("says what is used as the complement of what is left", () => {
		expect(formatUsed(23.1)).toBe("76.9%")
		expect(formatUsed(23.17)).toBe("76.9%")
		expect(formatUsed(78.3)).toBe("21.7%")
		expect(formatUsed(99.97)).toBe("0.1%")
		expect(formatUsed(100)).toBe("0%")
		expect(formatUsed(0)).toBe("100%")
	})

	it("says how long until a reset", () => {
		const now = Date.parse("2026-10-23T22:08:00Z")
		expect(formatResetsIn("2026-10-24T00:00:00Z", now)).toBe("in 1h 52m")
		expect(formatResetsIn("2026-10-26T00:00:00Z", now)).toBe("in 2d 1h")
		expect(formatResetsIn("2026-10-23T22:20:00Z", now)).toBe("in 12m")
		expect(formatResetsIn("2026-10-23T22:00:00Z", now)).toBe("now")
		expect(formatResetsIn(undefined, now)).toBeUndefined()
	})
})

describe("OllamaCloudUsageStrip", () => {
	it("shows a legacy plan's limits, credit and requests", async () => {
		readOllamaCloudUsage.mockResolvedValue(legacy())
		render(<OllamaCloudUsageStrip providerId="ollama" />)
		expect(await screen.findByText("0.1% used · resets in 2h")).toBeTruthy()
		expect(screen.getByText("31.7% used · resets in 2d 2h")).toBeTruthy()
		expect(screen.getByRole("progressbar", { name: "Weekly: 31.7% used" })).toBeTruthy()
		expect(screen.getByText("Purchased credit: $31.89")).toBeTruthy()
		expect(screen.getByText("Requests: 244 in 24h · 1,530 in 7d · 5,012 in 30d")).toBeTruthy()
		expect(readOllamaCloudUsage.mock.calls[0]?.[0]).toMatchObject({ providerId: "ollama" })
	})

	it("shows a current plan's included balance and the cost it reports", async () => {
		readOllamaCloudUsage.mockResolvedValue(
			legacy({
				session: undefined,
				weekly: undefined,
				includedBalanceUsd: 72.5,
				includedAllowanceUsd: 100,
				periodUntil: inHours(24 * 21),
				purchasedBalanceUsd: 25,
				usage: [{ range: "24h", requestCount: 15, usageUsd: 0.01718 }],
			}),
		)
		render(<OllamaCloudUsageStrip providerId="xollama" />)
		expect(await screen.findByText(/Included: \$72\.50 of \$100\.00 left · resets in 21d/)).toBeTruthy()
		expect(screen.getByText("Requests: 15 in 24h ($0.02)")).toBeTruthy()
	})

	it("says why there is nothing to show", async () => {
		readOllamaCloudUsage.mockResolvedValue({ state: "unsupported", usage: [], includedExhausted: false })
		render(<OllamaCloudUsageStrip providerId="ollama" />)
		expect(await screen.findByText(/needs Ollama 0\.40\.6 or later/)).toBeTruthy()
	})

	it("links to sign in when the server is signed out", async () => {
		readOllamaCloudUsage.mockResolvedValue({
			state: "signed-out",
			signinUrl: "https://ollama.com/connect?x",
			usage: [],
			includedExhausted: false,
		})
		render(<OllamaCloudUsageStrip providerId="xollama" />)
		expect((await screen.findByText("sign in")).getAttribute("href")).toBe("https://ollama.com/connect?x")
	})

	it("renders nothing for a server that cannot be reached", async () => {
		readOllamaCloudUsage.mockResolvedValue({ state: "unreachable", usage: [], includedExhausted: false })
		const { container } = render(<OllamaCloudUsageStrip providerId="ollama" />)
		await waitFor(() => expect(readOllamaCloudUsage).toHaveBeenCalled())
		expect(container.textContent).toBe("")
	})
})

describe("OllamaCloudLimitLine", () => {
	it("shows what is used for a cloud model, as a bar each, the way ollama.com does", async () => {
		readOllamaCloudUsage.mockResolvedValue(legacy())
		render(<OllamaCloudLimitLine modelId="glm-5.3-flash:cloud" providerId="ollama" />)
		const session = await screen.findByRole("progressbar", { name: "Cloud session: 0.1% used" })
		expect(Number.parseFloat((session.firstChild as HTMLElement).style.width)).toBeCloseTo(0.03, 5)
		expect(screen.getByRole("progressbar", { name: "Cloud weekly: 31.7% used" })).toBeTruthy()
		expect(screen.getByText("31.7% used")).toBeTruthy()
		expect(readOllamaCloudUsage.mock.calls[0]?.[0]).toMatchObject({
			providerId: "ollama",
			modelId: "glm-5.3-flash:cloud",
		})
	})

	it("says the limit is reached, when it resets, and the credit left", async () => {
		readOllamaCloudUsage.mockResolvedValue(
			legacy({
				session: { remainingPercent: 0, resetsAt: inHours(1) },
				includedExhausted: true,
			}),
		)
		render(<OllamaCloudLimitLine modelId="kimi-k2.6:cloud" providerId="xollama" />)
		const line = await screen.findByText("Cloud session limit reached · resets in 1h · $31.89 credit")
		expect(line.className).toContain("text-error")
	})

	it("warns when a limit runs low", async () => {
		readOllamaCloudUsage.mockResolvedValue(legacy({ weekly: { remainingPercent: 4.2, resetsAt: inHours(30) } }))
		render(<OllamaCloudLimitLine modelId="kimi-k2.6:cloud" providerId="ollama" />)
		expect((await screen.findByText("95.8% used")).className).toContain("editorWarning")
	})

	it("stays silent for a local model", async () => {
		readOllamaCloudUsage.mockResolvedValue(legacy({ cloudModel: false }))
		const { container } = render(<OllamaCloudLimitLine modelId="qwen3.5:9b" providerId="ollama" />)
		await waitFor(() => expect(readOllamaCloudUsage).toHaveBeenCalled())
		expect(container.textContent).toBe("")
	})

	it("asks nothing for another provider", () => {
		const { container } = render(<OllamaCloudLimitLine modelId="claude" providerId="anthropic" />)
		expect(readOllamaCloudUsage).not.toHaveBeenCalled()
		expect(container.textContent).toBe("")
	})
})

describe("OllamaCloudUsageHeaderToggle", () => {
	it("is on until it is turned off, and turning it off writes the setting", () => {
		render(<OllamaCloudUsageHeaderToggle />)
		const toggle = screen.getByRole("switch", { name: "Show cloud usage in the task header" })
		expect(toggle.getAttribute("aria-checked")).toBe("true")
		fireEvent.click(toggle)
		expect(updateSetting).toHaveBeenCalledWith("showCloudUsageInTaskHeader", false)
	})

	it("shows a stored off as off", () => {
		extensionState.showCloudUsageInTaskHeader = false
		render(<OllamaCloudUsageHeaderToggle />)
		expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false")
	})
})

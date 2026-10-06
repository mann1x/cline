import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ScrapeSettings from "../ScrapeSettings"

let scrape: Record<string, unknown>
const actions: Array<Record<string, unknown>> = []
vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: {
		retrievalAction: async (request: { value: string }) => {
			const action = JSON.parse(request.value)
			actions.push(action)
			if (action.action === "setScrape") {
				const { action: _action, apiKey, ...rest } = action
				scrape = { ...scrape, ...rest, ...(apiKey !== undefined ? { keySet: apiKey !== "" } : {}) }
			}
			return {
				value: JSON.stringify({
					ok: true,
					...(action.action === "checkScrape"
						? { check: { ok: true, detail: "Read https://example.com/ (“Example Domain”): 16 characters." } }
						: {}),
					status: { lancedb: {}, embedJobs: {}, scrape },
				}),
			}
		},
	},
}))

const sent = () => actions.filter((action) => action.action !== "status")

describe("the scraper's settings", () => {
	beforeEach(() => {
		scrape = { enabled: false, allowed: false, baseUrl: "", maxPages: 100, maxDepth: 3, keySet: false }
		actions.length = 0
	})

	it("shows only the switch while it is off, and says what else it takes", async () => {
		render(<ScrapeSettings />)
		expect(await screen.findByText("Web scraping for the librarian")).toBeTruthy()
		expect(screen.getByText(/“Allow web scraping” is ticked in the API configuration/)).toBeTruthy()
		expect(screen.queryByText("Firecrawl endpoint")).toBeNull()
		fireEvent.click(screen.getByText("Web scraping for the librarian"))
		await waitFor(() => expect(sent()).toEqual([{ action: "setScrape", enabled: true }]))
		expect(await screen.findByText("Firecrawl endpoint")).toBeTruthy()
	})

	it("says a key is stored without showing it, and what still stops scraping", async () => {
		scrape = {
			enabled: true,
			allowed: false,
			baseUrl: "http://192.168.178.2:3002",
			maxPages: 50,
			maxDepth: 2,
			keySet: true,
			problem: "Not allowed yet: tick “Allow web scraping” in the API configuration.",
		}
		render(<ScrapeSettings />)
		expect(await screen.findByPlaceholderText("Stored — type to replace, clear to remove")).toBeTruthy()
		expect(screen.getByText(/Not allowed yet/)).toBeTruthy()
		expect(screen.getByDisplayValue("50")).toBeTruthy()
	})

	it("checks the endpoint and shows what came back", async () => {
		scrape = { enabled: true, allowed: true, baseUrl: "http://192.168.178.2:3002", maxPages: 100, maxDepth: 3, keySet: false }
		render(<ScrapeSettings />)
		fireEvent.click(await screen.findByText("Check"))
		expect(await screen.findByText(/Read https:\/\/example\.com\//)).toBeTruthy()
		expect(sent()).toEqual([{ action: "checkScrape" }])
	})
})

import { JEV_DEFAULT_FLOOR, JEV_DEFAULT_HIGH_STAKES_FLOOR, JEV_DEFAULT_MODEL, JEV_DEFAULT_TIMEOUT_MS } from "@cline/core"
import { beforeEach, describe, expect, it, vi } from "vitest"

const stored = {
	enabled: undefined as boolean | undefined,
	settings: "" as string,
	apiKey: undefined as string | undefined,
}

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: () => ({
			getGlobalSettingsKey: (key: string) =>
				key === "jevEnabled" ? stored.enabled : key === "jevSettings" ? stored.settings : undefined,
			getSecretKey: (key: string) => (key === "jevApiKey" ? stored.apiKey : undefined),
		}),
	},
}))

vi.mock("@/shared/services/Logger", () => ({
	Logger: { log: () => {}, warn: () => {}, error: () => {} },
}))

import { buildJevPromptSection, DEFAULT_JEV_SETTINGS, isJevConfigured, parseJevSettings, readJevEndpoint } from "./jev-config"
import { conversationForJev, rankQuestionWithJev } from "./jev-question-ranking"

beforeEach(() => {
	stored.enabled = undefined
	stored.settings = ""
	stored.apiKey = undefined
})

describe("the Jev defaults", () => {
	// The webview cannot import core, so the shared module restates these.
	it("match core's", () => {
		expect(DEFAULT_JEV_SETTINGS).toMatchObject({
			model: JEV_DEFAULT_MODEL,
			floor: JEV_DEFAULT_FLOOR,
			highStakesFloor: JEV_DEFAULT_HIGH_STAKES_FLOOR,
			timeoutMs: JEV_DEFAULT_TIMEOUT_MS,
		})
	})
})

describe("parseJevSettings", () => {
	it("keeps what is valid and defaults the rest", () => {
		const settings = parseJevSettings(
			JSON.stringify({ model: " jev-1.13.0 ", floor: 0.7, highStakesFloor: 3, rankQuestions: false }),
		)
		expect(settings.model).toBe("jev-1.13.0")
		expect(settings.floor).toBe(0.7)
		expect(settings.highStakesFloor).toBe(DEFAULT_JEV_SETTINGS.highStakesFloor)
		expect(settings.rankQuestions).toBe(false)
		expect(settings.appraiseEscalation).toBe(true)
	})

	it("reads unparseable storage as the defaults", () => {
		expect(parseJevSettings("{nope")).toEqual(DEFAULT_JEV_SETTINGS)
	})
})

describe("readJevEndpoint", () => {
	// Both, not either: a key left stored after the box is unticked must not
	// keep conversation text going to a hosted service.
	it("needs the box ticked and a key", () => {
		stored.apiKey = "sk"
		expect(readJevEndpoint()).toBeUndefined()

		stored.enabled = true
		stored.apiKey = "  "
		expect(isJevConfigured()).toBe(false)

		stored.apiKey = " sk "
		expect(readJevEndpoint()).toMatchObject({ apiKey: "sk", model: "jev-latest", floor: 0.6 })
	})
})

describe("buildJevPromptSection", () => {
	it("states the floor and each case the tool is for", () => {
		const text = buildJevPromptSection({ floor: 0.7, rankQuestions: true })
		expect(text).toContain("floor is 0.70")
		expect(text).toContain("understood the user's request")
		expect(text).toContain("fact")
		expect(text).toContain("escalation")
		expect(text).toContain("the harness scores the options")
	})

	it("tells the model to rank its own options when the harness does not", () => {
		expect(buildJevPromptSection({ floor: 0.6, rankQuestions: false })).toContain(
			"call `jev` with the context and the options",
		)
	})
})

describe("conversationForJev", () => {
	it("keeps every user line and only the last few replies", () => {
		const text = conversationForJev([
			{ ts: 1, type: "say", say: "task", text: "Fix the build" },
			{ ts: 2, type: "say", say: "text", text: "reply 1" },
			{ ts: 3, type: "say", say: "tool", text: '{"tool":"readFile"}' },
			{ ts: 4, type: "say", say: "text", text: "reply 2" },
			{ ts: 5, type: "say", say: "user_feedback", text: "use the old API" },
			{ ts: 6, type: "say", say: "text", text: "reply 3" },
			{ ts: 7, type: "say", say: "text", text: "reply 4" },
		])
		expect(text).toContain("user: Fix the build")
		expect(text).toContain("user: use the old API")
		expect(text).not.toContain("reply 1")
		expect(text).toContain("assistant: reply 4")
		expect(text).not.toContain("readFile")
	})
})

describe("rankQuestionWithJev", () => {
	it("leaves the question alone when Jev is not configured", async () => {
		const ranked = await rankQuestionWithJev("Which?", ["A", "B"], [], undefined)
		expect(ranked).toEqual({ question: "Which?", options: ["A", "B"] })
	})

	it("leaves the question alone when ranking is switched off", async () => {
		stored.settings = JSON.stringify({ rankQuestions: false })
		const ranked = await rankQuestionWithJev("Which?", ["A", "B"], [], { apiKey: "sk" })
		expect(ranked.options).toEqual(["A", "B"])
	})

	it("sends the question out unscored when Jev fails", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
		try {
			const ranked = await rankQuestionWithJev("Which?", ["A (recommended)", "B"], [], { apiKey: "sk" })
			expect(ranked).toEqual({ question: "Which?", options: ["A (recommended)", "B"] })
		} finally {
			fetchSpy.mockRestore()
		}
	})

	it("marks, scores and drops from Jev's answer", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					model: "jev-1.13.0",
					answers: {
						preferred: {
							type: "choice",
							choice: "B",
							probabilities: { A: 0.12, B: 0.86, C: 0.02 },
							confidence: 0.78,
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		)
		try {
			const ranked = await rankQuestionWithJev("Which?", ["A", "B", "C"], [], { apiKey: "sk" })
			expect(ranked.options).toEqual(["A", "B (recommended)"])
			expect(ranked.question).toContain("- B: 86%")
			expect(ranked.question).toContain("“C”")
		} finally {
			fetchSpy.mockRestore()
		}
	})
})

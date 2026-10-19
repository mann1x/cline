import { buildNoticesField } from "@cline/llms"
import { describe, expect, it } from "vitest"
import { noticeTemplateLines } from "./notice-templates"

describe("notice wording", () => {
	it("keeps a blank line as a step left to the engine", () => {
		expect(noticeTemplateLines("  first \r\n\nthird")).toEqual(["first", "", "third"])
		expect(noticeTemplateLines(undefined)).toEqual([""])
	})

	it("puts line i on step i of a v3 request", () => {
		const thinkTemplates = noticeTemplateLines("Settle now.\n\nAnswer now: {words} words left.")
		expect(buildNoticesField({ enabled: true, answerSteps: [], thinkTemplates }, "k", { v3: true })).toEqual({
			version: 3,
			key: "k",
			think: [
				{ at_percent: 60, template: "Settle now." },
				{ at_percent: 70 },
				{ at_percent: 80, template: "Answer now: {words} words left." },
				{ at_percent: 90 },
			],
		})
	})
})

import { describe, expect, it } from "vitest"
import { getDelegateAgentQuery, getMatchingDelegateAgents, insertDelegateAgent } from "./slash-commands"

const at = (text: string) => getDelegateAgentQuery(text, text.length)

describe("the agent name /delegate takes", () => {
	it("is what follows either command, up to the cursor", () => {
		expect(at("/delegate ")).toBe("")
		expect(at("/delegate q")).toBe("q")
		expect(at("/delegate-background do")).toBe("do")
		expect(getDelegateAgentQuery("/delegate qa", 11)).toBe("q")
	})

	it("is not looked for anywhere else", () => {
		for (const text of ["/delegate", "/delegate qa ", "/delegate qa run", "hi /delegate q", "/delegate @f", "/delegated q"]) {
			expect(at(text)).toBeUndefined()
		}
	})

	it("matches from the start of the name, ignoring case", () => {
		const agents = [
			{ name: "QA", description: "" },
			{ name: "docs-qa", description: "" },
		]
		expect(getMatchingDelegateAgents("q", agents).map((agent) => agent.name)).toEqual(["QA"])
		expect(getMatchingDelegateAgents("", agents)).toHaveLength(2)
	})

	it("replaces the whole name under the cursor and keeps the task", () => {
		expect(insertDelegateAgent("/delegate q", "qa", 11)).toEqual({ newValue: "/delegate qa ", newCursorPosition: 13 })
		expect(insertDelegateAgent("/delegate qx run it", "qa", 11)).toEqual({
			newValue: "/delegate qa run it",
			newCursorPosition: 13,
		})
	})
})

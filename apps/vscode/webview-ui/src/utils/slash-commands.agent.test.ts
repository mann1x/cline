import { describe, expect, it } from "vitest"
import {
	agentCommandEmptyText,
	getAgentCommandSlot,
	getMatchingAgentCommandItems,
	insertAgentCommandItem,
	type SlashCommand,
} from "./slash-commands"

const at = (text: string) => getAgentCommandSlot(text, text.length)

const agents = [
	{ name: "reviewer", description: "Reviews code", skills: ["review-website", "lint"] },
	{ name: "qa", description: "Runs QA" },
]
const skills: SlashCommand[] = [
	{ name: "deploy", description: "Deploys the stack", section: "skill" },
	{ name: "lint", description: "Lints", section: "skill" },
	{ name: "review-website", description: "Reviews a website", section: "skill" },
]
const names = (items: SlashCommand[]) => items.map((item) => `${item.section}:${item.name}`)

describe("the arguments /agent takes", () => {
	it("is the first word, then the second, then nothing", () => {
		expect(at("/agent ")).toEqual({ position: "first", query: "" })
		expect(at("/agent rev")).toEqual({ position: "first", query: "rev" })
		expect(at("/agent reviewer /rev")).toEqual({ position: "second", agentName: "reviewer", query: "/rev" })
		expect(at("/agent reviewer inspect the")).toBeUndefined()
		expect(at("/agent")).toBeUndefined()
		expect(at("please /agent rev")).toBeUndefined()
	})

	it("offers agents, then skills, for the first word", () => {
		expect(names(getMatchingAgentCommandItems({ position: "first", query: "" }, agents, skills))).toEqual([
			"agent:reviewer",
			"agent:qa",
			"skill:deploy",
			"skill:lint",
			"skill:review-website",
		])
		expect(names(getMatchingAgentCommandItems({ position: "first", query: "rev" }, agents, skills))).toEqual([
			"agent:reviewer",
			"skill:review-website",
		])
		// A slash means a skill.
		expect(names(getMatchingAgentCommandItems({ position: "first", query: "/rev" }, agents, skills))).toEqual([
			"skill:review-website",
		])
	})

	// Free text closes the menu, so Enter sends it.
	it("offers nothing for a word no agent or skill name has", () => {
		expect(getMatchingAgentCommandItems({ position: "first", query: "launch" }, agents, skills)).toEqual([])
	})

	it("offers the second word only the skills that agent may load", () => {
		expect(
			names(getMatchingAgentCommandItems({ position: "second", agentName: "Reviewer", query: "" }, agents, skills)),
		).toEqual(["skill:lint", "skill:review-website"])
		// No skills list: every skill.
		expect(names(getMatchingAgentCommandItems({ position: "second", agentName: "qa", query: "de" }, agents, skills))).toEqual(
			["skill:deploy"],
		)
		// After a first word that is no agent, there is no second argument.
		expect(getMatchingAgentCommandItems({ position: "second", agentName: "launch", query: "" }, agents, skills)).toEqual([])
	})

	it("puts an agent in by name and a skill with its slash, leaving the cursor after it", () => {
		expect(insertAgentCommandItem("/agent rev", { name: "reviewer", section: "agent" }, 10)).toEqual({
			newValue: "/agent reviewer ",
			newCursorPosition: 16,
		})
		const text = "/agent reviewer rev check the header"
		expect(insertAgentCommandItem(text, { name: "review-website", section: "skill" }, 19)).toEqual({
			newValue: "/agent reviewer /review-website check the header",
			newCursorPosition: 32,
		})
	})
})

describe("an empty /agent skill menu says why", () => {
	const slot = (text: string) => getAgentCommandSlot(text, text.length)
	it("names the skills the agent may load, an unknown agent, or no match", () => {
		expect(agentCommandEmptyText(slot("/agent reviewer /media"), agents, [])).toBe(
			"reviewer loads only /review-website, /lint",
		)
		expect(agentCommandEmptyText(slot("/agent ghost /media"), agents, [])).toBe("No agent “ghost”")
		expect(agentCommandEmptyText(slot("/agent qa /media"), agents, [])).toBe("No skill matches “/media”")
		// Free text after the agent, or a match: nothing to say.
		expect(agentCommandEmptyText(slot("/agent qa media"), agents, [])).toBeUndefined()
		expect(agentCommandEmptyText(slot("/agent qa /li"), agents, skills.slice(1, 2))).toBeUndefined()
	})
})

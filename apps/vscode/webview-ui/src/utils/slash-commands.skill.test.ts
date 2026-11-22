import { describe, expect, it } from "vitest"
import {
	getMatchingSkills,
	getMatchingSlashCommands,
	getSkillCommands,
	getSkillQuery,
	insertSkillCommand,
	validateSlashCommand,
} from "./slash-commands"

const skills = getSkillCommands([
	{ name: "docker-compose-deploy", description: "Deploy a stack with docker compose", enabled: true },
	{ name: "QA Smoke Tests", description: "Run the smoke suite against a build", enabled: true },
	{ name: "tdd-coverage", description: "Measure test coverage", enabled: false },
	{ name: "docker-compose-deploy", description: "A second copy in another scope", enabled: true },
])

describe("skills as slash commands", () => {
	it("lists the enabled skills once each, by the name the runtime knows", () => {
		expect(skills).toEqual([
			{ name: "docker-compose-deploy", description: "Deploy a stack with docker compose", section: "skill" },
			{ name: "qa-smoke-tests", description: "Run the smoke suite against a build", section: "skill" },
		])
	})

	it("offers them in the / menu, matching anywhere in the name", () => {
		const names = (query: string) =>
			getMatchingSlashCommands(query, {}, {}, undefined, undefined, [], skills)
				.filter((command) => command.section === "skill")
				.map((command) => command.name)
		expect(names("")).toEqual(["docker-compose-deploy", "qa-smoke-tests"])
		expect(names("deploy")).toEqual(["docker-compose-deploy"])
		expect(names("SMOKE")).toEqual(["qa-smoke-tests"])
	})

	it("puts them after the other commands, the order the menu draws them in", () => {
		const all = getMatchingSlashCommands("", {}, {}, undefined, undefined, [], skills)
		expect(all.slice(-2).map((command) => command.section)).toEqual(["skill", "skill"])
		expect(all.some((command) => command.name === "skill" && command.section === "default")).toBe(true)
	})

	it("highlights a typed skill as a command", () => {
		const names = skills.map((skill) => skill.name)
		expect(validateSlashCommand("qa-smoke-tests", {}, {}, undefined, undefined, [], names)).toBe("full")
		expect(validateSlashCommand("qa-sm", {}, {}, undefined, undefined, [], names)).toBe("partial")
		expect(validateSlashCommand("tdd-coverage", {}, {}, undefined, undefined, [], names)).toBeNull()
	})
})

describe("/skill <filter>", () => {
	it("reads the words after /skill at the start of the message", () => {
		expect(getSkillQuery("/skill ", 7)).toBe("")
		expect(getSkillQuery("/skill docker deploy", 20)).toBe("docker deploy")
		expect(getSkillQuery("/skill", 6)).toBeUndefined()
		expect(getSkillQuery("please /skill docker", 20)).toBeUndefined()
		expect(getSkillQuery("/skill docker\nmore", 18)).toBeUndefined()
	})

	it("keeps the skills with every word in their name or description", () => {
		expect(getMatchingSkills("", skills).map((skill) => skill.name)).toEqual(["docker-compose-deploy", "qa-smoke-tests"])
		expect(getMatchingSkills("suite build", skills).map((skill) => skill.name)).toEqual(["qa-smoke-tests"])
		expect(getMatchingSkills("compose smoke", skills)).toEqual([])
	})

	it("replaces /skill and its filter with the skill's command", () => {
		expect(insertSkillCommand("/skill dock", "docker-compose-deploy", 11)).toEqual({
			newValue: "/docker-compose-deploy ",
			newCursorPosition: 23,
		})
		// Whatever was already typed after the cursor stays, as the request.
		expect(insertSkillCommand("/skill qa   check build 42", "qa-smoke-tests", 9).newValue).toBe(
			"/qa-smoke-tests check build 42",
		)
	})
})

import { describe, it } from "bun:test"
import { parseYamlFrontmatter } from "@core/context/instructions/user-instructions/frontmatter"
import { AgentInfo } from "@shared/proto/cline/file"
import { expect } from "chai"

import { agentFileName, renderAgentFile } from "../agent-files"

function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
	return AgentInfo.create({
		name: "reviewer",
		description: "Reviews a change and reports what is wrong with it.",
		path: "",
		isGlobal: true,
		tools: [],
		skills: [],
		providerId: "",
		modelId: "",
		profile: "",
		maxIterations: 0,
		systemPrompt: "You review code.",
		...overrides,
	})
}

describe("agentFileName", () => {
	it("keeps a plain name as it is", () => {
		expect(agentFileName("reviewer")).to.equal("reviewer.md")
	})

	// The name is free text a user typed, and it becomes a path segment.
	it("cannot escape the agents directory", () => {
		expect(agentFileName("../../etc/passwd")).to.equal("etc-passwd.md")
		expect(agentFileName("a/b")).to.equal("a-b.md")
	})

	it("falls back rather than producing a dotfile", () => {
		expect(agentFileName("///")).to.equal("agent.md")
	})
})

/**
 * The form and the loader have to agree, so the test is a round trip rather
 * than an assertion about the text: what the form writes is read back as YAML
 * and has to come out as the values that went in. The frontmatter is
 * hand-rolled rather than produced by a YAML library, which is exactly why it
 * is worth reading back.
 */
describe("renderAgentFile", () => {
	it("round-trips every field it writes", () => {
		const { data, body } = parseYamlFrontmatter(
			renderAgentFile(
				agent({
					profile: "fast-reviewer",
					tools: ["read_files", "search_codebase"],
					skills: ["review-pr"],
					maxIterations: 12,
				}),
			),
		)

		expect(data).to.deep.equal({
			name: "reviewer",
			description: "Reviews a change and reports what is wrong with it.",
			profile: "fast-reviewer",
			tools: ["read_files", "search_codebase"],
			skills: ["review-pr"],
			maxIterations: 12,
		})
		expect(body.trim()).to.equal("You review code.")
	})

	// A colon is what a user writes in an ordinary sentence, and unquoted it
	// turns the line into a mapping the schema then rejects.
	it("survives a description that reads as YAML", () => {
		const { data } = parseYamlFrontmatter(
			renderAgentFile(agent({ description: 'Reviews code: carefully, and says "no" when it should.' })),
		)

		expect(data.description).to.equal('Reviews code: carefully, and says "no" when it should.')
	})

	// The loader reads `yes` as a boolean and `1.0` as a number unless the
	// scalar is quoted, and either one fails the schema's string check.
	it("keeps a name that YAML would otherwise retype", () => {
		const { data } = parseYamlFrontmatter(renderAgentFile(agent({ name: "yes" })))

		expect(data.name).to.equal("yes")
	})

	// Absence is what the loader reads as "every tool the session has". An
	// empty list written to the file would be an agent that can do nothing.
	it("omits the keys that were left unset rather than writing empty ones", () => {
		const rendered = renderAgentFile(agent())
		const { data } = parseYamlFrontmatter(rendered)

		expect(rendered).to.not.contain("tools:")
		expect(rendered).to.not.contain("skills:")
		expect(rendered).to.not.contain("profile:")
		expect(rendered).to.not.contain("maxIterations:")
		expect(data).to.deep.equal({
			name: "reviewer",
			description: "Reviews a change and reports what is wrong with it.",
		})
	})
})

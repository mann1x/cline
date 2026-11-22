// By package name: the extension's typecheck admits nothing outside
// apps/vscode, and vitest maps @cline/core to the source-backed stub.
import { normalizeRuntimeCommandName } from "@cline/core"
import { describe, expect, it } from "vitest"
import { skillCommandName, VSCODE_ONLY_COMMANDS } from "./slashCommands"

describe("skillCommandName", () => {
	// The `/` menu and the `/skill` picker insert this name; the runtime knows
	// the skill by the core's. A drift would hand the model a command that
	// names no skill.
	it("spells a skill the way the runtime does", () => {
		for (const name of [
			"docker-compose-deploy",
			"Ship It",
			"  QA: smoke tests  ",
			"tdd/coverage+report",
			"发布 流程",
			"--weird__name--",
			"a.b@c:d",
		]) {
			expect(skillCommandName(name)).toBe(normalizeRuntimeCommandName(name))
		}
	})
})

describe("VSCODE_ONLY_COMMANDS", () => {
	it("offers /skill", () => {
		expect(VSCODE_ONLY_COMMANDS.map((command) => command.name)).toContain("skill")
	})
})

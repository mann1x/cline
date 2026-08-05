import { getBuiltinPromptTemplates, HOST_TOOL_INPUT_SCHEMAS, summarizeToolCallSignatures } from "@cline/core"
import { describe, expect, it } from "vitest"
import { CHECK_FILE_TOOL_DESCRIPTION, CHECK_FILE_TOOL_INPUT_SCHEMA, CHECK_FILE_TOOL_NAME } from "./check-file-tool"
import { SWITCH_TO_ACT_MODE_TOOL_DESCRIPTION, SWITCH_TO_ACT_MODE_TOOL_NAME } from "./sdk-session-config-builder"

/**
 * Keep `default.md` honest about the tools this host contributes.
 *
 * The core package has the same guard for its own tools, by constructing each
 * one and comparing. It cannot do that for these: they are built here, and
 * core does not know they exist. So the check lives on this side of the
 * boundary, where both the constants and the shipped template are reachable.
 *
 * Without it, `default.md` would still parse, still resolve and still be
 * applied — it would just be quietly describing a tool that no longer works
 * that way, which is the failure mode the file exists to prevent.
 */
describe("host tool descriptions in default.md", () => {
	const shipped = getBuiltinPromptTemplates().find((template) => template.name === "default")

	it("reproduces check_file verbatim", () => {
		expect(shipped?.tools[CHECK_FILE_TOOL_NAME]).toBe(CHECK_FILE_TOOL_DESCRIPTION.trim())
	})

	it("reproduces switch_to_act_mode verbatim", () => {
		expect(shipped?.tools[SWITCH_TO_ACT_MODE_TOOL_NAME]).toBe(SWITCH_TO_ACT_MODE_TOOL_DESCRIPTION.trim())
	})
})

/**
 * The core package restates these schemas because it cannot build the
 * tools, and the review script — which runs there — needs their call shapes to
 * audit a generated template. A copy is only safe while something fails when
 * it stops matching. This is that something.
 *
 */
describe("host tool schemas restated in core", () => {
	const restated = new Map(HOST_TOOL_INPUT_SCHEMAS.map((entry) => [entry.name, entry.inputSchema]))

	function signatureOf(name: string, schema: unknown) {
		return summarizeToolCallSignatures([{ name, inputSchema: schema }])[0]
	}

	it("matches check_file", () => {
		expect(signatureOf(CHECK_FILE_TOOL_NAME, restated.get(CHECK_FILE_TOOL_NAME))).toEqual(
			signatureOf(CHECK_FILE_TOOL_NAME, CHECK_FILE_TOOL_INPUT_SCHEMA),
		)
	})
})

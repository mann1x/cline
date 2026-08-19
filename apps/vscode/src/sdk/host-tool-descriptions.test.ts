import {
	BROWSER_ACTIONS,
	BROWSER_TOOL_DESCRIPTION,
	BROWSER_TOOL_INPUT_SCHEMA,
	BROWSER_TOOL_NAME,
	CODE_INTEL_OPERATIONS,
	CODE_INTEL_TOOL_DESCRIPTION,
	CODE_INTEL_TOOL_INPUT_SCHEMA,
	CODE_INTEL_TOOL_NAME,
	getBuiltinPromptTemplates,
	HOST_TOOL_INPUT_SCHEMAS,
	LIST_FILES_TOOL_INPUT_SCHEMA,
	LIST_FILES_TOOL_NAME,
	summarizeToolCallSignatures,
} from "@cline/core"
import { describe, expect, it } from "vitest"
import { CHECK_FILE_TOOL_DESCRIPTION, CHECK_FILE_TOOL_INPUT_SCHEMA, CHECK_FILE_TOOL_NAME } from "./check-file-tool"

import { SWITCH_TO_ACT_MODE_TOOL_DESCRIPTION, SWITCH_TO_ACT_MODE_TOOL_NAME } from "./sdk-session-config-builder"

/**
 * Keep `default.md` honest about the tools this host contributes.
 *
 * The core package has the same guard for its own tools, by constructing each
 * one and comparing. It cannot do that for these two: they are built here, and
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

	it("reproduces code_intel verbatim", () => {
		expect(shipped?.tools[CODE_INTEL_TOOL_NAME]).toBe(CODE_INTEL_TOOL_DESCRIPTION.trim())
	})

	it("reproduces switch_to_act_mode verbatim", () => {
		expect(shipped?.tools[SWITCH_TO_ACT_MODE_TOOL_NAME]).toBe(SWITCH_TO_ACT_MODE_TOOL_DESCRIPTION.trim())
	})

	it("reproduces browser verbatim", () => {
		expect(shipped?.tools[BROWSER_TOOL_NAME]).toBe(BROWSER_TOOL_DESCRIPTION.trim())
	})
})

/**
 * The core package restates these three schemas because it cannot build the
 * tools, and the review script — which runs there — needs their call shapes to
 * audit a generated template. A copy is only safe while something fails when
 * it stops matching. This is that something.
 *
 * `code_intel` is the one that matters: it is the only tool with a closed set
 * of operations, and an operation added here but not there would silently stop
 * being required of every rewrite.
 */
describe("host tool schemas restated in core", () => {
	const restated = new Map(HOST_TOOL_INPUT_SCHEMAS.map((entry) => [entry.name, entry.inputSchema]))

	function signatureOf(name: string, schema: unknown) {
		return summarizeToolCallSignatures([{ name, inputSchema: schema }])[0]
	}

	it("matches browser, actions included", () => {
		const mirrored = signatureOf(BROWSER_TOOL_NAME, restated.get(BROWSER_TOOL_NAME))
		expect(mirrored).toEqual(signatureOf(BROWSER_TOOL_NAME, BROWSER_TOOL_INPUT_SCHEMA))
		expect(mirrored?.enumValues).toEqual([...BROWSER_ACTIONS])
	})

	it("matches list_files", () => {
		expect(signatureOf(LIST_FILES_TOOL_NAME, restated.get(LIST_FILES_TOOL_NAME))).toEqual(
			signatureOf(LIST_FILES_TOOL_NAME, LIST_FILES_TOOL_INPUT_SCHEMA),
		)
	})

	it("matches check_file", () => {
		expect(signatureOf(CHECK_FILE_TOOL_NAME, restated.get(CHECK_FILE_TOOL_NAME))).toEqual(
			signatureOf(CHECK_FILE_TOOL_NAME, CHECK_FILE_TOOL_INPUT_SCHEMA),
		)
	})

	it("matches code_intel, operations included", () => {
		const mirrored = signatureOf(CODE_INTEL_TOOL_NAME, restated.get(CODE_INTEL_TOOL_NAME))
		const real = signatureOf(CODE_INTEL_TOOL_NAME, CODE_INTEL_TOOL_INPUT_SCHEMA)
		expect(mirrored).toEqual(real)
		expect(mirrored?.enumValues).toEqual([...CODE_INTEL_OPERATIONS])
	})
})

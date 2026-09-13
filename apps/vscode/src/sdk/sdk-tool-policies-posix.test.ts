import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import { describe, expect, it } from "vitest"
import { buildToolPolicies, isEditTool, isToolAutoApproved } from "./sdk-tool-policies"

/**
 * `grep`, `sed` and `awk` were in none of the auto-approval domains.
 *
 * The SDK auto-approves any tool no policy names, so all three ran with no
 * approval gate at all — `sed` with `in_place: true` writes files, and did so
 * without ever reaching `requestToolApproval`, whatever the AutoApproveBar said.
 *
 * The split between the two toggles is by what a tool can do to a file, not by
 * what POSIX allows: `awk` can redirect and can call `system()` in POSIX, but
 * this implementation refuses both, so it reads and nothing more.
 */
const settings = (readFiles: boolean, editFiles: boolean): AutoApprovalSettings =>
	({
		actions: { readFiles, editFiles },
	}) as unknown as AutoApprovalSettings

describe("the POSIX tools are governed by the approval toggles", () => {
	it("forces the approval callback for all three", () => {
		const policies = buildToolPolicies(settings(true, true))
		// Without an entry the SDK never asks, which is the whole bug.
		expect(policies.grep).toEqual({ autoApprove: false })
		expect(policies.sed).toEqual({ autoApprove: false })
		expect(policies.awk).toEqual({ autoApprove: false })
	})

	it("puts grep and awk under the read toggle", () => {
		for (const tool of ["grep", "awk"]) {
			expect(isToolAutoApproved(tool, settings(true, false))).toBe(true)
			expect(isToolAutoApproved(tool, settings(false, true))).toBe(false)
		}
	})

	it("puts sed under the edit toggle, because in_place writes", () => {
		expect(isToolAutoApproved("sed", settings(false, true))).toBe(true)
		expect(isToolAutoApproved("sed", settings(true, false))).toBe(false)
	})

	it("counts sed as an edit tool, so a denial says the file was not modified", () => {
		expect(isEditTool("sed")).toBe(true)
		// Neither of these can change a file, so neither should claim one was
		// left unmodified.
		expect(isEditTool("awk")).toBe(false)
		expect(isEditTool("grep")).toBe(false)
	})
})

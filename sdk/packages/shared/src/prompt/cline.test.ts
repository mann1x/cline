import { describe, expect, it } from "vitest";
import {
	buildClineSystemPrompt,
	MODE_TAG_INSTRUCTIONS,
	PLAN_MODE_INSTRUCTIONS,
	PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH,
	processWorkspaceInfo,
} from "./cline";

const BASE_OPTIONS = {
	ide: "VS Code",
	workspaceRoot: "/workspace/project",
	workspaceName: "project",
	platform: "linux",
};

describe("processWorkspaceInfo", () => {
	it("redacts URL credentials while preserving SCP-style SSH remotes", () => {
		const metadata = JSON.parse(
			processWorkspaceInfo({
				rootPath: "/workspace/project",
				associatedRemoteUrls: [
					"origin: https://user:token@github.com/cline/cline.git",
					"backup: ssh://git:secret@example.com/cline/cline.git",
					"mirror: git@github.com:cline/cline.git",
				],
			}),
		);

		expect(
			metadata.workspaces["/workspace/project"].associatedRemoteUrls,
		).toEqual([
			"origin: https://github.com/cline/cline.git",
			"backup: ssh://example.com/cline/cline.git",
			"mirror: git@github.com:cline/cline.git",
		]);
	});
});

describe("buildClineSystemPrompt mode instructions", () => {
	it("explains the user_input mode attribute in act mode", () => {
		const prompt = buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "act" });
		expect(prompt).toContain(MODE_TAG_INSTRUCTIONS);
		expect(prompt).toContain('<user_input mode="...">');
		expect(prompt).toContain("<mode_notice>");
		expect(prompt).not.toContain(PLAN_MODE_INSTRUCTIONS);
	});

	it("appends the plan-mode contract only in plan mode", () => {
		const prompt = buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "plan" });
		expect(prompt).toContain(MODE_TAG_INSTRUCTIONS);
		expect(prompt).toContain(PLAN_MODE_INSTRUCTIONS);
		// The mode-tag explanation precedes the plan contract, matching the
		// order the CLI historically composed by hand.
		expect(prompt.indexOf(MODE_TAG_INSTRUCTIONS)).toBeLessThan(
			prompt.indexOf(PLAN_MODE_INSTRUCTIONS),
		);
	});

	it("keeps run_commands available-but-read-only in the plan contract", () => {
		// Explicit product decision: run_commands is NOT removed in plan mode
		// (it is essential for read-only investigation); the mitigation for
		// plan-mode mutations is prompting, so the contract must spell out the
		// inspection-only usage.
		expect(PLAN_MODE_INSTRUCTIONS).toContain("run_commands");
		expect(PLAN_MODE_INSTRUCTIONS).toContain("read-only");
		expect(PLAN_MODE_INSTRUCTIONS).toContain("switch_to_act_mode");
	});

	it("swaps in the manual-switch plan contract when the host has no switch tool", () => {
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "plan",
			planModeSwitchTool: false,
		});
		expect(prompt).toContain(PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH);
		expect(prompt).not.toContain("switch_to_act_mode");
		// The read-only run_commands contract is shared by both variants.
		expect(PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH).toContain("run_commands");
		expect(PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH).toContain("Plan/Act toggle");
	});

	it("emits mode instructions for both mode: undefined and yolo", () => {
		// After a switch the transcript still contains messages tagged with the
		// other mode, so the explanation is unconditional.
		expect(buildClineSystemPrompt({ ...BASE_OPTIONS })).toContain(
			MODE_TAG_INSTRUCTIONS,
		);
		expect(buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "yolo" })).toContain(
			MODE_TAG_INSTRUCTIONS,
		);
	});

	it("places caller rules before the mode instructions", () => {
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "plan",
			rules: "# Custom Rules\n\nAlways speak like a pirate.",
		});
		const rulesIndex = prompt.indexOf("Always speak like a pirate.");
		expect(rulesIndex).toBeGreaterThan(-1);
		expect(rulesIndex).toBeLessThan(prompt.indexOf(MODE_TAG_INSTRUCTIONS));
	});

	it("includes rich workspace metadata for the Cline backend parser", () => {
		const metadata = JSON.stringify({
			workspaces: {
				"/workspace/project": {
					hint: "project",
					associatedRemoteUrls: ["origin: https://github.com/cline/cline.git"],
					latestGitCommitHash: "abc123",
				},
			},
		});
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			providerId: "cline",
			metadata,
		});

		expect(prompt).toContain(`# Workspace Configuration\n${metadata}`);
	});

	it("respects an explicit override prompt without injecting mode sections", () => {
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "plan",
			overridePrompt: "You are a custom agent.",
		});
		expect(prompt).toBe("You are a custom agent.");
	});
});

describe("buildClineSystemPrompt with a template base prompt", () => {
	const TEMPLATE = [
		"You are Cline, per the gemma template.",
		"Working Directory: {{CWD}}",
		"Platform: {{PLATFORM_NAME}}",
		"{{CLINE_RULES}}",
	].join("\n");

	it("substitutes a template's placeholders, unlike an override", () => {
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "act",
			basePrompt: TEMPLATE,
		});

		expect(prompt).toContain("You are Cline, per the gemma template.");
		expect(prompt).toContain("Working Directory: /workspace/project");
		expect(prompt).toContain("Platform: linux");
		expect(prompt).not.toContain("{{CWD}}");
		expect(prompt).not.toContain("{{PLATFORM_NAME}}");
	});

	it("still carries the mode instructions into a template", () => {
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "plan",
			basePrompt: TEMPLATE,
		});

		expect(prompt).toContain(MODE_TAG_INSTRUCTIONS);
		expect(prompt).toContain(PLAN_MODE_INSTRUCTIONS);
	});

	it("appends the rules slot when a template forgets it", () => {
		// Losing {{CLINE_RULES}} would silently drop the plan-mode contract, and
		// nothing else in the pipeline reports it. Appending is recoverable;
		// losing it is not.
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "plan",
			basePrompt: "A template that forgot the rules slot.",
		});

		expect(prompt).toContain("A template that forgot the rules slot.");
		expect(prompt).toContain(PLAN_MODE_INSTRUCTIONS);
	});

	it("ignores an empty or whitespace-only template", () => {
		const fromBlank = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "act",
			basePrompt: "   \n  ",
		});
		const builtin = buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "act" });

		expect(fromBlank).toBe(builtin);
	});

	it("lets a per-request override still win over a template", () => {
		// An override is a finished prompt handed over by the caller; a template
		// is a starting point. The finished one wins, unsubstituted as always.
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "act",
			basePrompt: TEMPLATE,
			overridePrompt: "Just this. {{CWD}}",
		});

		expect(prompt).toBe("Just this. {{CWD}}");
	});
});

/**
 * The POSIX tools have to be named where the model chooses a tool.
 *
 * Their tool sections reach the model as schemas, which is enough to use a tool
 * already chosen and not enough to bring one to mind. Choosing happens against
 * the system section, and that belongs to whichever family template matched —
 * across all ten shipped templates, `awk` was named in the system section of
 * none of them. On pandorum session 1789276298025_l5yr9 the model reached for
 * PowerShell to count braces and found the `awk` tool 98 messages later.
 */
describe("the POSIX tools are announced to every template", () => {
	const namesAllThree = (prompt: string) => {
		expect(prompt).toContain("grep");
		expect(prompt).toContain("sed");
		expect(prompt).toContain("awk");
	};

	it("names them with no template at all", () => {
		namesAllThree(buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "act" }));
	});

	it("names them under a template that never mentions them", () => {
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "act",
			basePrompt: "You are a coding agent.\n\n{{CLINE_RULES}}",
		});
		namesAllThree(prompt);
	});

	it("names them even when the template forgets the rules marker", () => {
		// The marker is appended rather than required, so a template that drops
		// it does not also drop this.
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "act",
			basePrompt: "You are a coding agent. No marker here.",
		});
		namesAllThree(prompt);
	});

	it("says they are available in their own right, not as substitutes", () => {
		const prompt = buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "act" });
		expect(prompt).toContain("in their own\nright rather than as substitutes");
		// And says which question each one answers, which is what makes a tool
		// get reached for rather than merely be known about.
		expect(prompt).toContain("columns, fields and totals");
	});

	it("is there in plan mode too", () => {
		namesAllThree(buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "plan" }));
	});
});

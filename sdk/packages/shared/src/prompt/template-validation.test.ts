import { describe, expect, it } from "vitest";
import type { PromptTemplate } from "./template-types";
import {
	PROMPT_TEMPLATE_SYSTEM_PLACEHOLDERS,
	validatePromptTemplate,
} from "./template-validation";

const template = (partial: Partial<PromptTemplate>): PromptTemplate => ({
	name: "t",
	source: "global",
	tools: {},
	...partial,
});

/** A system prompt with nothing wrong with it. */
const COMPLETE_SYSTEM = PROMPT_TEMPLATE_SYSTEM_PLACEHOLDERS.join("\n");

const codes = (warnings: { code: string }[]) => warnings.map((w) => w.code);

describe("validatePromptTemplate", () => {
	it("says nothing about a complete template", () => {
		expect(
			validatePromptTemplate(
				template({ system: COMPLETE_SYSTEM, tools: { editor: "Edit files." } }),
			),
		).toEqual([]);
	});

	it("flags a missing rules slot as required, and explains the repair", () => {
		const warnings = validatePromptTemplate(
			template({
				system: COMPLETE_SYSTEM.replace("{{CLINE_RULES}}", ""),
			}),
		);

		expect(codes(warnings)).toContain("missing-required-placeholder");
		const rules = warnings.find((w) => w.message.includes("{{CLINE_RULES}}"));
		expect(rules?.message).toContain("plan-mode");
		expect(rules?.message).toContain("appended for you");
	});

	it("flags a missing working directory as required", () => {
		const warnings = validatePromptTemplate(
			template({ system: COMPLETE_SYSTEM.replace("{{CWD}}", "") }),
		);

		const cwd = warnings.find((w) => w.message.includes("{{CWD}}"));
		expect(cwd?.code).toBe("missing-required-placeholder");
		expect(cwd?.message).toContain("working directory");
	});

	it("flags the environment placeholders as optional, not required", () => {
		const warnings = validatePromptTemplate(
			template({ system: COMPLETE_SYSTEM.replace("{{IDE_NAME}}", "") }),
		);

		expect(codes(warnings)).toEqual(["missing-optional-placeholder"]);
	});

	it("catches a placeholder that differs only in case", () => {
		// This is the mistake that costs an hour: it looks right, and the only
		// symptom is a model that does not know where it is.
		const warnings = validatePromptTemplate(
			template({ system: COMPLETE_SYSTEM.replace("{{CWD}}", "{{cwd}}") }),
		);

		const unknown = warnings.find((w) => w.code === "unknown-placeholder");
		expect(unknown?.message).toContain("{{cwd}}");
		expect(unknown?.message).toContain("did you mean {{CWD}}");
	});

	it("catches stray spaces inside a placeholder", () => {
		const warnings = validatePromptTemplate(
			template({ system: COMPLETE_SYSTEM.replace("{{CWD}}", "{{ CWD }}") }),
		);

		expect(
			warnings.find((w) => w.code === "unknown-placeholder")?.message,
		).toContain("did you mean {{CWD}}");
	});

	it("reports an invented placeholder without guessing at a fix", () => {
		const warnings = validatePromptTemplate(
			template({ system: `${COMPLETE_SYSTEM}\n{{PROJECT_NAME}}` }),
		);

		const unknown = warnings.find((w) => w.code === "unknown-placeholder");
		expect(unknown?.message).toContain("{{PROJECT_NAME}}");
		expect(unknown?.message).not.toContain("did you mean");
		expect(unknown?.message).toContain("literally");
	});

	it("reports {{DEFAULT}} used in the system section", () => {
		const warnings = validatePromptTemplate(
			template({ system: `${COMPLETE_SYSTEM}\n{{DEFAULT}}` }),
		);

		expect(codes(warnings)).toContain("default-marker-in-system");
	});

	it("accepts {{DEFAULT}} in a tool section", () => {
		expect(
			validatePromptTemplate(
				template({
					system: COMPLETE_SYSTEM,
					tools: { run_commands: "Commands only.\n\n{{DEFAULT}}" },
				}),
			),
		).toEqual([]);
	});

	it("catches a mistyped {{DEFAULT}} in a tool section", () => {
		const warnings = validatePromptTemplate(
			template({ system: COMPLETE_SYSTEM, tools: { editor: "{{default}}" } }),
		);

		expect(warnings[0]?.code).toBe("unknown-placeholder");
		expect(warnings[0]?.message).toContain("did you mean {{DEFAULT}}");
		expect(warnings[0]?.section).toBe("tool: editor");
	});

	it("does not expect system placeholders inside a tool description", () => {
		// A tool description is not the environment block, so a template that
		// omits {{CWD}} there is doing nothing wrong.
		expect(
			validatePromptTemplate(template({ tools: { editor: "Edit files." } })),
		).toEqual([]);
	});

	it("accepts {{IDE_NAME}} in a tool section", () => {
		// The one system placeholder that is also substituted in a tool
		// description, so a section naming the host is correct rather than dead
		// text.
		expect(
			validatePromptTemplate(
				template({
					system: COMPLETE_SYSTEM,
					tools: { check_file: "Ask {{IDE_NAME}}." },
				}),
			),
		).toEqual([]);
	});

	it("still reports a system placeholder that means nothing in a tool section", () => {
		const warnings = validatePromptTemplate(
			template({ system: COMPLETE_SYSTEM, tools: { editor: "In {{CWD}}." } }),
		);

		expect(warnings[0]?.code).toBe("unknown-placeholder");
		expect(warnings[0]?.section).toBe("tool: editor");
	});

	it("reports a section naming a tool that does not exist", () => {
		const warnings = validatePromptTemplate(
			template({ tools: { edittor: "typo" } }),
			{ knownToolNames: ["editor", "read_files"] },
		);

		expect(warnings[0]?.code).toBe("unknown-tool");
		expect(warnings[0]?.message).toContain("edittor");
	});

	it("stays quiet about tool names when the caller cannot say what exists", () => {
		expect(
			validatePromptTemplate(template({ tools: { anything: "text" } })),
		).toEqual([]);
	});

	it("reports an empty tool section", () => {
		const warnings = validatePromptTemplate(
			template({ tools: { editor: "   " } }),
		);

		expect(warnings[0]?.code).toBe("empty-section");
	});

	it("says nothing about a template that only overrides tools", () => {
		// No system section means no system placeholders to miss.
		expect(
			validatePromptTemplate(template({ tools: { editor: "Edit." } })),
		).toEqual([]);
	});

	it("names the section each warning belongs to", () => {
		const warnings = validatePromptTemplate(
			template({
				system: COMPLETE_SYSTEM.replace("{{CWD}}", ""),
				tools: { editor: "{{nope}}" },
			}),
		);

		expect(warnings.some((w) => w.section === "system")).toBe(true);
		expect(warnings.some((w) => w.section === "tool: editor")).toBe(true);
	});
});

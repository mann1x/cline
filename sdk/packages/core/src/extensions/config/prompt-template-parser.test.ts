import { describe, expect, it } from "vitest";
import { parsePromptTemplate } from "./prompt-template-parser";

const parse = (raw: string, fileName = "gemma.md") =>
	parsePromptTemplate({
		raw,
		source: "global",
		fileName,
		filePath: `/t/${fileName}`,
	});

describe("parsePromptTemplate", () => {
	it("reads the match rule and both kinds of section", () => {
		const result = parse(`---
name: gemma-4
match:
  provider: [ollama]
  family: [gemma*]
---

# system
You are Cline.

# tool: editor
Write a file.

# tool: run_commands
Run a command.
`);

		expect(result.error).toBeUndefined();
		expect(result.template?.name).toBe("gemma-4");
		expect(result.template?.match).toEqual({
			provider: ["ollama"],
			family: ["gemma*"],
			model: undefined,
		});
		expect(result.template?.system).toBe("You are Cline.");
		expect(result.template?.tools).toEqual({
			editor: "Write a file.",
			run_commands: "Run a command.",
		});
	});

	it("accepts a bare string where a list is allowed", () => {
		// `family: gemma*` is what anyone writes the first time.
		const result = parse(`---
match:
  family: gemma*
---

# system
Hi.
`);

		expect(result.template?.match?.family).toEqual(["gemma*"]);
	});

	it("falls back to the filename for the template name", () => {
		const result = parse("# system\nHi.\n", "qwen.md");

		expect(result.template?.name).toBe("qwen");
	});

	it("keeps a template that only overrides tools", () => {
		const result = parse(`---
name: tools-only
---

# tool: editor
Just this one.
`);

		expect(result.template?.system).toBeUndefined();
		expect(result.template?.tools).toEqual({ editor: "Just this one." });
	});

	it("treats a file with no frontmatter as the default template", () => {
		const result = parse("# system\nEverything.\n", "default.md");

		expect(result.template?.match).toBeUndefined();
		expect(result.template?.system).toBe("Everything.");
	});

	it("ignores prose before the first section heading", () => {
		const result = parse(`Notes to self, not the prompt.

# system
The prompt.
`);

		expect(result.template?.system).toBe("The prompt.");
	});

	it("preserves markdown inside a section", () => {
		const result = parse(`# system
Use these rules:

- one
- two

## Sub-heading survives
Body.
`);

		// Only a level-one heading delimits a section, so the tool descriptions
		// can use markdown structure of their own.
		expect(result.template?.system).toContain("## Sub-heading survives");
		expect(result.template?.system).toContain("- two");
	});

	it("reports a typo in a section heading instead of dropping it", () => {
		const result = parse(`# tools: editor
Write a file.
`);

		expect(result.template).toBeUndefined();
		expect(result.error).toContain("# tools: editor");
	});

	it("rejects an unknown match dimension by name", () => {
		const result = parse(`---
match:
  quantization: [Q4_K_M]
---

# system
Hi.
`);

		expect(result.error).toContain("quantization");
	});

	it("reports invalid YAML rather than throwing", () => {
		const result = parse(`---
match: [unclosed
---

# system
Hi.
`);

		expect(result.template).toBeUndefined();
		expect(result.error).toContain("valid YAML");
	});

	it("rejects a file with no usable section", () => {
		const result = parse(`---
name: empty
---

Just some prose.
`);

		expect(result.error).toContain("no '# system'");
	});

	it("handles CRLF line endings", () => {
		const result = parse("---\r\nname: crlf\r\n---\r\n\r\n# system\r\nHi.\r\n");

		expect(result.template?.name).toBe("crlf");
		expect(result.template?.system).toBe("Hi.");
	});

	it("reports a section that appears twice", () => {
		// A model rewriting a template emits a duplicate now and then. The last
		// one silently wins, so the copy the author reads may not be the copy
		// that takes effect — which is only findable if it is reported.
		const result = parsePromptTemplate({
			raw: [
				"---",
				"name: dup",
				"---",
				"",
				"# tool: editor",
				"first",
				"",
				"# tool: editor",
				"second",
				"",
			].join("\n"),
			source: "global",
			fileName: "dup.md",
		});

		expect(result.template?.tools.editor).toBe("second");
		expect(
			(result.warnings ?? []).some(
				(warning) =>
					warning.code === "duplicate-section" &&
					warning.section === "tool: editor",
			),
		).toBe(true);
	});
});

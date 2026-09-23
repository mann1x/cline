import { promptTemplateMatchBlocks } from "@cline/shared";
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
	it("keeps an exclusion pattern as written", () => {
		const result = parse(`---
name: qwen
match:
  family: [qwen*, "!*moe*"]
---

# system
You are Cline.
`);

		expect(result.error).toBeUndefined();
		expect(
			promptTemplateMatchBlocks(result.template?.match)[0]?.family,
		).toEqual(["qwen*", "!*moe*"]);
	});

	// The any-of form. One block ANDs its dimensions, which is right for
	// "Gemma on Ollama" and wrong for the fallback ladder: a family template
	// has to claim the local builds by architecture AND the cloud tags by
	// name, and those are disjoint sets.
	it("reads a list of match blocks as alternatives", () => {
		const result = parse(`---
name: qwen
match:
  - model: ["qwen*"]
  - family: [qwen*]
---

# system
You are Cline.
`);

		expect(result.error).toBeUndefined();
		const blocks = promptTemplateMatchBlocks(result.template?.match);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]?.model).toEqual(["qwen*"]);
		expect(blocks[0]?.family).toBeUndefined();
		expect(blocks[1]?.family).toEqual(["qwen*"]);
	});

	it("refuses a list entry that is not a mapping", () => {
		const result = parse(`---
name: qwen
match:
  - "qwen*"
---

# system
Hi.
`);

		expect(result.error).toMatch(/match\[0\]/);
	});

	// A lone "!" excludes nothing while reading like it excludes everything,
	// and the failure would land at the next session start, not here.
	it("refuses a bare exclusion marker", () => {
		const result = parse(`---
name: qwen
match:
  family: [qwen*, "!"]
---

# system
You are Cline.
`);

		expect(result.error).toMatch(/bare "!"/);
	});

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

		expect(
			promptTemplateMatchBlocks(result.template?.match)[0]?.family,
		).toEqual(["gemma*"]);
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

describe("compaction sections", () => {
	const raw = [
		"---",
		"name: gemma",
		"match:",
		"  family: [gemma*]",
		"---",
		"",
		"# system",
		"Be useful.",
		"",
		"# compaction: replay",
		"Retell the work in your own voice. {{files_read}}",
		"",
		"# compaction: council-critic",
		"Fix the {{half}} half.",
		"",
		"# compaction: counsil-critic",
		"a typo, which must not become a prompt",
	].join("\n");

	it("reads each known id into the template", () => {
		const result = parsePromptTemplate({
			raw,
			source: "global",
			fileName: "gemma.md",
		});
		expect(result.template?.compaction).toEqual({
			replay: "Retell the work in your own voice. {{files_read}}",
			"council-critic": "Fix the {{half}} half.",
		});
		expect(result.template?.system).toBe("Be useful.");
	});

	it("leaves a template without them exactly as it was", () => {
		const result = parsePromptTemplate({
			raw: "---\nname: plain\n---\n\n# system\nHi.",
			source: "global",
			fileName: "plain.md",
		});
		expect(result.template).not.toHaveProperty("compaction");
	});
});

describe("rendering compaction sections", () => {
	it("takes the matched template's sections over the base's, id by id", async () => {
		const { renderPromptTemplate } = await import("@cline/shared");
		const parse = (text: string, fileName: string) => {
			const template = parsePromptTemplate({
				raw: text,
				source: "global",
				fileName,
			}).template;
			if (!template) throw new Error(`did not parse ${fileName}`);
			return template;
		};
		const base = parse(
			"---\nname: default\n---\n\n# system\nBase.\n\n# compaction: full\nBase full.",
			"default.md",
		);
		const gemma = parse(
			"---\nname: gemma\nmatch:\n  family: [gemma*]\n---\n\n# compaction: replay\nGemma replay.",
			"gemma.md",
		);
		const rendered = renderPromptTemplate([base, gemma], {
			providerId: "ollama",
			modelId: "gemma4",
			family: "gemma4",
		});
		expect(rendered?.compaction).toEqual({
			full: "Base full.",
			replay: "Gemma replay.",
		});
	});
});

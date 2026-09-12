import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildToolSectionDeltaPrompt,
	joinTemplateSections,
	parseToolSectionsFromReply,
	spliceToolSections,
	splitTemplateSections,
} from "./prompt-template-delta";

const TEMPLATE_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"assets",
	"prompt-templates",
);

const SAMPLE = `---
name: sample
family: ["qwen*"]
---

A note above the first heading.

# system

Be terse.

# tool: read_files

Read files. Output: the text.

# tool: editor

Edit files. Output: what changed.
`;

describe("splitTemplateSections", () => {
	it("keeps the frontmatter and the note as one leading section", () => {
		const sections = splitTemplateSections(SAMPLE);
		expect(sections[0].heading).toBe("");
		expect(sections[0].body).toContain("name: sample");
		expect(sections[0].body).toContain("A note above the first heading.");
	});

	it("names each tool section and keeps the file's order", () => {
		const sections = splitTemplateSections(SAMPLE);
		expect(sections.map((section) => section.name)).toEqual([
			undefined,
			undefined,
			"read_files",
			"editor",
		]);
	});
});

describe("round-tripping a real shipped template", () => {
	// The whole promise of a section rewrite is that nothing outside the named
	// sections moves. If split/join is not byte-exact, that promise is false
	// for every file, and a diff would show churn nobody asked for.
	const files = readdirSync(TEMPLATE_DIR).filter((name) =>
		name.endsWith(".md"),
	);

	it("finds the shipped templates", () => {
		expect(files.length).toBeGreaterThanOrEqual(10);
	});

	for (const file of files) {
		it(`splits and rejoins ${file} byte for byte`, () => {
			const raw = readFileSync(join(TEMPLATE_DIR, file), "utf8");
			expect(joinTemplateSections(splitTemplateSections(raw))).toBe(raw);
		});
	}
});

describe("spliceToolSections", () => {
	it("rewrites a section in place and leaves every other byte alone", () => {
		const result = spliceToolSections(
			SAMPLE,
			new Map([["read_files", "Totally new text."]]),
		);
		expect(result.replaced).toEqual(["read_files"]);
		expect(result.added).toEqual([]);
		expect(result.template).toContain(
			"# tool: read_files\n\nTotally new text.",
		);
		// Everything else survives, including the section after the one changed.
		expect(result.template).toContain("name: sample");
		expect(result.template).toContain("A note above the first heading.");
		expect(result.template).toContain("Be terse.");
		expect(result.template).toContain(
			"# tool: editor\n\nEdit files. Output: what changed.",
		);
	});

	it("does not move a rewritten section within the file", () => {
		const result = spliceToolSections(
			SAMPLE,
			new Map([["read_files", "Replaced."]]),
		);
		const order = splitTemplateSections(result.template).map(
			(section) => section.name,
		);
		expect(order).toEqual([undefined, undefined, "read_files", "editor"]);
	});

	it("appends a tool the file does not cover yet", () => {
		const result = spliceToolSections(
			SAMPLE,
			new Map([["grep", "Search with grep."]]),
		);
		expect(result.added).toEqual(["grep"]);
		expect(result.replaced).toEqual([]);
		expect(result.template.trimEnd().endsWith("Search with grep.")).toBe(true);
		expect(result.template).toContain("# tool: grep\n\nSearch with grep.");
	});

	it("changes nothing at all when handed nothing", () => {
		expect(spliceToolSections(SAMPLE, new Map()).template).toBe(SAMPLE);
	});
});

describe("parseToolSectionsFromReply", () => {
	it("drops the model's preamble and keeps the sections", () => {
		const reply = [
			"Sure! Here are the sections you asked for:",
			"",
			"# tool: grep",
			"Search with grep.",
			"",
			"# tool: sed",
			"Edit a stream.",
		].join("\n");
		const parsed = parseToolSectionsFromReply(reply, ["grep", "sed"]);
		expect([...parsed.sections.keys()]).toEqual(["grep", "sed"]);
		expect(parsed.sections.get("grep")).toBe("Search with grep.");
		expect(parsed.unknown).toEqual([]);
	});

	it("refuses a tool that does not exist rather than splicing it", () => {
		const parsed = parseToolSectionsFromReply(
			"# tool: teleport\nGo anywhere.",
			["grep"],
		);
		expect(parsed.sections.size).toBe(0);
		expect(parsed.unknown).toEqual(["teleport"]);
	});
});

describe("buildToolSectionDeltaPrompt", () => {
	it("names the tools and forbids returning the whole file", () => {
		const prompt = buildToolSectionDeltaPrompt({
			familyTemplate: SAMPLE,
			defaultSections: new Map([["grep", "Built-in grep text."]]),
			tools: ["grep"],
			modelId: "test-model",
		});
		expect(prompt).toContain("# tool: grep");
		expect(prompt).toContain("Built-in grep text.");
		expect(prompt).toContain("Do not return the `# system` section");
		expect(prompt).toContain("Start your reply with `# tool: grep`");
	});
});

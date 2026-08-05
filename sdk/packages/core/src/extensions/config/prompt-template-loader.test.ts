import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePromptTemplate, shadowPromptTemplates } from "@cline/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadPromptTemplates,
	loadPromptTemplatesFromDirectory,
	resolvePromptTemplateDirectories,
} from "./prompt-template-loader";

const roots: string[] = [];

function makeDir(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "cline-templates-"));
	roots.push(root);
	mkdirSync(root, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(root, name), content, "utf8");
	}
	return root;
}

afterEach(() => {
	while (roots.length > 0) {
		rmSync(roots.pop() as string, { recursive: true, force: true });
	}
});

describe("loadPromptTemplatesFromDirectory", () => {
	it("reads every markdown template and records its path", () => {
		const dir = makeDir({
			"gemma.md": "---\nmatch:\n  family: [gemma*]\n---\n\n# system\nG.\n",
			"qwen.md": "---\nmatch:\n  family: [qwen*]\n---\n\n# system\nQ.\n",
		});

		const result = loadPromptTemplatesFromDirectory({
			path: dir,
			source: "global",
		});

		expect(result.errors).toEqual([]);
		expect(result.templates.map((template) => template.name).sort()).toEqual([
			"gemma",
			"qwen",
		]);
		expect(result.templates[0]?.filePath).toBe(join(dir, "gemma.md"));
		expect(result.templates[0]?.source).toBe("global");
	});

	it("treats a missing directory as no templates rather than an error", () => {
		// Most users never create one, and the builtins stand alone.
		const result = loadPromptTemplatesFromDirectory({
			path: join(tmpdir(), "cline-templates-does-not-exist"),
			source: "workspace",
		});

		expect(result.templates).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it("ignores files that are not markdown", () => {
		const dir = makeDir({
			"gemma.md": "# system\nG.\n",
			"notes.txt": "not a template",
			".DS_Store": "junk",
		});

		const result = loadPromptTemplatesFromDirectory({
			path: dir,
			source: "global",
		});

		expect(result.templates.map((template) => template.name)).toEqual([
			"gemma",
		]);
	});

	it("reports a broken template and keeps the rest", () => {
		// One stray colon must not stop a session from starting.
		const dir = makeDir({
			"broken.md": "---\nmatch: [oops\n---\n\n# system\nX.\n",
			"good.md": "# system\nFine.\n",
		});

		const result = loadPromptTemplatesFromDirectory({
			path: dir,
			source: "global",
		});

		expect(result.templates.map((template) => template.name)).toEqual(["good"]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.fileName).toBe("broken.md");
		expect(result.errors[0]?.message).toContain("valid YAML");
		// The settings UI needs the path to offer to open the offending file.
		expect(result.errors[0]?.filePath).toBe(join(dir, "broken.md"));
	});

	it("reads in a stable order regardless of directory order", () => {
		const dir = makeDir({
			"z.md": "# system\nZ.\n",
			"a.md": "# system\nA.\n",
			"m.md": "# system\nM.\n",
		});

		const result = loadPromptTemplatesFromDirectory({
			path: dir,
			source: "global",
		});

		expect(result.templates.map((template) => template.name)).toEqual([
			"a",
			"m",
			"z",
		]);
	});
});

describe("loadPromptTemplates", () => {
	it("keeps the nearer source last so shadowing and tie-breaks agree", () => {
		const builtin = makeDir({
			"gemma.md":
				"---\nmatch:\n  family: [gemma*]\n---\n\n# system\nbuiltin.\n",
		});
		const workspace = makeDir({
			"gemma.md":
				"---\nmatch:\n  family: [gemma*]\n---\n\n# system\nworkspace.\n",
		});

		const { templates } = loadPromptTemplates(
			resolvePromptTemplateDirectories({
				builtinDir: builtin,
				workspaceDir: workspace,
			}),
		);

		expect(shadowPromptTemplates(templates)).toHaveLength(1);
		expect(
			resolvePromptTemplate(templates, {
				providerId: "ollama",
				modelId: "v7-coder",
				family: "gemma4",
			})?.system,
		).toBe("workspace.");
	});

	it("lets a global template shadow a builtin of the same name", () => {
		const builtin = makeDir({ "qwen.md": "# system\nbuiltin.\n" });
		const global = makeDir({ "qwen.md": "# system\nmine.\n" });

		const { templates } = loadPromptTemplates(
			resolvePromptTemplateDirectories({
				builtinDir: builtin,
				globalDir: global,
			}),
		);

		expect(shadowPromptTemplates(templates)[0]?.system).toBe("mine.");
	});

	it("lets a workspace template add to the set without replacing anything", () => {
		const builtin = makeDir({ "default.md": "# system\nbase.\n" });
		const workspace = makeDir({
			"house-style.md":
				"---\nmatch:\n  provider: [ollama]\n---\n\n# system\nhouse.\n",
		});

		const { templates } = loadPromptTemplates(
			resolvePromptTemplateDirectories({
				builtinDir: builtin,
				workspaceDir: workspace,
			}),
		);

		expect(shadowPromptTemplates(templates)).toHaveLength(2);
		expect(
			resolvePromptTemplate(templates, {
				providerId: "ollama",
				modelId: "anything",
			})?.system,
		).toBe("house.");
		expect(
			resolvePromptTemplate(templates, {
				providerId: "anthropic",
				modelId: "claude-opus-5",
			})?.system,
		).toBe("base.");
	});

	it("collects errors from every directory", () => {
		const global = makeDir({ "a.md": "---\nbad: [\n---\n\n# system\nX.\n" });
		const workspace = makeDir({ "b.md": "just prose, no sections\n" });

		const { errors } = loadPromptTemplates(
			resolvePromptTemplateDirectories({
				globalDir: global,
				workspaceDir: workspace,
			}),
		);

		expect(errors.map((error) => error.source).sort()).toEqual([
			"global",
			"workspace",
		]);
	});
});

describe("warnings from an edited template", () => {
	it("surfaces a mistyped placeholder against the file it came from", () => {
		const dir = makeDir({
			"mine.md": "# system\nWorking in {{cwd}}.\n{{CLINE_RULES}}\n",
		});

		const { templates, errors, warnings } = loadPromptTemplates(
			resolvePromptTemplateDirectories({ globalDir: dir }),
		);

		// It still loads — a warning is not a reason to refuse the file.
		expect(templates).toHaveLength(1);
		expect(errors).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.fileName).toBe("mine.md");
		expect(warnings[0]?.filePath).toBe(join(dir, "mine.md"));
		expect(
			warnings[0]?.warnings.some((warning) =>
				warning.message.includes("did you mean {{CWD}}"),
			),
		).toBe(true);
	});

	it("reports a section naming a tool that does not exist", () => {
		const dir = makeDir({ "mine.md": "# tool: edittor\nTypo.\n" });

		const { warnings } = loadPromptTemplates(
			resolvePromptTemplateDirectories({ globalDir: dir }),
			{ knownToolNames: ["editor"] },
		);

		expect(warnings[0]?.warnings[0]?.code).toBe("unknown-tool");
	});

	it("says nothing about a template with nothing wrong with it", () => {
		const dir = makeDir({
			"mine.md":
				"# system\n{{PLATFORM_NAME}} {{CWD}} {{CURRENT_DATE}} {{IDE_NAME}}\n{{CLINE_RULES}}\n{{CLINE_METADATA}}\n",
		});

		expect(
			loadPromptTemplates(resolvePromptTemplateDirectories({ globalDir: dir }))
				.warnings,
		).toEqual([]);
	});
});

describe("resolvePromptTemplateDirectories", () => {
	it("orders builtin, then global, then workspace", () => {
		expect(
			resolvePromptTemplateDirectories({
				builtinDir: "/b",
				globalDir: "/g",
				workspaceDir: "/w",
			}),
		).toEqual([
			{ path: "/b", source: "builtin" },
			{ path: "/g", source: "global" },
			{ path: "/w", source: "workspace" },
		]);
	});

	it("omits the directories the host cannot resolve", () => {
		expect(resolvePromptTemplateDirectories({ globalDir: "/g" })).toEqual([
			{ path: "/g", source: "global" },
		]);
		expect(resolvePromptTemplateDirectories({})).toEqual([]);
	});
});

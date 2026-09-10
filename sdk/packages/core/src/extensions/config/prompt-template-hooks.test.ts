import type {
	AgentBeforeModelContext,
	AgentToolDefinition,
	RenderedPromptTemplate,
} from "@cline/shared";
import { describe, expect, it } from "vitest";
import { createPromptTemplateHooks } from "./prompt-template-hooks";

const rendered = (
	partial: Partial<RenderedPromptTemplate>,
): RenderedPromptTemplate => ({
	name: "gemma",
	fileName: "gemma.md",
	source: "builtin",
	overlaid: true,
	tools: {},
	...partial,
});

const tool = (
	name: string,
	description: string,
	extra: Partial<AgentToolDefinition> = {},
): AgentToolDefinition => ({
	name,
	description,
	inputSchema: { type: "object" },
	...extra,
});

const contextWith = (tools: readonly AgentToolDefinition[]) =>
	({ request: { tools } }) as unknown as AgentBeforeModelContext;

describe("createPromptTemplateHooks", () => {
	it("applies the rendered description for every tool it covers", async () => {
		// The rendered map already carries default.md's descriptions merged with
		// the family template's, so a tool the family never mentioned is still
		// rewritten — to what default.md says.
		const hooks = createPromptTemplateHooks({
			rendered: rendered({
				tools: {
					editor: "gemma editor",
					read_files: "default read",
				},
			}),
		});

		const result = await hooks?.beforeModel?.(
			contextWith([
				tool("editor", "code editor"),
				tool("read_files", "code read"),
			]),
		);

		expect(result?.tools?.[0]?.description).toBe("gemma editor");
		expect(result?.tools?.[1]?.description).toBe("default read");
	});

	it("names the host wherever a description asks for it", async () => {
		// The extension and the CLI ship the same descriptions and are not the
		// same host. This is the seam where "the IDE" stops being written into
		// a prompt a terminal will read.
		const hooks = createPromptTemplateHooks({
			rendered: rendered({ tools: { code_intel: "Ask {{IDE_NAME}}." } }),
			ideName: "Terminal Shell",
		});

		const result = await hooks?.beforeModel?.(
			contextWith([tool("code_intel", "symbols")]),
		);

		expect(result?.tools?.[0]?.description).toBe("Ask Terminal Shell.");
	});

	it("leaves a tool no template covers reading what the code built", async () => {
		const hooks = createPromptTemplateHooks({
			rendered: rendered({ tools: { editor: "gemma editor" } }),
		});

		const result = await hooks?.beforeModel?.(
			contextWith([
				tool("editor", "code editor"),
				tool("skills", "code skills"),
			]),
		);

		expect(result?.tools?.[1]?.description).toBe("code skills");
	});

	it("expands {{DEFAULT}} against the live description", async () => {
		// Deliberately not expanded at render time: the shell-specific
		// run_commands text and the skills list only exist on the built tool.
		const hooks = createPromptTemplateHooks({
			rendered: rendered({
				tools: { run_commands: "Commands only.\n\n{{DEFAULT}}" },
			}),
		});

		const result = await hooks?.beforeModel?.(
			contextWith([tool("run_commands", "PowerShell uses ';' to sequence.")]),
		);

		expect(result?.tools?.[0]?.description).toBe(
			"Commands only.\n\nPowerShell uses ';' to sequence.",
		);
	});

	it("does the work once for a tool set it has already seen", async () => {
		// A fifty-turn conversation hands over the same array every turn.
		let reads = 0;
		const skills = {
			name: "skills",
			inputSchema: {},
			get description() {
				reads++;
				return "base. Available skills: pdf.";
			},
		} as unknown as AgentToolDefinition;
		const tools = [skills];

		const hooks = createPromptTemplateHooks({
			rendered: rendered({ tools: { skills: "{{DEFAULT}} Prefer these." } }),
		});

		const first = await hooks?.beforeModel?.(contextWith(tools));
		const second = await hooks?.beforeModel?.(contextWith(tools));
		const third = await hooks?.beforeModel?.(contextWith(tools));

		expect(second?.tools).toBe(first?.tools);
		expect(third?.tools).toBe(first?.tools);
		expect(reads).toBeLessThanOrEqual(2);
	});

	it("recomputes for a tool set it has not seen", async () => {
		const hooks = createPromptTemplateHooks({
			rendered: rendered({ tools: { editor: "gemma editor" } }),
		});

		const first = await hooks?.beforeModel?.(
			contextWith([tool("editor", "code editor")]),
		);
		const second = await hooks?.beforeModel?.(
			contextWith([tool("editor", "code editor")]),
		);

		expect(second?.tools).not.toBe(first?.tools);
		expect(second?.tools?.[0]?.description).toBe("gemma editor");
	});

	it("leaves the schema and lifecycle on a rewritten tool alone", async () => {
		const hooks = createPromptTemplateHooks({
			rendered: rendered({ tools: { submit_and_exit: "rewritten" } }),
		});

		const result = await hooks?.beforeModel?.(
			contextWith([
				tool("submit_and_exit", "original", {
					inputSchema: { type: "object", properties: { a: {} } },
					lifecycle: { completesRun: true },
				}),
			]),
		);

		expect(result?.tools?.[0]?.inputSchema).toEqual({
			type: "object",
			properties: { a: {} },
		});
		expect(result?.tools?.[0]?.lifecycle).toEqual({ completesRun: true });
	});

	it("does not mutate the tools on the request", async () => {
		const original = tool("editor", "code editor");
		const hooks = createPromptTemplateHooks({
			rendered: rendered({ tools: { editor: "gemma editor" } }),
		});

		await hooks?.beforeModel?.(contextWith([original]));

		expect(original.description).toBe("code editor");
	});

	it("stands down only when there are no templates on disk at all", () => {
		// A template that overrides nothing still carries default.md's
		// descriptions, so it must not short-circuit — otherwise default.md
		// would apply to exactly the sessions that matched nothing else.
		expect(createPromptTemplateHooks({ rendered: undefined })).toBeUndefined();
		expect(
			createPromptTemplateHooks({ rendered: rendered({ tools: {} }) }),
		).toBeUndefined();
		expect(
			createPromptTemplateHooks({
				rendered: rendered({ tools: { editor: "x" } }),
			}),
		).toBeDefined();
	});

	it("stands down when a request carries no tools", async () => {
		const hooks = createPromptTemplateHooks({
			rendered: rendered({ tools: { editor: "rewritten" } }),
		});

		expect(await hooks?.beforeModel?.(contextWith([]))).toBeUndefined();
	});

	it("rewrites an MCP tool the same as a builtin one", async () => {
		// Tools reach the request from three different places; this hook sees
		// them all identically, which is the reason it lives here.
		const hooks = createPromptTemplateHooks({
			rendered: rendered({
				tools: { searxng__web_search: "Search the web." },
			}),
		});

		const result = await hooks?.beforeModel?.(
			contextWith([tool("searxng__web_search", "original mcp text")]),
		);

		expect(result?.tools?.[0]?.description).toBe("Search the web.");
	});

	// The whole point of the report: a run where the tools kept their built-in
	// text is indistinguishable from a working one without it.
	it("names the tools whose description the template changed", async () => {
		const lines: string[] = [];
		const hooks = createPromptTemplateHooks({
			rendered: rendered({
				name: "qwen",
				tools: { editor: "use editor, never sed", read_files: "read them" },
			}),
			log: (message) => lines.push(message),
		});

		await hooks?.beforeModel?.(
			contextWith([
				tool("editor", "builtin editor text"),
				tool("read_files", "builtin read text"),
				tool("run_commands", "builtin shell text"),
			]),
		);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("qwen");
		expect(lines[0]).toContain("2 of 3");
		expect(lines[0]).toContain("editor");
		expect(lines[0]).toContain("read_files");
		expect(lines[0]).not.toContain("run_commands");
	});

	// The failure this exists to catch, stated in the log rather than inferred
	// from its absence.
	it("says so when the template changed nothing at all", async () => {
		const lines: string[] = [];
		const hooks = createPromptTemplateHooks({
			rendered: rendered({ name: "qwen", tools: { editor: "same text" } }),
			log: (message) => lines.push(message),
		});

		await hooks?.beforeModel?.(contextWith([tool("editor", "same text")]));

		expect(lines[0]).toContain("0 of 1");
		expect(lines[0]).toContain("kept its built-in text");
	});

	// A fifty-turn conversation must not print fifty copies.
	it("reports once, not once per request", async () => {
		const lines: string[] = [];
		const hooks = createPromptTemplateHooks({
			rendered: rendered({ name: "qwen", tools: { editor: "rewritten" } }),
			log: (message) => lines.push(message),
		});
		const tools = [tool("editor", "builtin")];

		await hooks?.beforeModel?.(contextWith(tools));
		await hooks?.beforeModel?.(contextWith(tools));
		// A rebuilt array: recomputed, but it changes the same tool, so silent.
		await hooks?.beforeModel?.(contextWith([tool("editor", "builtin")]));

		expect(lines).toHaveLength(1);
	});

	it("speaks again when a later request changes a different set", async () => {
		const lines: string[] = [];
		const hooks = createPromptTemplateHooks({
			rendered: rendered({
				name: "qwen",
				tools: { editor: "rewritten", browser: "rewritten too" },
			}),
			log: (message) => lines.push(message),
		});

		await hooks?.beforeModel?.(contextWith([tool("editor", "builtin")]));
		await hooks?.beforeModel?.(
			contextWith([tool("editor", "builtin"), tool("browser", "builtin")]),
		);

		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("browser");
	});

	it("rewrites exactly as before when no log is given", async () => {
		const hooks = createPromptTemplateHooks({
			rendered: rendered({ tools: { editor: "rewritten" } }),
		});

		const result = await hooks?.beforeModel?.(
			contextWith([tool("editor", "builtin")]),
		);

		expect(result?.tools?.[0]?.description).toBe("rewritten");
	});
});

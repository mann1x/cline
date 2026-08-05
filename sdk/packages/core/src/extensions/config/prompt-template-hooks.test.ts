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
});

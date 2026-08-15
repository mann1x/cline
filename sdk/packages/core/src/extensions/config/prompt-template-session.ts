import type { RenderedPromptTemplate } from "@cline/shared";
import { renderPromptTemplate } from "@cline/shared";
import { getBuiltinPromptTemplates } from "./builtin-templates";
import {
	loadPromptTemplates,
	type PromptTemplateFileWarnings,
	type PromptTemplateLoadError,
	resolvePromptTemplateDirectories,
} from "./prompt-template-loader";

/**
 * Work out which prompt template a session is on, once, for any host.
 *
 * This used to live in the VS Code extension, and the CLI had no equivalent —
 * so a local model got its family's template in the plugin and the built-in
 * default in the CLI. That is not a cosmetic difference. `qwen.md` is the file
 * that says "use `editor`, never `sed -i`, never `cat`"; without it a run
 * measured 119 `run_commands` calls in one transaction, most of them `node -e`
 * one-liners reading and rewriting the file the `editor` tool exists to edit.
 * Two hosts that disagree about the prompt cannot be compared, and a result
 * measured on one cannot be carried to the other.
 *
 * The family is a parameter rather than something resolved here: only the
 * caller knows how to ask its provider, and the extension's lookup reports
 * progress through the editor's UI. Everything after that point — which
 * directories to read, which template wins, how it merges over `default.md` —
 * is identical for every host and lives here.
 */
export interface SessionPromptTemplateRequest {
	providerId: string;
	modelId: string;
	/** The architecture the provider reported, when it could answer. */
	family?: string;
	/** `<data dir>/templates`, shared across projects. */
	globalDir?: string;
	/** `<workspace>/.clinerules/templates`, committed with the project. */
	workspaceDir?: string;
	/** Tool names, so a section naming something else can be reported. */
	knownToolNames?: readonly string[];
}

export interface SessionPromptTemplateResult {
	rendered: RenderedPromptTemplate | undefined;
	errors: PromptTemplateLoadError[];
	warnings: PromptTemplateFileWarnings[];
}

export function resolveSessionPromptTemplateFrom(
	request: SessionPromptTemplateRequest,
): SessionPromptTemplateResult {
	const { templates, errors, warnings } = loadPromptTemplates(
		resolvePromptTemplateDirectories({
			globalDir: request.globalDir,
			workspaceDir: request.workspaceDir,
		}),
		{ knownToolNames: request.knownToolNames },
	);

	// Builtins first so a user's template of the same name shadows one.
	const rendered = renderPromptTemplate(
		[...getBuiltinPromptTemplates(), ...templates],
		{
			providerId: request.providerId,
			modelId: request.modelId,
			family: request.family,
		},
	);

	return { rendered, errors, warnings };
}

/**
 * One line naming what a session ended up on, for a host's log.
 *
 * Written here rather than at each call site because it is the only evidence a
 * template was applied at all: the CLI's silence on this is exactly how it went
 * unnoticed that it was resolving none.
 */
export function describeResolvedPromptTemplate(
	request: Pick<SessionPromptTemplateRequest, "modelId" | "family">,
	rendered: RenderedPromptTemplate | undefined,
): string {
	const model = `${request.modelId}${request.family ? ` (${request.family})` : ""}`;
	if (!rendered) {
		return `[PromptTemplates] ${model} → none; the built-in prompt applies`;
	}
	return `[PromptTemplates] ${model} → ${rendered.name}${rendered.overlaid ? " over default" : ""}`;
}

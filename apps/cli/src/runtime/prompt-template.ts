import { homedir } from "node:os";
import { join } from "node:path";
import {
	describeResolvedPromptTemplate,
	PROMPT_TEMPLATES_DIRECTORY_NAME,
	readDeclaredFamily,
	resolveSessionPromptTemplateFrom,
} from "@cline/core";
import type { RenderedPromptTemplate } from "@cline/shared";

/**
 * Which prompt template this CLI session is on.
 *
 * The extension has resolved one per session since templates existed; this host
 * resolved none, and the difference was not visible from either side. A local
 * model ran on `qwen.md` in the plugin — the file that says "use `editor`,
 * never `sed -i`, never `cat`" — and on the built-in prompt here, which says
 * none of it. Measured on the run that exposed it: 119 `run_commands` calls in
 * a single transaction, nearly all `node -e` one-liners reading and rewriting
 * the file that `editor` exists to edit.
 *
 * The directories, the matching and the merge over `default.md` are core's, so
 * both hosts resolve the same template from the same rules. What is local here
 * is where this host keeps its data directory, and that its family comes from
 * the `/api/show` it already makes for the context window rather than a second
 * lookup of its own.
 */

/** `<data dir>/templates`, matching the extension's own resolution. */
function resolveGlobalTemplateDirectory(): string {
	const explicit = process.env.CLINE_DATA_DIR?.trim();
	const dataDir =
		explicit ||
		join(process.env.CLINE_DIR?.trim() || join(homedir(), ".cline"), "data");
	return join(dataDir, PROMPT_TEMPLATES_DIRECTORY_NAME);
}

/** `<workspace>/.clinerules/templates`, committed with the project. */
function resolveWorkspaceTemplateDirectory(
	workspaceRoot: string | undefined,
): string | undefined {
	const trimmed = workspaceRoot?.trim();
	return trimmed
		? join(trimmed, ".clinerules", PROMPT_TEMPLATES_DIRECTORY_NAME)
		: undefined;
}

export interface CliPromptTemplateOptions {
	providerId: string;
	modelId: string;
	workspaceRoot?: string;
	/** Ollama's endpoint, when that is the provider. Blank means its default. */
	baseUrl?: string;
	log?: (message: string) => void;
	warn?: (message: string) => void;
}

/**
 * Resolve the template, and say which one won.
 *
 * Failure is not fatal: a template that cannot be read costs a template, and
 * the session falls back to the built-in prompt — which is what it did before
 * this existed. It is reported rather than swallowed, because a session
 * silently running on the wrong prompt is the failure this closes.
 */
export function resolveCliPromptTemplate(
	options: CliPromptTemplateOptions,
): RenderedPromptTemplate | undefined {
	try {
		// Only Ollama can answer what a local model actually is, and only it
		// needs to: a hosted provider's model ids already say. `readDeclaredFamily`
		// reads the answer already cached by the context-window lookup, so this
		// adds no request and no wait.
		const family =
			options.providerId === "ollama"
				? readDeclaredFamily(options.baseUrl, options.modelId)
				: undefined;

		const { rendered, errors, warnings } = resolveSessionPromptTemplateFrom({
			providerId: options.providerId,
			modelId: options.modelId,
			family,
			globalDir: resolveGlobalTemplateDirectory(),
			workspaceDir: resolveWorkspaceTemplateDirectory(options.workspaceRoot),
		});

		for (const error of errors) {
			options.warn?.(
				`[PromptTemplates] ${error.fileName} was skipped: ${error.message}`,
			);
		}
		for (const file of warnings) {
			for (const warning of file.warnings) {
				options.log?.(
					`[PromptTemplates] ${file.fileName} (${warning.section}): ${warning.message}`,
				);
			}
		}
		options.log?.(
			describeResolvedPromptTemplate(
				{ modelId: options.modelId, family },
				rendered,
			),
		);
		return rendered;
	} catch (error) {
		options.warn?.(
			`[PromptTemplates] Failed to resolve a prompt template: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return undefined;
	}
}

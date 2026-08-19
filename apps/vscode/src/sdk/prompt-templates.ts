import {
	describeResolvedPromptTemplate,
	PROMPT_TEMPLATES_DIRECTORY_NAME,
	type PromptTemplateFileWarnings,
	type PromptTemplateLoadError,
	resolveSessionPromptTemplateFrom,
} from "@cline/core"
import type { RenderedPromptTemplate } from "@cline/shared"
import { Logger } from "@shared/services/Logger"
import { resolveDataDirFromEnv } from "@shared/storage/storage-context"
import * as path from "path"
import { resolveOllamaModelFamily } from "./ollama-model-family"

/**
 * Work out which prompt template a session is on, once.
 *
 * Everything expensive happens here: reading two directories off disk, asking
 * Ollama what a local model actually is, and merging the winning template over
 * `default.md`. What comes back is finished — a system prompt and a complete
 * map of tool descriptions — and nothing downstream resolves anything again.
 */

/** `<cline data dir>/templates`, shared across every project. */
export function resolveGlobalTemplateDirectory(): string {
	return path.join(resolveDataDirFromEnv(), PROMPT_TEMPLATES_DIRECTORY_NAME)
}

/** `<workspace>/.clinerules/templates`, committed with the project. */
export function resolveWorkspaceTemplateDirectory(workspaceRoot: string): string | undefined {
	const trimmed = workspaceRoot?.trim()
	return trimmed ? path.join(trimmed, ".clinerules", PROMPT_TEMPLATES_DIRECTORY_NAME) : undefined
}

export interface ResolvePromptTemplateOptions {
	providerId: string
	modelId: string
	workspaceRoot?: string
	/** Ollama's endpoint, when that is the provider. Blank means its default. */
	baseUrl?: string
	/** Tool names, so a section naming something else can be reported. */
	knownToolNames?: readonly string[]
}

export interface ResolvedSessionPromptTemplate {
	rendered: RenderedPromptTemplate | undefined
	/** The family the provider reported, for logs and for the settings UI. */
	family?: string
	errors: PromptTemplateLoadError[]
	warnings: PromptTemplateFileWarnings[]
}

/**
 * Ask the provider what family a model belongs to.
 *
 * Only Ollama can answer today, and only Ollama needs to: a hosted provider's
 * model IDs already say what they are, while a local GGUF called `v7-coder`
 * gives nothing away. Anything else resolves to no family and matches on
 * provider or model instead.
 */
async function resolveFamily(options: ResolvePromptTemplateOptions): Promise<string | undefined> {
	// No check on `baseUrl`: an unset one is Ollama's default endpoint, not the
	// absence of one, and `resolveOllamaModelFamily` resolves it the same way
	// the request path does.
	if (options.providerId !== "ollama") {
		return undefined
	}
	try {
		return await resolveOllamaModelFamily(options.baseUrl, options.modelId)
	} catch (error) {
		// Not knowing the family costs a family template. Letting the failure
		// through would cost the whole stack, including default.md, which is a
		// much larger regression for a much smaller cause.
		Logger.warn("[PromptTemplates] Family lookup failed; matching without one:", error)
		return undefined
	}
}

export async function resolveSessionPromptTemplate(
	options: ResolvePromptTemplateOptions,
): Promise<ResolvedSessionPromptTemplate> {
	const family = await resolveFamily(options)

	// The directories, the matching and the merge over `default.md` live in
	// core, so this host and the CLI resolve the same template from the same
	// rules. They did not: the CLI resolved none at all, and a local model read
	// a different prompt depending on which host started it.
	const { rendered, errors, warnings } = resolveSessionPromptTemplateFrom({
		providerId: options.providerId,
		modelId: options.modelId,
		family,
		globalDir: resolveGlobalTemplateDirectory(),
		workspaceDir: options.workspaceRoot ? resolveWorkspaceTemplateDirectory(options.workspaceRoot) : undefined,
		knownToolNames: options.knownToolNames,
	})

	for (const error of errors) {
		Logger.warn(`[PromptTemplates] ${error.fileName} was skipped: ${error.message}`)
	}
	for (const file of warnings) {
		for (const warning of file.warnings) {
			Logger.log(`[PromptTemplates] ${file.fileName} (${warning.section}): ${warning.message}`)
		}
	}
	Logger.log(describeResolvedPromptTemplate({ modelId: options.modelId, family }, rendered))

	return { rendered, family, errors, warnings }
}

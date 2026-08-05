import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	PromptTemplate,
	PromptTemplateSource,
	PromptTemplateWarning,
} from "@cline/shared";
import { parsePromptTemplate } from "./prompt-template-parser";

/**
 * Load prompt templates from the three places they can live.
 *
 * Builtin templates ship with the package and are always present. A global
 * directory holds the user's own, which is where most of them belong — a Qwen
 * template is about Qwen, not about one repository. A workspace directory
 * holds the ones a project wants to pin and commit, and those shadow the
 * global templates of the same name.
 *
 * A file that fails to parse is reported and skipped, never thrown: one stray
 * colon in one template must not stop a session from starting, and the
 * settings UI needs the message to show which file is broken.
 */

/**
 * Directory name for both the global and the workspace template stores —
 * `<cline data dir>/templates` and `<workspace>/.clinerules/templates`. The
 * host joins it onto the root it knows.
 */
export const PROMPT_TEMPLATES_DIRECTORY_NAME = "templates";

export interface PromptTemplateLoadError {
	filePath: string;
	fileName: string;
	source: PromptTemplateSource;
	message: string;
}

/**
 * A non-fatal problem in a template that loaded anyway.
 *
 * Carried per file rather than folded into one list, because the only useful
 * thing to do with a warning is show it next to the file it came from and
 * offer to open it.
 */
export interface PromptTemplateFileWarnings {
	filePath: string;
	fileName: string;
	source: PromptTemplateSource;
	warnings: PromptTemplateWarning[];
}

export interface PromptTemplateLoadResult {
	templates: PromptTemplate[];
	errors: PromptTemplateLoadError[];
	warnings: PromptTemplateFileWarnings[];
}

export interface PromptTemplateDirectory {
	path: string;
	source: PromptTemplateSource;
}

/**
 * Read one directory of `*.md` templates.
 *
 * A directory that does not exist is not an error — most users will never
 * create one, and the builtin templates are enough on their own.
 */
export function loadPromptTemplatesFromDirectory(
	directory: PromptTemplateDirectory,
	options: { knownToolNames?: readonly string[] } = {},
): PromptTemplateLoadResult {
	const templates: PromptTemplate[] = [];
	const errors: PromptTemplateLoadError[] = [];
	const warnings: PromptTemplateFileWarnings[] = [];

	let fileNames: string[];
	try {
		fileNames = readdirSync(directory.path);
	} catch {
		return { templates, errors, warnings };
	}

	for (const fileName of fileNames
		.filter((name) => name.endsWith(".md"))
		.sort()) {
		const filePath = join(directory.path, fileName);
		let raw: string;
		try {
			raw = readFileSync(filePath, "utf8");
		} catch (error) {
			errors.push({
				filePath,
				fileName,
				source: directory.source,
				message: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		const result = parsePromptTemplate({
			raw,
			source: directory.source,
			fileName,
			filePath,
			knownToolNames: options.knownToolNames,
		});
		if (result.template) {
			templates.push(result.template);
			if (result.warnings.length > 0) {
				warnings.push({
					filePath,
					fileName,
					source: directory.source,
					warnings: result.warnings,
				});
			}
		} else {
			errors.push({
				filePath,
				fileName,
				source: directory.source,
				message: result.error,
			});
		}
	}

	return { templates, errors, warnings };
}

/**
 * Read every directory, nearest source last.
 *
 * Order matters downstream: `shadowPromptTemplates` keeps the last template of
 * a given name, and `resolvePromptTemplate` breaks specificity ties towards the
 * nearer source. Both agree that workspace beats global beats builtin, so the
 * directories are read in that order and the list is left in it.
 */
export function loadPromptTemplates(
	directories: readonly PromptTemplateDirectory[],
	options: { knownToolNames?: readonly string[] } = {},
): PromptTemplateLoadResult {
	const templates: PromptTemplate[] = [];
	const errors: PromptTemplateLoadError[] = [];
	const warnings: PromptTemplateFileWarnings[] = [];
	for (const directory of directories) {
		const result = loadPromptTemplatesFromDirectory(directory, options);
		templates.push(...result.templates);
		errors.push(...result.errors);
		warnings.push(...result.warnings);
	}
	return { templates, errors, warnings };
}

/**
 * The directories a session reads, in the order it reads them.
 *
 * `builtinDir` is resolved by the host, because where the package's own assets
 * land depends on how it was bundled, and core should not guess.
 */
export function resolvePromptTemplateDirectories(options: {
	builtinDir?: string;
	globalDir?: string;
	workspaceDir?: string;
}): PromptTemplateDirectory[] {
	const directories: PromptTemplateDirectory[] = [];
	if (options.builtinDir) {
		directories.push({ path: options.builtinDir, source: "builtin" });
	}
	if (options.globalDir) {
		directories.push({ path: options.globalDir, source: "global" });
	}
	if (options.workspaceDir) {
		directories.push({ path: options.workspaceDir, source: "workspace" });
	}
	return directories;
}

import { mkdirSync, writeFileSync } from "node:fs"
import {
	getBuiltinPromptTemplateSource,
	getBuiltinPromptTemplates,
	loadPromptTemplates,
	resolvePromptTemplateDirectories,
} from "@cline/core"
import { type PromptTemplate, type PromptTemplateSource, renderPromptTemplate } from "@cline/shared"
import { fileExistsAtPath } from "@utils/fs"
import * as path from "path"
import { resolveOllamaModelFamily } from "./ollama-model-family"
import { resolveGlobalTemplateDirectory, resolveWorkspaceTemplateDirectory } from "./prompt-templates"

/**
 * What the settings panel needs to know about prompt templates.
 *
 * A session resolves exactly one template and never looks at the rest, which is
 * the right answer for a session and the wrong one for a settings panel: a user
 * deciding whether to write a template needs to see the ones that already
 * exist, which of them the current model lands on, and which files are broken.
 * So this walks the same directories with the same loader and reports all of
 * it, rather than only the winner.
 */

export interface PromptTemplateEntry {
	name: string
	fileName: string
	source: PromptTemplateSource
	/** Absent for a builtin, which lives in the bundle rather than on disk. */
	filePath?: string
	/** The template this provider and model resolve to right now. */
	active: boolean
	/** Shadowed by a nearer template of the same name, so it never matches. */
	shadowed: boolean
	/** Match rules, rendered for display: `family: gemma*`. */
	match: string[]
	/** Tool descriptions this template overrides. */
	tools: string[]
	hasSystem: boolean
	warnings: string[]
	/** Set instead of everything else when the file did not parse. */
	error?: string
}

export interface PromptTemplateSettings {
	providerId: string
	modelId: string
	/** What the provider says the model is, when it can say. */
	family?: string
	/** The resolved template's name, absent only if nothing loaded at all. */
	activeName?: string
	/** Whether the active template is layered over `default.md`. */
	overlaid: boolean
	globalDirectory: string
	workspaceDirectory?: string
	templates: PromptTemplateEntry[]
}

export interface ReadPromptTemplateSettingsOptions {
	providerId: string
	modelId: string
	workspaceRoot?: string
	baseUrl?: string
	knownToolNames?: readonly string[]
}

function describeMatch(template: PromptTemplate): string[] {
	const parts: string[] = []
	for (const [dimension, patterns] of [
		["provider", template.match?.provider],
		["family", template.match?.family],
		["model", template.match?.model],
	] as const) {
		if (patterns && patterns.length > 0) {
			parts.push(`${dimension}: ${patterns.join(", ")}`)
		}
	}
	// A template with no rules is the base layer, not an unmatched one.
	return parts.length > 0 ? parts : ["any model"]
}

export async function readPromptTemplateSettings(options: ReadPromptTemplateSettingsOptions): Promise<PromptTemplateSettings> {
	const globalDirectory = resolveGlobalTemplateDirectory()
	const workspaceDirectory = options.workspaceRoot ? resolveWorkspaceTemplateDirectory(options.workspaceRoot) : undefined

	let family: string | undefined
	if (options.providerId === "ollama" && options.baseUrl) {
		family = await resolveOllamaModelFamily(options.baseUrl, options.modelId).catch(() => undefined)
	}

	const { templates, errors, warnings } = loadPromptTemplates(
		resolvePromptTemplateDirectories({ globalDir: globalDirectory, workspaceDir: workspaceDirectory }),
		{ knownToolNames: options.knownToolNames },
	)
	const all = [...getBuiltinPromptTemplates(), ...templates]
	const rendered = renderPromptTemplate(all, {
		providerId: options.providerId,
		modelId: options.modelId,
		family,
	})

	// Shadowing keeps the *last* template of a name, and `all` is already in
	// builtin → global → workspace order, so anything with a later namesake is
	// dead weight the user should be able to see is dead weight.
	const lastIndexByName = new Map<string, number>()
	all.forEach((template, index) => {
		lastIndexByName.set(template.name.trim().toLowerCase(), index)
	})

	const warningsByPath = new Map(warnings.map((file) => [file.filePath, file.warnings.map((w) => w.message)]))

	const entries: PromptTemplateEntry[] = all.map((template, index) => ({
		name: template.name,
		fileName: template.fileName,
		source: template.source,
		filePath: template.filePath,
		active:
			rendered !== undefined &&
			rendered.name === template.name &&
			rendered.source === template.source &&
			rendered.filePath === template.filePath,
		shadowed: lastIndexByName.get(template.name.trim().toLowerCase()) !== index,
		match: describeMatch(template),
		tools: Object.keys(template.tools).sort(),
		hasSystem: template.system !== undefined,
		warnings: template.filePath ? (warningsByPath.get(template.filePath) ?? []) : [],
	}))

	// Broken files are listed too. They are the ones most in need of an Edit
	// button, and leaving them out would make a template the user just wrote
	// look as though it had never been read.
	for (const error of errors) {
		entries.push({
			name: error.fileName.replace(/\.md$/, ""),
			fileName: error.fileName,
			source: error.source,
			filePath: error.filePath,
			active: false,
			shadowed: false,
			match: [],
			tools: [],
			hasSystem: false,
			warnings: [],
			error: error.message,
		})
	}

	return {
		providerId: options.providerId,
		modelId: options.modelId,
		family,
		activeName: rendered?.name,
		overlaid: rendered?.overlaid ?? false,
		globalDirectory,
		workspaceDirectory,
		templates: entries,
	}
}

/**
 * The path to open when the user asks to edit a template.
 *
 * A builtin has no path, so editing one means copying it into the global
 * directory first — verbatim, comments included, so the copy reads like the
 * original. The copy shadows the builtin by name, which is exactly the
 * behaviour the user is asking for by pressing Edit on it.
 */
export async function resolvePromptTemplateEditPath(fileName: string, filePath?: string): Promise<string> {
	if (filePath) {
		return filePath
	}

	const source = getBuiltinPromptTemplateSource(fileName)
	if (source === undefined) {
		throw new Error(`No template named ${fileName}`)
	}

	const directory = resolveGlobalTemplateDirectory()
	const target = path.join(directory, fileName)
	// Never overwrite. If a copy is already there the builtin is shadowed and
	// the user's own edits are what they want to open.
	if (!(await fileExistsAtPath(target))) {
		mkdirSync(directory, { recursive: true })
		writeFileSync(target, source, "utf8")
	}
	return target
}

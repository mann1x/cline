import { mkdirSync, writeFileSync } from "node:fs"
import {
	getBuiltinPromptTemplateSource,
	getBuiltinPromptTemplates,
	loadPromptTemplates,
	resolvePromptTemplateDirectories,
} from "@cline/core"
import {
	isOllamaNativeProvider,
	type PromptTemplate,
	type PromptTemplateSource,
	promptTemplateMatchBlocks,
	renderPromptTemplate,
} from "@cline/shared"
import { fileExistsAtPath } from "@utils/fs"
import * as path from "path"
import { resolveOllamaModelFamily } from "./ollama-model-family"
import { withOllamaNativeDefault } from "./ollama-native"
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

/**
 * Which template one configured model scope resolves to.
 *
 * The panel used to answer this for the session's model and no other, which
 * made the one question it exists to answer -- "did that file take effect" --
 * unanswerable for every other model the task runs. A subagent, and an expert
 * especially, is usually a different model of a different family; the expert
 * is also the one most likely to be reached through a cloud tag, which reports
 * no family and until 2026-09-14 landed silently on `default.md`.
 */
export interface PromptTemplateScopeMapping {
	/** What the tab is called, e.g. "Escalation". */
	scope: string
	providerId: string
	modelId: string
	/** What the provider says the model is, when it can say. */
	family?: string
	/** The template it resolves to. Absent when nothing loaded at all. */
	templateName?: string
	/** Whether that template is layered over `default.md`. */
	overlaid: boolean
	/**
	 * Nothing claimed it, so it is running on the base layer.
	 *
	 * Called out separately because it is not visible from the name: the
	 * template is `default` either way, and a reader cannot tell the model that
	 * was claimed by the base layer from the one that fell through to it.
	 */
	fallback: boolean
}

/** A scope the caller wants resolved, before it has been. */
export interface PromptTemplateScopeRequest {
	scope: string
	providerId: string
	modelId: string
	baseUrl?: string
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
	/** Every configured scope, the session's included, in display order. */
	scopes: PromptTemplateScopeMapping[]
}

export interface ReadPromptTemplateSettingsOptions {
	providerId: string
	modelId: string
	workspaceRoot?: string
	baseUrl?: string
	knownToolNames?: readonly string[]
	/**
	 * The other models this task can run, each resolved on its own.
	 *
	 * Supplied by the caller rather than read here: which scopes are configured
	 * is a question about the settings store, and this module's job is the
	 * template directories.
	 */
	scopes?: readonly PromptTemplateScopeRequest[]
}

function describeMatch(template: PromptTemplate): string[] {
	const parts: string[] = []
	// Every rung of the claim, in the order they are written. A ladder reads as
	// `model: qwen*` then `family: qwen*`, which is what it is: either one
	// claims the session, and the panel would be lying if it showed only the
	// first. Two rungs naming the same dimension are joined with "or" so the
	// line cannot be read as an AND.
	const blocks = promptTemplateMatchBlocks(template.match)
	for (const block of blocks) {
		for (const [dimension, patterns] of [
			["provider", block.provider],
			["family", block.family],
			["model", block.model],
		] as const) {
			if (patterns && patterns.length > 0) {
				parts.push(`${dimension}: ${patterns.join(", ")}`)
			}
		}
	}
	// A template with no rules is the base layer, not an unmatched one.
	return parts.length > 0 ? parts : ["any model"]
}

export async function readPromptTemplateSettings(options: ReadPromptTemplateSettingsOptions): Promise<PromptTemplateSettings> {
	const globalDirectory = resolveGlobalTemplateDirectory()
	const workspaceDirectory = options.workspaceRoot ? resolveWorkspaceTemplateDirectory(options.workspaceRoot) : undefined

	// The panel has to agree with the session about which template is active,
	// so it resolves the family the same way: an unset base URL is Ollama's
	// default endpoint rather than a reason to skip the lookup.
	let family: string | undefined
	if (isOllamaNativeProvider(options.providerId)) {
		family = await resolveOllamaModelFamily(
			withOllamaNativeDefault(options.providerId, options.baseUrl),
			options.modelId,
		).catch(() => undefined)
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

	// Every other model this task can run, resolved against the same set. The
	// family lookup is per scope because it is per model: an expert on a cloud
	// tag reports none, and that is exactly the case worth showing.
	const scopes: PromptTemplateScopeMapping[] = []
	for (const request of options.scopes ?? []) {
		const scopeFamily = isOllamaNativeProvider(request.providerId)
			? await resolveOllamaModelFamily(withOllamaNativeDefault(request.providerId, request.baseUrl), request.modelId).catch(
					() => undefined,
				)
			: undefined
		const scopeRendered = renderPromptTemplate(all, {
			providerId: request.providerId,
			modelId: request.modelId,
			family: scopeFamily,
		})
		scopes.push({
			scope: request.scope,
			providerId: request.providerId,
			modelId: request.modelId,
			family: scopeFamily,
			templateName: scopeRendered?.name,
			overlaid: scopeRendered?.overlaid ?? false,
			// `overlaid` is false both for a model the base layer claimed and
			// for one that nothing claimed, so the name alone cannot tell them
			// apart. This is the second case, said out loud.
			fallback: scopeRendered !== undefined && !scopeRendered.overlaid,
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
		scopes,
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

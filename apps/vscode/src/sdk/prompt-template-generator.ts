import { mkdirSync, writeFileSync } from "node:fs"
import {
	generatePromptTemplate,
	getBuiltinPromptTemplateSource,
	getBuiltinPromptTemplates,
	getShippedToolCallSignatures,
} from "@cline/core"
import { DEFAULT_PROMPT_TEMPLATE_NAME, renderPromptTemplate } from "@cline/shared"
import { fileExistsAtPath } from "@utils/fs"
import * as path from "path"
import type { ApiConfiguration } from "@/shared/api"
import { Logger } from "@/shared/services/Logger"
import type { Mode } from "@/shared/storage/types"
import { resolveGlobalTemplateDirectory } from "./prompt-templates"
import { buildApiHandler } from "./sdk-api-handler"

/**
 * Generate a prompt template for whichever model the user has selected.
 *
 * The review script exists because the shipped templates were written by us and
 * a model reads differently from how we imagine it does. That reasoning does
 * not stop at the models we happened to test: a user running a freshly merged
 * local model, or a provider we have never seen, has exactly the same problem
 * and no way to solve it. This is the same generation, driven from the settings
 * panel, against the model already configured.
 *
 * Nothing here is Ollama-specific. The family is an Ollama nicety — it is the
 * only provider that reports one — and everywhere else the generated template
 * matches on the provider and model instead.
 */

/** The tool prompts a generated template is required to address. */
const REQUIRED_MENTIONS = ["check_file", "code_intel"]

/** Tries, including the first. Each retry hands the model its own problems. */
const ATTEMPTS = 3

export interface GenerateTemplateOptions {
	providerId: string
	modelId: string
	mode: Mode
	apiConfiguration: ApiConfiguration
	/** The family, when the provider reports one. Ollama only, today. */
	family?: string
	/** Where to write it. Defaults to the global template directory. */
	targetDirectory?: string
	onAttempt?: (attempt: number, problems: readonly string[]) => void
	signal?: AbortSignal
}

export interface GeneratedTemplate {
	filePath: string
	name: string
	attempts: number
	/** Empty when the proposal was clean; otherwise what is still wrong. */
	problems: string[]
}

/**
 * A template name that is about this model and collides with nothing.
 *
 * A generated template shadows a builtin of the same name, which would be a
 * surprising thing to do to someone who pressed "Generate" — so the name is
 * derived from the model rather than from the template it was based on.
 */
export function generatedTemplateName(providerId: string, modelId: string): string {
	const slug = `${providerId}-${modelId}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
	return slug === "" ? "generated" : slug.slice(0, 60)
}

/**
 * Turn one streamed completion into the string the generator expects.
 *
 * `createMessage` is the same path the commit-message generator uses, and the
 * same path a session uses, so a generated template comes from exactly the
 * model the user has configured — including its base URL, key and headers.
 */
function createCompletion(options: GenerateTemplateOptions) {
	// Reasoning is disabled for the same reason the commit-message generator
	// disables it: this is a one-shot transform, and some providers reject a
	// request carrying both reasoning fields.
	const apiHandler = buildApiHandler(options.apiConfiguration, options.mode, { disableReasoning: true })

	return async (messages: readonly { role: "user" | "assistant"; content: string }[]): Promise<string> => {
		const [first, ...rest] = messages
		if (!first) {
			throw new Error("No prompt to send.")
		}
		// The instructions are the whole first message; there is no separate
		// system prompt to split out, and inventing one would change what every
		// other caller of this generator sends.
		const stream = apiHandler.createMessage(
			"",
			[first, ...rest].map((message) => ({ ...message })),
		)

		let reply = ""
		let streamError: string | undefined
		for await (const chunk of stream) {
			options.signal?.throwIfAborted()
			if (chunk.type === "text") {
				reply += chunk.text
			} else if (chunk.type === "done" && chunk.success === false) {
				streamError = chunk.error
			}
		}
		if (reply.trim() === "" && streamError) {
			throw new Error(streamError)
		}
		return reply
	}
}

export async function generateTemplateForModel(options: GenerateTemplateOptions): Promise<GeneratedTemplate> {
	const builtins = getBuiltinPromptTemplates()
	const defaultTemplate = getBuiltinPromptTemplateSource("default.md")
	if (!defaultTemplate) {
		throw new Error("The default template is missing from this build.")
	}

	// What this model is given today, which is what it is being asked to
	// improve on. When nothing claims it, it writes a template from the base.
	const rendered = renderPromptTemplate(builtins, {
		providerId: options.providerId,
		modelId: options.modelId,
		family: options.family,
	})
	const basedOn =
		rendered && rendered.name.toLowerCase() !== DEFAULT_PROMPT_TEMPLATE_NAME
			? builtins.find((template) => template.name === rendered.name)
			: undefined
	const familyTemplate = basedOn ? getBuiltinPromptTemplateSource(basedOn.fileName) : undefined

	const knownToolNames = Object.keys(
		builtins.find((template) => template.name.toLowerCase() === DEFAULT_PROMPT_TEMPLATE_NAME)?.tools ?? {},
	)

	const name = generatedTemplateName(options.providerId, options.modelId)
	const result = await generatePromptTemplate({
		defaultTemplate,
		familyTemplate,
		familyFileName: basedOn?.fileName,
		providerId: options.providerId,
		modelId: options.modelId,
		family: options.family,
		knownToolNames,
		toolSignatures: getShippedToolCallSignatures(),
		requiredMentions: REQUIRED_MENTIONS,
		// No expected name: this is a new template, so the model is free to
		// name it, and the name is normalised below either way.
		fileName: `${name}.md`,
		attempts: ATTEMPTS,
		complete: createCompletion(options),
		onAttempt: options.onAttempt,
	})

	const directory = options.targetDirectory ?? resolveGlobalTemplateDirectory()
	mkdirSync(directory, { recursive: true })
	const filePath = await uniquePath(directory, name)
	writeFileSync(filePath, `${withName(result.raw, name)}\n`, "utf8")

	Logger.log(
		`[PromptTemplates] Generated ${filePath} for ${options.providerId}/${options.modelId} in ${result.attempts} attempt(s)`,
	)
	return {
		filePath,
		name,
		attempts: result.attempts,
		problems: result.audit.problems,
	}
}

/**
 * Force the frontmatter name, so the file the user sees is the file the
 * resolver will pick. A model asked to name its own template picks something
 * reasonable and occasionally something that collides with a builtin.
 */
function withName(raw: string, name: string): string {
	if (/^---\r?\n/.test(raw)) {
		return /^name:/m.test(raw) ? raw.replace(/^name:.*$/m, `name: ${name}`) : raw.replace(/^---\r?\n/, `---\nname: ${name}\n`)
	}
	return `---\nname: ${name}\n---\n\n${raw}`
}

/** Never overwrite a template the user may have edited. */
async function uniquePath(directory: string, name: string): Promise<string> {
	const first = path.join(directory, `${name}.md`)
	if (!(await fileExistsAtPath(first))) {
		return first
	}
	for (let suffix = 2; suffix < 100; suffix++) {
		const candidate = path.join(directory, `${name}-${suffix}.md`)
		if (!(await fileExistsAtPath(candidate))) {
			return candidate
		}
	}
	throw new Error(`Too many generated templates named ${name}.`)
}

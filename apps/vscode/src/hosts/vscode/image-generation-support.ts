import * as nodeFs from "node:fs/promises"
import * as nodePath from "node:path"
import type { ImageGenerationEndpoint } from "@cline/core"
import * as vscode from "vscode"
import { expandEnvironmentVariables } from "@/utils/envExpansion"

/**
 * Where `generate_image` sends its requests, or nothing.
 *
 * A VS Code setting rather than extension state, for the same reasons
 * `cline.lintCommand` and `cline.browserTool` are: visible in the Settings UI,
 * editable in `settings.json`, and overridable per workspace -- which matters
 * here, because the endpoint is a machine-local service on one machine and a
 * paid API on another.
 *
 * Read per call rather than captured at session start, so changing the setting
 * takes effect on the next tool call rather than the next window.
 */
export function readImageGenerationEndpoint(): ImageGenerationEndpoint | undefined {
	const config = vscode.workspace.getConfiguration("cline.imageGeneration")
	const baseUrl = config.get<string>("endpoint")?.trim()
	const model = config.get<string>("model")?.trim()
	// Both or neither: an endpoint with no model cannot be called, and a model
	// with no endpoint has nowhere to go. Offering the tool on half a
	// configuration only moves the failure to where the model has to explain it.
	if (!baseUrl || !model) {
		return undefined
	}

	// `${env:OPENAI_API_KEY}`, so a key need not be written into a settings
	// file that syncs and gets committed.
	const apiKey = expandEnvironmentVariables(config.get<string>("apiKey")?.trim() || "")
	const size = config.get<string>("size")?.trim()

	return {
		baseUrl,
		model,
		...(apiKey ? { apiKey } : {}),
		...(size ? { size } : {}),
	}
}

/** Whether the `generate_image` tool should be offered at all. */
export function isImageGenerationConfigured(): boolean {
	return readImageGenerationEndpoint() !== undefined
}

/**
 * Write the image, creating the directory it goes in.
 *
 * The default path is under `.cline/generated-images/`, which will not exist on
 * a fresh workspace, and a tool that fails on its own default is a tool nobody
 * uses twice.
 */
export async function writeGeneratedImage(absolutePath: string, data: Buffer): Promise<void> {
	await nodeFs.mkdir(nodePath.dirname(absolutePath), { recursive: true })
	await nodeFs.writeFile(absolutePath, data)
}

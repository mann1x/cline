import type { AgentImageToDescribe } from "@cline/shared"
import type { ApiConfiguration } from "@shared/api"
import { parseApiConfigurationSnapshot } from "@shared/api-config-profiles"
import { applyApiConfigurationSnapshot } from "@shared/api-config-snapshot"
import { Logger } from "@shared/services/Logger"
import { SecretKeys } from "@shared/storage/state-keys"
import { visionProviderId } from "@shared/vision-provider-id"
import { buildApiHandler } from "./sdk-api-handler"

/**
 * A second model that reads images so the primary model does not have to.
 *
 * Two reasons a user wants this. One is that the primary model cannot accept
 * images at all — DeepSeek on Ollama Cloud fails the whole request when a
 * browser screenshot arrives. The other is that it accepts them and is bad at
 * them, which is worse, because nothing reports an error. Either way the answer
 * is the same: hand the image to a model chosen for the job and give the
 * primary model its description.
 */

const VISION_SYSTEM_PROMPT =
	"You are describing an image for another AI model that cannot see it. " +
	"That model is working on a software task and will act on your description alone. " +
	"Report what is actually on screen: layout and where things sit relative to each other, " +
	"all readable text quoted exactly, the state of any controls, and anything that looks broken, " +
	"misaligned, cut off, or reported as an error. " +
	"Be specific and complete, and do not speculate about what the code behind it might be doing. " +
	"Write plain prose with no preamble."

/** Guards against a describer that never returns and stalls the whole turn. */
const VISION_REQUEST_TIMEOUT_MS = 120_000

/**
 * Rebuilds the vision model's configuration from its stored snapshot.
 *
 * Returns `undefined` when no vision model has been configured, which is the
 * signal not to install a describer at all. API keys are not part of a
 * snapshot — they are stored per provider and shared — so they are taken from
 * the primary configuration.
 */
export function buildVisionApiConfiguration(
	primary: ApiConfiguration | undefined,
	storedSnapshot: string | undefined,
): ApiConfiguration | undefined {
	const snapshot = parseApiConfigurationSnapshot(storedSnapshot)
	if (!snapshot) {
		return undefined
	}
	const settings = applyApiConfigurationSnapshot(snapshot, ["plan", "act"]) as Record<string, unknown>
	if (!settings.actModeApiProvider) {
		return undefined
	}
	const secrets: Record<string, unknown> = {}
	for (const key of SecretKeys as readonly string[]) {
		secrets[key] = (primary as Record<string, unknown> | undefined)?.[key]
	}
	return { ...secrets, ...settings } as ApiConfiguration
}

/**
 * Builds the callback the agent runtime uses to turn images into text.
 *
 * Images are described one request at a time rather than all in one: a local
 * model's context is the binding constraint here, and three screenshots in one
 * prompt is how a description turns into a summary of the last one. A failure
 * on one image is reported as `undefined` for that image only, so the rest of
 * the batch still gets through.
 */
export function createVisionImageDescriber(
	configuration: ApiConfiguration,
): (images: readonly AgentImageToDescribe[]) => Promise<readonly (string | undefined)[]> {
	return async (images) => {
		// Built from the vision tab's own provider entry, so the base URL,
		// context window and sampler are the ones configured for this model
		// rather than the primary model's.
		const provider = (configuration as Record<string, unknown>).actModeApiProvider
		const handler = buildApiHandler(configuration, "act", {
			providerSettingsId: typeof provider === "string" ? visionProviderId(provider) : undefined,
		})
		const descriptions: (string | undefined)[] = []
		for (const image of images) {
			descriptions.push(await describeOne(handler, image))
		}
		return descriptions
	}
}

async function describeOne(
	handler: ReturnType<typeof buildApiHandler>,
	image: AgentImageToDescribe,
): Promise<string | undefined> {
	const content: Array<Record<string, unknown>> = [
		{
			type: "text",
			text: image.context
				? `Describe this image. For context, the tool that produced it also reported:\n\n${image.context}`
				: "Describe this image.",
		},
		{ type: "image", data: image.image, mediaType: image.mediaType ?? "image/png" },
	]

	const abort = new AbortController()
	const timeout = setTimeout(() => abort.abort(), VISION_REQUEST_TIMEOUT_MS)
	try {
		handler.setAbortSignal?.(abort.signal)
		const stream = handler.createMessage(VISION_SYSTEM_PROMPT, [{ role: "user", content } as never])
		let text = ""
		let streamError: string | undefined
		for await (const chunk of stream) {
			if (chunk.type === "text") {
				text += chunk.text
			} else if (chunk.type === "done" && chunk.success === false) {
				streamError = chunk.error
			}
		}
		if (streamError) {
			Logger.warn(`[Vision] Vision model failed to describe an image: ${streamError}`)
			return undefined
		}
		const trimmed = text.trim()
		if (!trimmed) {
			Logger.warn("[Vision] Vision model returned an empty description")
			return undefined
		}
		return trimmed
	} catch (error) {
		Logger.warn(`[Vision] Vision model request failed: ${error instanceof Error ? error.message : String(error)}`)
		return undefined
	} finally {
		clearTimeout(timeout)
		handler.setAbortSignal?.(undefined)
	}
}

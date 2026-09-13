import type { AgentImageToDescribe } from "@cline/shared"
import type { ApiConfiguration } from "@shared/api"
import { parseApiConfigurationSnapshot } from "@shared/api-config-profiles"
import { type ApiConfigurationSnapshot, applyApiConfigurationSnapshot } from "@shared/api-config-snapshot"
import { snapshotProviderId } from "@shared/model-scope-config"
import { Logger } from "@shared/services/Logger"
import { getProviderModelIdKey } from "@shared/storage/provider-keys"
import { SecretKeys } from "@shared/storage/state-keys"
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
 * Rebuilds a scoped model's configuration from its stored snapshot.
 *
 * Used by both tabs that name a model other than the session's: Vision and
 * Agents. Returns `undefined` when the tab names no provider, which is the
 * signal to leave the session's own arrangement alone — no describer installed,
 * or delegated agents still inheriting the lead's connection.
 *
 * API keys are not part of a snapshot — they are stored per provider and shared
 * — so they are taken from the primary configuration.
 */
export function buildScopedApiConfiguration(
	primary: ApiConfiguration | undefined,
	storedSnapshot: string | undefined,
): ApiConfiguration | undefined {
	const snapshot = parseApiConfigurationSnapshot(storedSnapshot)
	if (!snapshot) {
		return undefined
	}
	const settings = applyApiConfigurationSnapshot(snapshot, ["plan", "act"]) as Record<string, unknown>
	// The same question the chat UI asks before it lets an image be attached.
	// Asked here through the shared helper so the two cannot answer differently
	// — that disagreement is what sent an image to a model that refused it.
	if (!snapshotProviderId(storedSnapshot)) {
		return undefined
	}
	const secrets: Record<string, unknown> = {}
	for (const key of SecretKeys as readonly string[]) {
		secrets[key] = (primary as Record<string, unknown> | undefined)?.[key]
	}
	// The picker's model, written into the keys the handler reads.
	//
	// Two fields name the model of a scoped tab: `providerConfig.selectedModelId`,
	// which the tab's picker writes, and the mode keys, which are what
	// `buildApiHandler` reads. Nothing kept them in step, and the picker's copy
	// was passed on separately as provider settings -- where it supplies the
	// context window and the sampler, and never the model.
	//
	// Measured on a snapshot a tester dumped (#43): `selectedModelId` was his
	// vision model and `mode.ollamaModelId` was the primary one, DeepSeek, which
	// cannot read images. So the describer was built, logged the picked model's
	// name -- that line reads `selectedModelId` -- and sent every request to
	// DeepSeek, which refused it. The image was then dropped and the run carried
	// on: "it says it removed the image from the context and then just keeps
	// going", reported against four builds in a row.
	//
	// Only when the picker names something. A tab configured through the settings
	// fields alone has no `selectedModelId`, and its mode keys are the only thing
	// naming a model.
	const pickedModelId = snapshotModelIdFromPicker(snapshot)
	const provider = snapshotProviderId(storedSnapshot)
	if (pickedModelId && provider) {
		settings[getProviderModelIdKey(provider, "act")] = pickedModelId
		settings[getProviderModelIdKey(provider, "plan")] = pickedModelId
	}
	return { ...secrets, ...settings } as ApiConfiguration
}

/**
 * The model a tab's picker wrote, and only that.
 *
 * Deliberately not `snapshotModelId`, which falls back to the mode keys: here
 * the mode keys are what is being corrected, so a fallback to them would make
 * this a no-op in exactly the case it exists for.
 */
function snapshotModelIdFromPicker(snapshot: ApiConfigurationSnapshot): string | undefined {
	const held = snapshot.providerConfig as Record<string, unknown> | undefined
	const selected = held?.selectedModelId
	return typeof selected === "string" && selected ? selected : undefined
}

/** The vision model's configuration. See `buildScopedApiConfiguration`. */
export const buildVisionApiConfiguration = buildScopedApiConfiguration

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
	visionProviderSettings?: Record<string, unknown>,
): (images: readonly AgentImageToDescribe[]) => Promise<readonly (string | undefined)[]> {
	return async (images) => {
		// Built from the vision tab's own provider entry, so the base URL,
		// context window and sampler are the ones configured for this model
		// rather than the primary model's.
		const handler = buildApiHandler(configuration, "act", {
			visionProviderSettings,
		})
		const descriptions: (string | undefined)[] = []
		for (const image of images) {
			descriptions.push(await describeOne(handler, image))
		}
		// The one line that separates "no describer was installed" from "the
		// describer ran and came back empty". Both end with the images dropped and
		// the task carrying on, and until now the log could not tell them apart —
		// which is what made this take three rounds. Counts only.
		const described = descriptions.filter((description) => description !== undefined).length
		Logger.log(`[Vision] Described ${described} of ${images.length} image(s)`)
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

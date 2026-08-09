import type { AgentImageToDescribe, BasicLogger } from "@cline/shared";
import { createAgentModelFromConfig } from "@cline/core";
import type { Config } from "../utils/types";

/**
 * A second model that reads images so the session's model does not have to.
 *
 * The extension has had this since 4.100.20 and the CLI has not, which meant
 * the one scenario a tester kept reporting could not be reproduced anywhere it
 * could be watched closely — no image flag, no describer, no way to run it
 * headlessly. The CLI already loads `@./shot.png` mentions into `userImages`;
 * this supplies the other half.
 *
 * The vision model is built from the session's own provider and base URL with
 * the model id swapped, so `--vision-model` names a model on the provider
 * already in use rather than opening a second provider configuration.
 */

const VISION_SYSTEM_PROMPT =
	"You are describing an image for another AI model that cannot see it. " +
	"That model is working on a software task and will act on your description alone. " +
	"Report what is actually on screen: layout and where things sit relative to each other, " +
	"all readable text quoted exactly, the state of any controls, and anything that looks broken, " +
	"misaligned, cut off, or reported as an error. " +
	"Be specific and complete, and do not speculate about what the code behind it might be doing. " +
	"Write plain prose with no preamble.";

/** Guards against a describer that never returns and stalls the whole turn. */
const VISION_REQUEST_TIMEOUT_MS = 120_000;

export function createCliImageDescriber(
	config: Config,
	visionModelId: string,
	logger?: BasicLogger,
): (
	images: readonly AgentImageToDescribe[],
) => Promise<readonly (string | undefined)[]> {
	return async (images) => {
		const model = createAgentModelFromConfig(
			{ ...config, modelId: visionModelId } as never,
			logger,
		);
		const descriptions: (string | undefined)[] = [];
		for (const image of images) {
			descriptions.push(await describeOne(model, image));
		}
		// The line that separates "no describer was installed" from "the describer
		// ran and came back empty". Counts only — the image and the text around it
		// are the user's.
		const described = descriptions.filter(
			(description) => description !== undefined,
		).length;
		logger?.log?.(`[Vision] Described ${described} of ${images.length} image(s)`);
		return descriptions;
	};
}

async function describeOne(
	model: ReturnType<typeof createAgentModelFromConfig>,
	image: AgentImageToDescribe,
): Promise<string | undefined> {
	const abort = new AbortController();
	const timeout = setTimeout(() => abort.abort(), VISION_REQUEST_TIMEOUT_MS);
	try {
		const stream = await model.stream({
			systemPrompt: VISION_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: image.context
								? `Describe this image. For context, the tool that produced it also reported:\n\n${image.context}`
								: "Describe this image.",
						},
						{
							type: "image",
							image: image.image,
							mediaType: image.mediaType ?? "image/png",
						},
					],
				},
			] as never,
			tools: [],
			signal: abort.signal,
		});
		let text = "";
		for await (const event of stream) {
			if (event.type === "text-delta") {
				text += event.text;
			}
		}
		return text.trim() || undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

import * as nodeFs from "node:fs/promises"
import * as nodePath from "node:path"

/**
 * Write the image, creating the directory it goes in.
 *
 * The default path is under `.cline/generated-images/`, which will not exist on
 * a fresh workspace, and a tool that fails on its own default is a tool nobody
 * uses twice.
 *
 * All that is left here: where the images go is the host's business, but where
 * they come from is not, and that reader moved to `src/sdk/` with the rest of
 * the code that reads extension state.
 */
export async function writeGeneratedImage(absolutePath: string, data: Buffer): Promise<void> {
	await nodeFs.mkdir(nodePath.dirname(absolutePath), { recursive: true })
	await nodeFs.writeFile(absolutePath, data)
}

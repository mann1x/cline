import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	type AgentTool,
	createMediaTools,
	type MediaSessionProvider,
	type MediaToolsConfig,
	parseMediaToolsConfig,
} from "@cline/core";

/**
 * The media tools, for a host with no settings tabs.
 *
 * The extension reads where `generate_image`, `edit_image`,
 * `transcribe_audio`, `synthesize_speech` and `generate_video` go from its
 * Images, Audio and Video tabs. This host reads the same thing from two
 * places, and hands it to the same builder in core, so a run here offers the
 * tools the plugin would for the same configuration:
 *
 * - `--media-provider` (or `CLINE_MEDIA_PROVIDER=1`): every media tool the
 *   session's own opencoti or xOllama serves. The plugin's "use the session's
 *   provider" box, ticked on every tab.
 * - `--media-config <file>` (or `CLINE_MEDIA_CONFIG`): a JSON document naming
 *   the endpoints, in the shape `parseMediaToolsConfig` documents.
 *
 * Neither given, no media tool is offered, which is the plugin with its three
 * boxes unticked.
 */
export interface CliMediaOptions {
	mediaProvider?: boolean;
	mediaConfig?: string;
}

export function mediaRequested(args: CliMediaOptions): boolean {
	return (
		args.mediaProvider === true ||
		process.env.CLINE_MEDIA_PROVIDER?.trim() === "1" ||
		!!(args.mediaConfig?.trim() || process.env.CLINE_MEDIA_CONFIG?.trim())
	);
}

/**
 * The configuration the flags name. A file that cannot be read or parsed is
 * an error rather than "no media": the run was asked for these tools.
 */
export async function readCliMediaConfig(
	args: CliMediaOptions,
	cwd: string,
): Promise<MediaToolsConfig> {
	const useProvider =
		args.mediaProvider === true ||
		process.env.CLINE_MEDIA_PROVIDER?.trim() === "1";
	const path =
		args.mediaConfig?.trim() || process.env.CLINE_MEDIA_CONFIG?.trim();
	let document: unknown = {};
	if (path) {
		const absolute = resolve(cwd, path);
		let raw: string;
		try {
			raw = await readFile(absolute, "utf8");
		} catch (error) {
			throw new Error(
				`--media-config: could not read ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		try {
			document = JSON.parse(raw);
		} catch (error) {
			throw new Error(
				`--media-config: ${absolute} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	// With the flag alone every tool is asked of the provider; with a file,
	// the file says which sections are on and the flag ticks their box.
	return parseMediaToolsConfig(document, { all: !path, useProvider });
}

export async function createCliMediaTools(options: {
	args: CliMediaOptions;
	cwd: string;
	provider: MediaSessionProvider;
	log?: (message: string) => void;
	onError?: (message: string, error: unknown) => void;
}): Promise<AgentTool[]> {
	if (!mediaRequested(options.args)) {
		return [];
	}
	const config = await readCliMediaConfig(options.args, options.cwd);
	return createMediaTools({
		cwd: options.cwd,
		getConfig: () => config,
		provider: options.provider,
		readFile: (absolutePath) => readFile(absolutePath),
		writeFile: async (absolutePath, data) => {
			await mkdir(dirname(absolutePath), { recursive: true });
			await writeFile(absolutePath, data);
		},
		onError: options.onError,
		log: options.log
			? (message) => options.log?.(`[media] ${message}`)
			: undefined,
	});
}

import { type AgentTool, createBrowserTool, createCodeIntelTool } from "@cline/core";
import { createCliBrowserDriver } from "./browser-support";
import { createCliCodeIntelProvider } from "./code-intel-support";

/**
 * The tools this host brings that core cannot build for itself.
 *
 * `check_file` and `list_files` are added by the local runtime host, because
 * everything they need is a filesystem. These two are not: `browser` needs a
 * Chrome and `code_intel` needs a language server, so each is assembled here
 * with its host half and handed over as an extra tool -- the same way the
 * extension hands over its own, built on VS Code instead.
 *
 * Both are unconditional, for the reason the extension gives for its own: the
 * reflex each displaces still happens when the tool is missing. A model that
 * cannot open a page asks the user whether it works; a model that cannot ask a
 * language server greps and reads six files to answer what the server would
 * have answered exactly. Neither starts anything at session start -- Chrome is
 * launched on the first `open`, a language server on the first question about a
 * file it serves -- so a session that uses neither pays nothing for having had
 * them.
 */
export function createCliHostTools(options: {
	cwd: string;
	onError?: (message: string, error: unknown) => void;
}): AgentTool[] {
	return [
		createBrowserTool({
			cwd: options.cwd,
			createDriver: () => createCliBrowserDriver(),
			onError: options.onError,
		}),
		createCodeIntelTool({
			cwd: options.cwd,
			provider: createCliCodeIntelProvider({
				cwd: options.cwd,
				onError: options.onError,
			}),
			onError: options.onError,
		}),
	];
}

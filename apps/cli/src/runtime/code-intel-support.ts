import {
	type CodeIntelProvider,
	createLspHost,
	DEFAULT_LSP_SERVERS,
	type LspHost,
	type LspServerSpec,
	languageIdFor,
} from "@cline/core";

/**
 * The CLI half of `ask_lsp`.
 *
 * In the extension this is a thin wrapper over VS Code, which already runs a
 * language server for every language in the workspace. A terminal runs none,
 * so core's `createLspHost` resolves a server per language, starts it on the
 * first question, and keeps it for the session. The host lives in core so
 * every host without an editor -- this one, automaticum's runner -- answers
 * the same question the same way.
 */

export { DEFAULT_LSP_SERVERS, languageIdFor };

export interface CliCodeIntelOptions {
	cwd: string;
	servers?: LspServerSpec[];
	onError?: (message: string, error: unknown) => void;
}

/** The session's language servers, for whatever wants more than `ask_lsp`. */
export function createCliLspHost(options: CliCodeIntelOptions): LspHost {
	return createLspHost({
		cwd: options.cwd,
		servers: options.servers ?? DEFAULT_LSP_SERVERS,
		onError: options.onError,
	});
}

export function createCliCodeIntelProvider(
	options: CliCodeIntelOptions,
): CodeIntelProvider {
	return createCliLspHost(options).provider;
}

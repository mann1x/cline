/**
 * The language-server client moved into core (`@cline/core`'s
 * `LspConnection`), where the CLI, automaticum's runner and any other host
 * without an editor share one copy. Re-exported so existing imports keep
 * working.
 */
export {
	fileUri,
	LspConnection,
	type LspServerSpec,
	uriToPath,
} from "@cline/core";

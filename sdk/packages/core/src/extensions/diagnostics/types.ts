/**
 * Diagnostics as an editor keeps them, in the shape every host hands over.
 *
 * The extension reads them from VS Code (its proto `FileDiagnostics`), the
 * CLI and automaticum's runner from the language servers they start. The
 * tools that read them -- `check_file`, the post-edit report -- are shared,
 * so the shape is core's: a named severity rather than either side's number
 * (VS Code's proto counts errors from 0, LSP from 1).
 */

export type DiagnosticSeverityName =
	| "error"
	| "warning"
	| "information"
	| "hint";

export interface DiagnosticPosition {
	/** 0-based, as LSP has it. */
	line: number;
	/** 0-based. */
	character: number;
}

export interface HostDiagnostic {
	message: string;
	severity: DiagnosticSeverityName;
	range?: { start?: DiagnosticPosition; end?: DiagnosticPosition };
	/** The producer, as the editor names it: "ts", "eslint", "css". */
	source?: string;
}

export interface HostFileDiagnostics {
	filePath: string;
	diagnostics: HostDiagnostic[];
	/**
	 * The file changed after its server last reported on it, so what is held
	 * describes an older text. A reader waiting for the server to settle keeps
	 * waiting while this is set. Hosts that cannot tell leave it out.
	 */
	pending?: boolean;
}

/** Reads every file's current diagnostics. */
export type ReadDiagnostics = () => Promise<HostFileDiagnostics[]>;

/**
 * Hands a server the file as it is on disk now (`save`: as just written), so
 * its next diagnostics are about that text. The editor does this itself; a
 * host that starts its own servers has to. Resolves to something truthy when
 * a server holds the file.
 */
export type TouchDocument = (
	filePath: string,
	options?: { save?: boolean },
) => Promise<unknown>;

/**
 * A file's text, as the host reads its disk. Injected where a host wants its
 * own view -- a sandbox, a test's fake disk -- and defaulted to the real one.
 */
export type ReadText = (filePath: string) => Promise<string>;

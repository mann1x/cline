/**
 * A UTF-8 byte order mark at the start of a file, kept out of every column.
 *
 * VS Code drops the mark from a document's text, so the language server's
 * diagnostics -- the line and column `check_file` reports -- number line 1
 * without it, and the model never sees an invisible character it could count.
 * The editor and the delimiter scan counted it as column 1, so on line 1 of
 * such a file every column they named or accepted was one off from the
 * checker's: "column 3" deleted the character before the one meant.
 *
 * Every tool that shows a file or addresses it by column strips the mark,
 * and every tool that writes puts it back, so the file keeps its encoding.
 */
export const BOM = "﻿";

export function splitBom(text: string): { bom: string; body: string } {
	return text.startsWith(BOM)
		? { bom: BOM, body: text.slice(BOM.length) }
		: { bom: "", body: text };
}

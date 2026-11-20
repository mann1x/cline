/**
 * The file an `editor` call is aimed at, from the call as the model wrote it.
 *
 * The model names the file `file_path`. It was `path` until 2026-10-20, and
 * the reason for the change is the order a model writes its arguments in:
 * Gemma 4's chat template renders every earlier call with its arguments
 * sorted by name, so the model learns to write them that way, and `path`
 * sorted after `new_text`. A call that ran out of room inside a long
 * `new_text`, or that the model closed once the text was written, never got
 * as far as its file (pandorum, 2026-10-20, v9-agentic: a 96k-token call cut
 * at the output cap and a 13.9k-character one closed, both without `path`).
 * `file_path` sorts before `new_text`.
 *
 * `path` is still read: older sessions hold calls written with it, and a
 * model shown either name may send the other. When both are present
 * `file_path` wins, because it is the name the schema asks for.
 *
 * Only for code that reads a call as it arrived or as it is stored. The
 * editor's own executor is handed the input already resolved, as `path`.
 */
export const EDITOR_FILE_PATH_ARG = "file_path";

export function editorFilePath(input: unknown): string | undefined {
	if (input == null || typeof input !== "object" || Array.isArray(input)) {
		return undefined;
	}
	const record = input as Record<string, unknown>;
	if (typeof record.file_path === "string" && record.file_path.length > 0) {
		return record.file_path;
	}
	if (typeof record.path === "string" && record.path.length > 0) {
		return record.path;
	}
	return undefined;
}

/**
 * The body of an `editor` call, from the call as the model wrote it.
 *
 * The model names it `text` since 2026-11-20; it was `new_text`. Same reason
 * as `file_path` above, from the other end: in a template that sorts
 * arguments by name, `start_line`, `old_text` and `path` sorted after
 * `new_text` and so came after the long body, where they went missing
 * (pandorum, 4.100.277-288: `start_line` lost in 7% of short edits and 18%
 * of 200+-line ones). Everything the editor takes sorts before `text`.
 *
 * `new_text` is still read, for stored calls and for models that send it.
 * When both are present `text` wins. Like {@link editorFilePath}, only for
 * code that reads a call as it arrived; the executor is handed `new_text`.
 */
export const EDITOR_TEXT_ARG = "text";

export function editorNewText(input: unknown): string | undefined {
	if (input == null || typeof input !== "object" || Array.isArray(input)) {
		return undefined;
	}
	const record = input as Record<string, unknown>;
	if (typeof record.text === "string") {
		return record.text;
	}
	if (typeof record.new_text === "string") {
		return record.new_text;
	}
	return undefined;
}

/**
 * Whether a run may finish with a file it changed and never checked.
 *
 * Measured on a live session, the whole tool sequence:
 *
 * ```
 * list_files → browser → read_files → check_file → editor → editor → editor → editor
 * ```
 *
 * The linter ran once, *before* anything was touched, and then four consecutive
 * edits landed with nothing checking them. Sixteen problems in the file
 * afterwards. Nothing was missing — `check_file` was right there and had
 * already been used once.
 *
 * The setting lives here rather than in the conversation on purpose. A question
 * asked after every file change is a round trip per edit, and "always" is not
 * an answer a model should be giving on the user's behalf: it is a preference,
 * and preferences belong in settings.
 */

export type EditVerificationMode =
	/** Never held back. The behaviour every build before this one had. */
	| "off"
	/** Asked once, then asked once more, then left alone. */
	| "nudge"
	/** The same guard given more room to insist. */
	| "require"

export interface EditVerificationSettings {
	mode: EditVerificationMode
}

/**
 * Nudging by default rather than requiring: the first version of a guard should
 * be the one that is hard to resent. A run it holds back twice and then lets
 * through costs two turns; one it will not release costs the task.
 */
export const DEFAULT_EDIT_VERIFICATION_SETTINGS: EditVerificationSettings = {
	mode: "nudge",
}

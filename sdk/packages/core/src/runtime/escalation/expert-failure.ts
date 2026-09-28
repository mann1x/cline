/**
 * The expert's run failing after it had already written files.
 */

/**
 * An expert run that failed, with the files it changed before it did.
 *
 * `changed` holds workspace-relative paths. The escalate and wait tools read it
 * so that "the escalation did not happen" is not followed by "nothing has
 * changed" when the expert had in fact written files.
 */
export class ExpertRunFailedError extends Error {
	readonly changed: string[];
	constructor(message: string, changed: string[], options?: ErrorOptions) {
		super(message, options);
		this.name = "ExpertRunFailedError";
		this.changed = changed;
	}
}

/**
 * What the base is told about a failed expert run's edits.
 *
 * Empty when the run changed nothing, so the caller can keep saying so.
 */
export function describeFailedExpertChanges(error: unknown): string {
	const changed =
		error instanceof ExpertRunFailedError ? error.changed : undefined;
	if (!changed?.length) {
		return "";
	}
	const shown = changed.slice(0, 30);
	const more = changed.length - shown.length;
	return `Before it failed, the expert changed ${changed.length} file${changed.length === 1 ? "" : "s"}: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}. Those edits are still on disk and were not reviewed or finished. Read ${changed.length === 1 ? "it" : "them"} before you edit, and decide whether to keep or undo ${changed.length === 1 ? "it" : "them"}.`;
}

import type { AgentTool } from "@cline/shared";

/**
 * Files the model changed and has not checked since.
 *
 * A run that edits and never re-checks is the ordinary failure, not the
 * exceptional one. Measured on a live session, the whole tool sequence:
 *
 * ```
 * list_files → browser → read_files → check_file → editor → editor → editor → editor
 * ```
 *
 * The linter ran once, *before* anything was touched, and then four consecutive
 * edits landed with nothing checking them. Sixteen problems in the file
 * afterwards. The model was not missing a tool — `check_file` was right there
 * and it had already used it once.
 *
 * So this is a guard rather than a paragraph of instruction. A model that
 * ignores a linter it has already run will ignore a sentence asking it to run
 * one again; what it cannot ignore is not being allowed to finish. The same
 * reasoning, and the same two-strike shape, as the checklist close-out.
 *
 * Deliberately generic. The checker on the VS Code path is `check_file`, which
 * lives in the extension rather than in the SDK, and a host may have another
 * one or none at all — so the tool names are supplied rather than assumed, and
 * a host that names no checker gets no guard.
 */

/** How the host names the tools that edit and the tools that verify. */
export interface EditVerificationConfig {
	/** Tools whose calls mark a file as changed. */
	editTools: readonly string[];
	/** Tools whose calls mark a file as verified. */
	checkTools: readonly string[];
	/**
	 * How many times the guard may hold the run back. Beyond this it stands
	 * aside: the model has been told twice and the work is the user's to judge.
	 */
	attempts?: number;
}

export const EDIT_VERIFICATION_ATTEMPTS = 2;

/** Files edited since they were last checked, in the order they were edited. */
export interface EditVerificationState {
	unchecked: readonly string[];
}

/**
 * Every file path an argument bag names, whatever shape it names them in.
 *
 * `editor` sends `path`, `check_file` sends `paths`, and `read_files` sends
 * `files: [{ path }]`. Reading one shape would silently cover one tool, which
 * is the failure mode this whole module exists to answer, so all three are
 * read and anything unrecognised contributes nothing.
 */
export function extractPaths(input: unknown): string[] {
	if (input == null || typeof input !== "object") {
		return [];
	}
	const bag = input as Record<string, unknown>;
	const found: string[] = [];
	const push = (value: unknown) => {
		if (typeof value === "string" && value.trim() !== "") {
			found.push(value.trim());
		}
	};
	push(bag.path);
	if (Array.isArray(bag.paths)) {
		for (const entry of bag.paths) {
			push(entry);
		}
	}
	if (Array.isArray(bag.files)) {
		for (const entry of bag.files) {
			if (typeof entry === "string") {
				push(entry);
			} else if (entry != null && typeof entry === "object") {
				push((entry as Record<string, unknown>).path);
			}
		}
	}
	return found;
}

/**
 * Paths are compared as the model wrote them, with only the obvious noise
 * removed. A model that edits `src/game.ts` and checks `./src/game.ts` means
 * the same file and should not be nagged; one that edits an absolute path and
 * checks a relative one is beyond what a string comparison can settle, and the
 * guard errs towards asking rather than towards silence.
 */
function normalizePath(filePath: string): string {
	const forward = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
	return forward.toLowerCase();
}

/** Tracks which edited files are still unverified. */
export class EditVerificationTracker {
	private readonly editTools: ReadonlySet<string>;
	private readonly checkTools: ReadonlySet<string>;
	/** Normalised path → the path as the model wrote it, for the message. */
	private readonly unchecked = new Map<string, string>();

	constructor(config: EditVerificationConfig) {
		this.editTools = new Set(config.editTools);
		this.checkTools = new Set(config.checkTools);
	}

	/** Whether this tracker can ever have anything to say. */
	get armed(): boolean {
		return this.editTools.size > 0 && this.checkTools.size > 0;
	}

	recordToolCall(toolName: string, input: unknown): void {
		if (this.editTools.has(toolName)) {
			for (const filePath of extractPaths(input)) {
				this.unchecked.set(normalizePath(filePath), filePath);
			}
			return;
		}
		if (this.checkTools.has(toolName)) {
			for (const filePath of extractPaths(input)) {
				this.unchecked.delete(normalizePath(filePath));
			}
		}
	}

	getState(): EditVerificationState {
		return { unchecked: [...this.unchecked.values()] };
	}

	reset(): void {
		this.unchecked.clear();
	}
}

/** What the model is told, naming the files rather than the rule. */
export function buildUncheckedEditsNudge(
	unchecked: readonly string[],
	checkTool: string,
	attempt: 1 | 2,
): string {
	const list = unchecked.map((filePath) => `\`${filePath}\``).join(", ");
	const plural = unchecked.length === 1 ? "this file" : "these files";
	if (attempt === 1) {
		return (
			`You changed ${plural} and have not checked ${unchecked.length === 1 ? "it" : "them"} since: ${list}.\n\n` +
			`Run \`${checkTool}\` on ${unchecked.length === 1 ? "it" : "them"} before you finish. ` +
			"If it reports problems your edits introduced, fix them and check again. " +
			"An edit that has not been looked at is not a change you can report as done."
		);
	}
	return (
		`${list} ${unchecked.length === 1 ? "is" : "are"} still unchecked since your last edit, and this is the last time you will be asked.\n\n` +
		`Run \`${checkTool}\` now, or say plainly that you are finishing without checking and why — ` +
		"an unverified edit reported as complete is the thing this is here to prevent."
	);
}

/**
 * A completion guard that holds the run back while an edit is unverified.
 *
 * Returns `undefined` — letting the run end — when there is nothing unchecked,
 * when the host named no checker, or once the attempts are spent. It never
 * blocks indefinitely: two refusals is a warning, a third would be an argument.
 */
export function createEditVerificationCompletionGuard(
	tracker: EditVerificationTracker,
	config: EditVerificationConfig,
): () => string | undefined {
	const limit = config.attempts ?? EDIT_VERIFICATION_ATTEMPTS;
	const checkTool = config.checkTools[0];
	let fired = 0;
	return () => {
		if (!tracker.armed || checkTool === undefined || fired >= limit) {
			return undefined;
		}
		const { unchecked } = tracker.getState();
		if (unchecked.length === 0) {
			return undefined;
		}
		fired += 1;
		return buildUncheckedEditsNudge(unchecked, checkTool, fired === 1 ? 1 : 2);
	};
}

/** Marks a tool already wrapped, so two layers of wrapping count one call once. */
const EDIT_VERIFICATION_WRAPPED: unique symbol = Symbol.for(
	"cline.editVerificationWrapped",
);

/** Whether a tool has already been wrapped for edit tracking. */
export function isEditVerificationWrapped(tool: object): boolean {
	return (tool as Record<symbol, unknown>)[EDIT_VERIFICATION_WRAPPED] === true;
}

/**
 * Watch a tool's calls without changing what it does.
 *
 * Only the call is observed — not the result. A failed edit still counts as
 * having touched the file: the tool may have written part of it, and a guard
 * that trusted `success` would be answering a different question than "is this
 * file in a state anyone has looked at".
 */
export function withEditVerificationCapture<TInput, TOutput>(
	tool: AgentTool<TInput, TOutput>,
	tracker: EditVerificationTracker,
): AgentTool<TInput, TOutput> {
	if (isEditVerificationWrapped(tool)) {
		return tool;
	}
	const wrapped: AgentTool<TInput, TOutput> = {
		...tool,
		execute: async (input, context) => {
			tracker.recordToolCall(tool.name, input);
			return tool.execute(input, context);
		},
	};
	Object.defineProperty(wrapped, EDIT_VERIFICATION_WRAPPED, {
		value: true,
		enumerable: false,
	});
	return wrapped;
}

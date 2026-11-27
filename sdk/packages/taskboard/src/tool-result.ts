/**
 * What a board or pipeline tool returns per operation. The same shape as
 * `ToolOperationResult` in `@cline/core`'s tools, so a host renders these the
 * way it renders its own; kept here so this package does not depend on core.
 */
export interface ToolOperationResult {
	/** The query/input that was executed */
	query: string;
	/** The result content (if successful) */
	result: unknown;
	/** Error message (if failed) */
	error?: string;
	/** Whether the operation succeeded */
	success: boolean;
	/** Duration in MS */
	duration?: number;
	/**
	 * Something about a successful result the model would otherwise misread,
	 * kept out of `result` so the output stays exactly what the tool produced.
	 */
	note?: string;
}

import type { ToolApprovalRequest, ToolApprovalResult } from "@cline/shared";
import type { ReadReceipts, ToolExecutors } from "../../extensions/tools";

export interface RuntimeCapabilities {
	toolExecutors?: Partial<ToolExecutors>;
	/**
	 * The host's record of what has been read.
	 *
	 * A host that replaces `readFile` or `editor` replaces the half of the
	 * read-before-write guard that WRITES the record, while `grep`, `sed` and
	 * `awk` keep the one core built -- which nothing then writes to. The result
	 * is a guard that refuses every `sed` in-place run for a file the model has
	 * just read, and says the file "has not been read in this session" while
	 * `read_files` calls on it sit in the same transcript. Hand the registry
	 * over with the executors and all of them share one.
	 */
	readReceipts?: ReadReceipts;
	requestToolApproval?: (
		request: ToolApprovalRequest,
	) => Promise<ToolApprovalResult> | ToolApprovalResult;
}

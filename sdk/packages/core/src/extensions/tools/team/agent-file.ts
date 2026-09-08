/**
 * Writing an agent file to disk.
 *
 * The format itself -- the frontmatter order, the quoting, the file name --
 * lives in `@cline/shared` so the VS Code agent editor and this share one
 * renderer. Only the part that touches the filesystem is here.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
	type AgentFileFields,
	agentFileName,
	renderAgentFile,
	validateAgentFields,
} from "@cline/shared";

export type { AgentFileFields };
export { agentFileName, renderAgentFile, validateAgentFields };

export interface WriteAgentFileResult {
	path: string;
	/** True when a file of the same name was replaced. */
	overwritten: boolean;
}

/**
 * Write one agent file into `directory`, creating the directory if needed.
 *
 * Refuses to replace an existing agent unless told to. A model asked to "create
 * an agent for network troubleshooting" twice should say the second one is
 * already there, not silently discard whatever the user had tuned in the first.
 */
export async function writeAgentFile(input: {
	directory: string;
	agent: AgentFileFields;
	overwrite?: boolean;
	fileExists: (path: string) => Promise<boolean>;
}): Promise<WriteAgentFileResult> {
	validateAgentFields(input.agent);
	const target = join(input.directory, agentFileName(input.agent.name));
	// The name is slugged to a bare file name, so the join cannot climb out of
	// the directory; this asserts it rather than trusting the slug forever.
	if (dirname(resolve(target)) !== resolve(input.directory)) {
		throw new Error(`"${input.agent.name}" is not a usable agent name.`);
	}
	const exists = await input.fileExists(target);
	if (exists && !input.overwrite) {
		throw new Error(
			`An agent already exists at ${basename(target)}. Pass overwrite to replace it, or choose another name.`,
		);
	}
	await mkdir(input.directory, { recursive: true });
	await writeFile(target, renderAgentFile(input.agent), "utf-8");
	return { path: target, overwritten: exists };
}

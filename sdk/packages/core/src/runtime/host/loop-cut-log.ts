import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { LoopCutRecord } from "@cline/shared";

/**
 * Append one cut to a session's `<id>.cuts.jsonl`, with the time it was kept.
 *
 * The text a guard removes is not in the transcript, any request or the
 * stored session (see `LoopCutRecord`), so this file is the only copy. One
 * line per cut, appended, so a session that cuts many times never rewrites
 * what it already kept. Kept beside the transcript rather than in it: a cut
 * can be 70,000 characters or more, and the transcript is what every state
 * snapshot to the webview carries.
 */
export async function appendLoopCut(
	path: string,
	cut: LoopCutRecord,
	now: () => Date = () => new Date(),
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(
		path,
		`${JSON.stringify({ at: now().toISOString(), ...cut, chars: cut.text.length })}\n`,
		"utf8",
	);
}

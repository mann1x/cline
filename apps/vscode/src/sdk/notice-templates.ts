/**
 * The wording of the engine's generation notices as typed: one line per step
 * in step order, line 1 the first step, and a blank line, or none, leaving that
 * step to the engine's own line. The wording is the profile's (the provider
 * panel's Notices section) and is sent as each step's `template` on a server
 * with notices contract v3 (`generation-notices.ts`).
 */
export function noticeTemplateLines(value: string | undefined): string[] {
	return (value ?? "").split(/\r?\n/).map((line) => line.trim())
}

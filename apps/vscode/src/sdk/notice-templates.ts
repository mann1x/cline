import { setNoticeCopyBar, setNoticeTemplates } from "@cline/llms"

/**
 * The wording of the engine's generation notices (Settings > Features), one
 * line per step in step order: line 1 is the first step, and a blank line, or
 * none, leaves that step to the engine's own line. Sent as each step's
 * `template` on a server with notices contract v3; a v2 server gets none, as
 * its templates follow other rules (`generation-notices.ts`). Applies from the
 * next request.
 */
export function noticeTemplateLines(value: string | undefined): string[] {
	return (value ?? "").split(/\r?\n/).map((line) => line.trim())
}

export function applyNoticeTemplates(think: string | undefined, answer: string | undefined): void {
	setNoticeTemplates({ think: noticeTemplateLines(think), answer: noticeTemplateLines(answer) })
}

/**
 * The copy bar per phase (Settings > Features): the engine refuses a token
 * that would continue a copy of a notice line it planted. Off unless switched
 * on; sent only to a v3 server that takes it (`generation_notice_copy_bar`).
 */
export function applyNoticeCopyBar(think: boolean | undefined, answer: boolean | undefined): void {
	setNoticeCopyBar({ think: think === true, answer: answer === true })
}

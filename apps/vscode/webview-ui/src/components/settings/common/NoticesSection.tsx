import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useRef } from "react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useProviderConfig } from "@/hooks/useProviderConfig"
import { DebouncedTextArea } from "./DebouncedTextArea"
import { DebouncedTextField } from "./DebouncedTextField"
import { LoadDefaultPromptButton } from "./LoadDefaultPromptButton"

/**
 * The ladder sent when a phase names no steps. Restated from
 * `DEFAULT_NOTICE_STEPS` in `@cline/llms`' `generation-notices.ts`, for the
 * placeholder only: the webview bundle cannot import that package.
 */
const DEFAULT_STEPS = [60, 70, 80, 90]
const MAX_STEPS = 4

/**
 * Steps as typed -- "60, 70, 80" -- as whole percents from 1 to 99, sorted, at
 * most four. Anything else in the box is dropped rather than refused, and an
 * empty result means the default ladder.
 */
export function parseNoticeSteps(value: string): number[] {
	const steps = value
		.split(/[\s,;]+/)
		.map((part) => Number(part))
		.filter((step) => Number.isInteger(step) && step >= 1 && step <= 99)
	return [...new Set(steps)].sort((a, b) => a - b).slice(0, MAX_STEPS)
}

/**
 * The engine's built-in v3 notice lines, one per step at 60/70/80/90 %, as
 * opencoti publishes them (docs/llamafile-flags.md, contract v3). Restated
 * for the placeholder and "Load default" only: the webview cannot ask the
 * server, and an unset field sends nothing, so the engine's own line is used.
 */
const NOTICE_WORDING = [
	{
		key: "thinkTemplates",
		copyBarKey: "copyBarThink",
		copyBarDefault: true,
		label: "Thinking notices",
		builtIn: [
			"I'm settling on my approach now — about {words} words of thinking left.",
			"I'm finishing this step and dropping the alternatives — about {words} words left.",
			"I'm stopping my thinking now and writing the answer — only {words} words left.",
			"I'm answering now — under {words} words left.",
		].join("\n"),
	},
	{
		key: "answerTemplates",
		copyBarKey: "copyBarAnswer",
		copyBarDefault: false,
		label: "Answer notices",
		builtIn: [
			"I'm wrapping up now and covering only what's essential.",
			"I'm skipping the remaining details and moving to the conclusion.",
			"I'm writing the conclusion now.",
			"I'm closing the reply with one sentence.",
		].join("\n"),
	},
] as const

/** The box's text as one line per step; a blank line leaves that step to the engine. */
export function noticeWordingLines(value: string): string[] {
	const lines = value.split(/\r?\n/).map((line) => line.trim())
	while (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop()
	}
	return lines.slice(0, MAX_STEPS)
}

type NoticesDraft = {
	enabled?: boolean
	thinkSteps?: number[]
	answerSteps?: number[]
	thinkTemplates?: string[]
	answerTemplates?: string[]
	copyBarThink?: boolean
	copyBarAnswer?: boolean
}

/**
 * Generation notices, per profile, for opencoti and xOllama.
 *
 * The engine plants one short line into the model's own output when its
 * thinking or answer room is nearly used up, or when a message you typed is
 * waiting -- so the model can wrap up or look at it, instead of being cut off.
 * The line stays in the conversation, because removing it makes the engine
 * re-read the answer from that point every turn; it is hidden from the chat
 * only. Asked for only where the server says it supports notices.
 */
export const NoticesSection = ({ providerId }: { providerId: string }) => {
	const { config, write } = useProviderConfig(providerId as never)
	// Written whole, so a second edit inside one round trip must compose from
	// the first one's result, not from the render before it. Same guard as the
	// output budget and the PolyKV section.
	const pending = useRef<NoticesDraft | undefined>(undefined)
	const inFlight = useRef(0)
	if (config === undefined) {
		return null
	}
	const notices = (pending.current ?? config.notices ?? {}) as NoticesDraft
	const enabled = notices.enabled === true

	const patch = (changes: NoticesDraft) => {
		const base = (pending.current ?? config.notices ?? {}) as NoticesDraft
		const next: NoticesDraft = {
			enabled: base.enabled === true,
			thinkSteps: [...(base.thinkSteps ?? [])],
			answerSteps: [...(base.answerSteps ?? [])],
			thinkTemplates: [...(base.thinkTemplates ?? [])],
			answerTemplates: [...(base.answerTemplates ?? [])],
			...(base.copyBarThink !== undefined ? { copyBarThink: base.copyBarThink } : {}),
			...(base.copyBarAnswer !== undefined ? { copyBarAnswer: base.copyBarAnswer } : {}),
			...changes,
		}
		pending.current = next
		inFlight.current += 1
		return write({
			notices: {
				enabled: next.enabled === true,
				thinkSteps: next.thinkSteps ?? [],
				answerSteps: next.answerSteps ?? [],
				thinkTemplates: next.thinkTemplates ?? [],
				answerTemplates: next.answerTemplates ?? [],
				...(next.copyBarThink !== undefined ? { copyBarThink: next.copyBarThink } : {}),
				...(next.copyBarAnswer !== undefined ? { copyBarAnswer: next.copyBarAnswer } : {}),
			},
		})
			.catch((error) => console.error("Failed to update notices:", error))
			.finally(() => {
				inFlight.current -= 1
				if (inFlight.current === 0) {
					pending.current = undefined
				}
			})
	}

	const stepsField = (phase: "thinkSteps" | "answerSteps", label: string) => {
		const stored = notices[phase] ?? []
		return (
			<DebouncedTextField
				initialValue={stored.join(", ")}
				onChange={(value) => {
					const next = parseNoticeSteps(value)
					if (next.join(",") === stored.join(",")) {
						return
					}
					return patch({ [phase]: next })
				}}
				placeholder={`Default: ${DEFAULT_STEPS.join(", ")}`}
				style={{ width: "100%" }}>
				<span className="font-semibold">{label}</span>
			</DebouncedTextField>
		)
	}

	return (
		<div className="flex flex-col gap-1 mb-[5px]" data-testid="notices-section">
			<div className="flex items-center justify-between w-full">
				<Label className="text-xs font-medium text-foreground" htmlFor="notices-enabled">
					Generation notices
				</Label>
				<Switch
					checked={enabled}
					className="shrink-0"
					id="notices-enabled"
					onCheckedChange={(checked) => patch({ enabled: checked })}
					size="default"
				/>
			</div>
			{enabled && (
				<>
					{stepsField("thinkSteps", "Thinking steps (% of the thinking room)")}
					{stepsField("answerSteps", "Answer steps (% of the answer room)")}
					<div className="flex flex-col gap-2 mt-[5px]" data-testid="notices-wording">
						<p className="text-xs mt-0 mb-0 text-(--vscode-descriptionForeground)">
							The line written at each step, one per line in step order: line 1 is the first step. A blank line, or
							none, keeps the engine's own line. {"{words}"} is the words left, {"{left}"} the tokens left and{" "}
							{"{total}"} the phase's budget. Copy bar: the engine stops the model writing a notice line out again,
							word for word, in that phase. Both need notices contract v3 (opencoti, xOllama); the copy bar also
							needs opencoti r5 or later. Applies from the next request.
						</p>
						{NOTICE_WORDING.map((phase) => {
							const stored = notices[phase.key] ?? []
							const value = stored.join("\n")
							const copyBar = notices[phase.copyBarKey] ?? phase.copyBarDefault
							const writeWording = (text: string) => {
								const next = noticeWordingLines(text)
								if (next.join("\n") === stored.join("\n")) {
									return
								}
								return patch({ [phase.key]: next })
							}
							return (
								<div className="flex flex-col gap-1" key={phase.key}>
									<div className="flex items-center justify-between w-full">
										<span className="text-xs font-medium text-foreground">{phase.label}</span>
										<label
											className="flex items-center gap-2 text-xs text-(--vscode-descriptionForeground)"
											htmlFor={`notices-${phase.copyBarKey}`}>
											Copy bar
											<Switch
												checked={copyBar}
												className="shrink-0"
												id={`notices-${phase.copyBarKey}`}
												onCheckedChange={(checked) => patch({ [phase.copyBarKey]: checked })}
											/>
										</label>
									</div>
									<DebouncedTextArea
										initialValue={value}
										maxRows={8}
										minRows={4}
										onChange={writeWording}
										placeholder={phase.builtIn}
									/>
									<div className="flex flex-wrap items-start gap-2">
										<LoadDefaultPromptButton
											currentValue={value}
											defaultValue={phase.builtIn}
											label={phase.label}
											onLoad={writeWording}
										/>
										{value.trim() ? (
											<VSCodeButton appearance="secondary" onClick={() => writeWording("")}>
												Reset to default
											</VSCodeButton>
										) : null}
									</div>
								</div>
							)
						})}
					</div>
				</>
			)}
			<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
				The server writes one short line into the model's output as it nears the end of its thinking or answer room, and
				when a message you sent is waiting, so the model can wrap up instead of being cut off. Up to four steps per phase.
				The line is kept in the conversation and hidden from the chat. Servers that do not support notices ignore this.
			</p>
		</div>
	)
}

export default NoticesSection

import { useRef } from "react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useProviderConfig } from "@/hooks/useProviderConfig"
import { DebouncedTextField } from "./DebouncedTextField"

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

type NoticesDraft = { enabled?: boolean; thinkSteps?: number[]; answerSteps?: number[] }

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
			...changes,
		}
		pending.current = next
		inFlight.current += 1
		return write({
			notices: {
				enabled: next.enabled === true,
				thinkSteps: next.thinkSteps ?? [],
				answerSteps: next.answerSteps ?? [],
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

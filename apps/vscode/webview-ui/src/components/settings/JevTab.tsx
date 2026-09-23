import { DEFAULT_JEV_SETTINGS, type JevSettings, parseJevSettings } from "@shared/jev-settings"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useMemo } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { DebouncedTextField } from "./common/DebouncedTextField"
import { SettingsCheckbox } from "./common/SettingsCheckbox"

/** A confidence floor as typed, or nothing when it is not one. */
export function readFloor(value: string): number | undefined {
	const n = Number(value.trim())
	return Number.isFinite(n) && n > 0 && n <= 1 ? n : undefined
}

/**
 * Jev, TypeSafe's scoring model.
 *
 * Like the Images tab, this configures an endpoint and not a model in the
 * conversation, so it is not a scoped model tab and has no profile. The record
 * is round-tripped whole; the key is written alone and never read back.
 */
const JevTab = () => {
	const { jevSettings, jevApiKeySet } = useExtensionState()
	const stored = useMemo(() => parseJevSettings(jevSettings), [jevSettings])

	const save = useCallback(
		async (patch: Partial<JevSettings>) => {
			try {
				await StateServiceClient.updateSettings(
					UpdateSettingsRequest.create({ jevSettings: JSON.stringify({ ...stored, ...patch }) }),
				)
			} catch (error) {
				console.error("Failed to save the Jev settings:", error)
			}
		},
		[stored],
	)

	const saveApiKey = useCallback(async (value: string) => {
		try {
			await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ jevApiKey: value }))
		} catch (error) {
			console.error("Failed to save the Jev key:", error)
		}
	}, [])

	return (
		<div className="flex flex-col gap-3">
			<p className="text-xs text-(--vscode-descriptionForeground)">
				Jev answers typed questions with probabilities — yes/no, pick one, or a score — and a confidence. Cerebriline uses
				it to decide how sure to be: the model calls the <code>jev</code> tool when it is unsure, and the harness scores
				the options of a question before you see it and the complexity of a task before it is escalated. Parts of the
				conversation are sent to TypeSafe on each call. See the{" "}
				<VSCodeLink href="https://docs.typesafe.ai/introduction/coding-agents">documentation</VSCodeLink>.
			</p>

			<DebouncedTextField
				className="w-full"
				initialValue=""
				onChange={(value) => void saveApiKey(value)}
				placeholder={jevApiKeySet ? "Stored — type to replace, clear to remove" : "Your TypeSafe API key"}
				type="password">
				<span className="font-medium">API key</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				Kept in the editor's secret storage and never sent back to this panel, which is why the field looks empty with a
				key stored. Nothing is offered until a key is set.
			</p>

			<DebouncedTextField
				className="w-full"
				initialValue={stored.model}
				onChange={(value) => void save({ model: value.trim() || DEFAULT_JEV_SETTINGS.model })}
				placeholder={DEFAULT_JEV_SETTINGS.model}>
				<span className="font-medium">Model</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				<code>jev-latest</code> moves with each release. Pin a version, such as <code>jev-1.13.0</code>, once you have
				tuned the floors below, so a release does not move them for you.
			</p>

			<DebouncedTextField
				className="w-full"
				initialValue={String(stored.floor)}
				numeric
				onChange={(value) => {
					const floor = readFloor(value)
					if (floor !== undefined) void save({ floor })
				}}
				placeholder={String(DEFAULT_JEV_SETTINGS.floor)}>
				<span className="font-medium">Confidence floor</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				Between 0 and 1. An answer at or above it is acted on; below it the model verifies or asks you, and a question's
				options are shown without a recommendation.
			</p>

			<DebouncedTextField
				className="w-full"
				initialValue={String(stored.highStakesFloor)}
				numeric
				onChange={(value) => {
					const highStakesFloor = readFloor(value)
					if (highStakesFloor !== undefined) void save({ highStakesFloor })
				}}
				placeholder={String(DEFAULT_JEV_SETTINGS.highStakesFloor)}>
				<span className="font-medium">High-stakes floor</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				The bar for a question the model marks as costly to get wrong.
			</p>

			<DebouncedTextField
				className="w-full"
				initialValue={String(Math.round(stored.timeoutMs / 1000))}
				numeric
				onChange={(value) => {
					const seconds = Number(value.trim())
					if (Number.isFinite(seconds) && seconds >= 1) void save({ timeoutMs: Math.round(seconds * 1000) })
				}}
				placeholder={String(DEFAULT_JEV_SETTINGS.timeoutMs / 1000)}>
				<span className="font-medium">Timeout (seconds)</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				For the whole call, retries included. A question to you waits at most 6 seconds for its scores and then goes out
				without them.
			</p>

			<div>
				<SettingsCheckbox
					checked={stored.rankQuestions}
					onChange={(checked: boolean) => save({ rankQuestions: checked })}>
					Score the options of a question before I see it
				</SettingsCheckbox>
				<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
					Marks the option you are likeliest to pick as recommended when Jev is confident, shows each option's score,
					and leaves out options it puts under 5% — never fewer than two. You can still type any answer.
				</p>
			</div>

			<div>
				<SettingsCheckbox
					checked={stored.appraiseEscalation}
					onChange={(checked: boolean) => save({ appraiseEscalation: checked })}>
					Score a task before it is escalated
				</SettingsCheckbox>
				<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
					Adds Jev's complexity score, and its reading of whether the run is stuck, to the assessment you approve from
					and the expert reads.
				</p>
			</div>
		</div>
	)
}

export default JevTab

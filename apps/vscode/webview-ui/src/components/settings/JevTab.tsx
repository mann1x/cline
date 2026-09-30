import { DEFAULT_JEV_SETTINGS, type JevSettings, parseJevSettings } from "@shared/jev-settings"
import { StringRequest } from "@shared/proto/cline/common"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient, StateServiceClient } from "@/services/grpc-client"
import { DebouncedTextField } from "./common/DebouncedTextField"
import { SettingsCheckbox } from "./common/SettingsCheckbox"
import OllamaModelPicker from "./OllamaModelPicker"

/** A confidence floor as typed, or nothing when it is not one. */
export function readFloor(value: string): number | undefined {
	const n = Number(value.trim())
	return Number.isFinite(n) && n > 0 && n <= 1 ? n : undefined
}

/**
 * Jev, TypeSafe's scoring model, or any endpoint that speaks its API.
 *
 * Like the Images tab, this configures an endpoint and not a model in the
 * conversation, so it is not a scoped model tab and has no profile. The record
 * is round-tripped whole; the keys are written alone and never read back.
 *
 * The endpoint field picks the mode. Empty is TypeSafe, with TypeSafe's key
 * and model; a URL is that server, with the one custom key and its own model,
 * so switching back and forth keeps both and TypeSafe's key never leaves for a
 * URL typed here.
 */
const JevTab = () => {
	const { jevSettings, jevApiKeySet, jevCustomApiKeySet } = useExtensionState()
	const stored = useMemo(() => parseJevSettings(jevSettings), [jevSettings])
	const custom = stored.baseUrl !== ""
	const [models, setModels] = useState<string[]>([])

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

	const saveApiKey = useCallback(
		async (value: string) => {
			try {
				await StateServiceClient.updateSettings(
					UpdateSettingsRequest.create(custom ? { jevCustomApiKey: value } : { jevApiKey: value }),
				)
			} catch (error) {
				console.error("Failed to save the Jev key:", error)
			}
		},
		[custom],
	)

	// Fetched when the endpoint or a key changes and on focus of the picker,
	// never on an interval, for the Images tab's reason: a metered endpoint.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the key flags make storing a key refresh the list it unlocks
	const requestModels = useCallback(async () => {
		try {
			const response = await ModelsServiceClient.getJevModels(StringRequest.create({ value: stored.baseUrl }))
			setModels(response?.values ?? [])
		} catch (error) {
			console.error("Failed to fetch the Jev models:", error)
			setModels([])
		}
	}, [stored.baseUrl, jevApiKeySet, jevCustomApiKeySet])

	useEffect(() => {
		void requestModels()
	}, [requestModels])

	const keySet = custom ? jevCustomApiKeySet : jevApiKeySet
	const model = custom ? stored.customModel : stored.model

	return (
		<div className="flex flex-col gap-3">
			<p className="text-xs text-(--vscode-descriptionForeground)">
				Typesafe's Jev API answers typed questions with probabilities — yes/no, pick one, or a score — and a confidence.
				Cerebriline uses it to decide how sure to be: the model calls the <code>jev</code> tool when it is unsure, and the
				harness scores the options of a question before you see it and the complexity of a task before it is escalated.
				Parts of the conversation are sent to the endpoint on each call: TypeSafe, or the custom one below. See TypeSafe's{" "}
				<VSCodeLink href="https://docs.typesafe.ai/introduction/coding-agents">documentation</VSCodeLink>, and Ollama's{" "}
				<VSCodeLink href="https://docs.ollama.com/capabilities/decision">documentation</VSCodeLink> and{" "}
				<VSCodeLink href="https://ollama.com/blog/ollama-now-supports-jev-style-decision-models">announcement</VSCodeLink>
				.
			</p>

			<DebouncedTextField
				className="w-full"
				initialValue={stored.baseUrl}
				onChange={(value) => void save({ baseUrl: value.trim() })}
				placeholder="Empty for TypeSafe, or e.g. http://localhost:11434">
				<span className="font-medium">Typesafe's Jev API endpoint</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				Leave empty to use TypeSafe. Otherwise any server that speaks Typesafe's Jev API: Ollama 0.35 or later and xollama
				— give the server's address, such as <code>http://localhost:11434</code> — or a third party's API base.
				Cerebriline asks the server whether it is Ollama and follows its limits. A custom endpoint has its own key and
				model below; your TypeSafe key is only ever sent to TypeSafe.
			</p>

			<DebouncedTextField
				className="w-full"
				initialValue=""
				key={custom ? "custom-key" : "typesafe-key"}
				onChange={(value) => void saveApiKey(value)}
				placeholder={
					keySet
						? "Stored — type to replace, clear to remove"
						: custom
							? "Leave empty if the server needs none (Ollama needs none)"
							: "Your TypeSafe API key"
				}
				type="password">
				<span className="font-medium">{custom ? "Custom endpoint API key" : "API key"}</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				{custom
					? "One key for every custom endpoint, sent as Authorization: Bearer when set. "
					: "Nothing is offered until a key is set. "}
				Kept in the editor's secret storage and never sent back to this panel, which is why the field looks empty with a
				key stored.
			</p>

			<div>
				<label className="font-medium text-sm block mb-1" htmlFor="jev-model">
					Model
				</label>
				<OllamaModelPicker
					key={custom ? "custom-model" : "typesafe-model"}
					ollamaModels={models}
					onFocus={() => void requestModels()}
					onModelChange={(value) =>
						void save(custom ? { customModel: value.trim() } : { model: value.trim() || DEFAULT_JEV_SETTINGS.model })
					}
					placeholder={custom ? "Search and select a decision model..." : DEFAULT_JEV_SETTINGS.model}
					selectedModelId={model}
				/>
				<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
					{custom ? (
						models.length > 0 ? (
							`${models.length} decision model${models.length === 1 ? "" : "s"} on this endpoint.${model ? "" : " Pick one: nothing is offered until a model is set."}`
						) : (
							<>
								This endpoint reported no decision models. On Ollama, pull one — <code>nimble</code>,{" "}
								<code>tev1</code> or <code>tev1:0.8b</code> — or type the name; nothing is offered until a model
								is set.
							</>
						)
					) : (
						<>
							<code>jev-latest</code> moves with each release. Pin a version, such as <code>jev-1.13.0</code>, once
							you have tuned the floors below, so a release does not move them for you.
						</>
					)}
				</p>
			</div>

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

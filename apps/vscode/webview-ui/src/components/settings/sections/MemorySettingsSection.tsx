import { DEFAULT_MEMORY_SETTINGS, type MemorySettings, resolveMemorySettings } from "@cline/shared"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { embeddingEndpointConfigured, parseRetrievalEndpoints } from "@shared/retrieval-endpoints"
import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useMemo } from "react"
import { Slider } from "@/components/ui/slider"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { SettingsCheckbox } from "../common/SettingsCheckbox"
import Section from "../Section"

interface MemorySettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

/** What the host sent, read through the same normaliser the host uses. */
export function parseMemorySettings(raw: string | undefined): MemorySettings {
	try {
		const parsed = JSON.parse(raw || "{}")
		return resolveMemorySettings(typeof parsed === "object" && parsed !== null ? parsed : {})
	} catch {
		return { ...DEFAULT_MEMORY_SETTINGS }
	}
}

/**
 * Memory: notes the model keeps between tasks.
 *
 * It shares the Embedding tab's models with the Library, so there is nothing
 * to configure here about models: one embedding model serves both.
 */
const MemorySettingsSection = ({ renderSectionHeader }: MemorySettingsSectionProps) => {
	const { memoryEnabled, memorySettings, embeddingEnabled, retrievalEndpoints } = useExtensionState()
	const settings = useMemo(() => parseMemorySettings(memorySettings), [memorySettings])
	const endpoints = useMemo(() => parseRetrievalEndpoints(retrievalEndpoints), [retrievalEndpoints])
	const embedding = embeddingEnabled && embeddingEndpointConfigured(endpoints)

	const save = useCallback(
		async (patch: Partial<MemorySettings>) => {
			// The switch is a setting of its own; it is not kept in the record.
			const { enabled: _enabled, ...next } = { ...settings, ...patch }
			try {
				await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ memorySettings: JSON.stringify(next) }))
			} catch (error) {
				console.error("Failed to save the Memory settings:", error)
			}
		},
		[settings],
	)

	return (
		<div>
			{renderSectionHeader("memory")}
			<Section>
				<div>
					<SettingsCheckbox
						checked={memoryEnabled}
						onChange={async (checked) => {
							try {
								await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ memoryEnabled: checked }))
							} catch (error) {
								console.error("Failed to update the Memory setting:", error)
								throw error
							}
						}}>
						Enable Memory
					</SettingsCheckbox>
					<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
						Lets the model keep notes from one task to the next, so what it worked out once is not worked out again: a
						decision and its reason, how the project is built and tested, a convention, something you told it you
						prefer, a trap that cost time. It gets <code>remember</code> to keep a note, <code>recall</code> to look
						for notes at the start of a task and before deciding something, and <code>forget</code> to remove one that
						no longer holds. Notes are kept in Cerebriline's data folder, not in your project. It applies from the
						next task.
					</p>
					{memoryEnabled ? (
						<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
							{embedding
								? `Notes are found by keyword and by meaning, embedding with ${endpoints.embedding.model}.`
								: "Notes are found by keyword. Tick “Use an embedding model” in the API configuration to find them by meaning as well; Memory and the Library share that model."}
						</p>
					) : null}
				</div>

				{memoryEnabled ? (
					<>
						<div>
							<label className="font-medium text-sm block mb-1" htmlFor="memory-default-scope">
								Where a note is kept when the model does not say
							</label>
							<VSCodeDropdown
								className="w-full"
								id="memory-default-scope"
								onChange={(event: any) =>
									void save({ defaultScope: event.target.value === "global" ? "global" : "project" })
								}
								value={settings.defaultScope}>
								<VSCodeOption value="project">This project</VSCodeOption>
								<VSCodeOption value="global">Every project</VSCodeOption>
							</VSCodeDropdown>
							<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
								A project note is seen only in the workspace it was made in. A note for every project is seen
								everywhere, which suits your own preferences. A recall looks in both.
							</p>
						</div>

						<DebouncedTextField
							className="w-full"
							initialValue={String(settings.recallCount)}
							numeric
							onChange={(value) => {
								const parsed = Number(value.trim())
								void save({
									recallCount:
										value.trim() !== "" && Number.isFinite(parsed)
											? parsed
											: DEFAULT_MEMORY_SETTINGS.recallCount,
								})
							}}
							placeholder={String(DEFAULT_MEMORY_SETTINGS.recallCount)}>
							<span className="font-medium">Notes a recall returns</span>
						</DebouncedTextField>
						<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
							The most notes one recall gives the model, best first. Every note returned takes room in the
							conversation.
						</p>

						<div>
							<div className="flex justify-between text-sm mb-1">
								<span className="font-medium">Relevance threshold</span>
								<span className="text-(--vscode-descriptionForeground)">
									{settings.relevanceThreshold.toFixed(2)}
								</span>
							</div>
							<Slider
								aria-label="Relevance threshold"
								max={100}
								min={0}
								onValueChange={([next]) => void save({ relevanceThreshold: next / 100 })}
								step={5}
								value={[Math.round(settings.relevanceThreshold * 100)]}
							/>
							<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
								With a reranking model, notes it scores below this are left out, so a recall about something never
								noted returns nothing instead of the least unrelated notes. 0 keeps them all. Without a reranker
								it has no effect.
							</p>
						</div>
					</>
				) : null}
			</Section>
		</div>
	)
}

export default MemorySettingsSection

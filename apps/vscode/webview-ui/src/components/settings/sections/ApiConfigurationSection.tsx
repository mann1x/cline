import { resolveScopedModelStatus } from "@shared/model-scope-config"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { Mode } from "@shared/storage/types"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { TabButton } from "../../mcp/configuration/McpConfigurationView"
import AgentsModelTab from "../AgentsModelTab"
import ApiConfigProfileBar from "../ApiConfigProfileBar"
import ApiOptions from "../ApiOptions"
import { SettingsCheckbox } from "../common/SettingsCheckbox"
import Section from "../Section"
import { syncModeConfigurations } from "../utils/providerUtils"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"
import type { ApiConfigurationProfileScope } from "../utils/useApiConfigurationProfiles"
import VisionModelTab from "../VisionModelTab"

interface ApiConfigurationSectionProps {
	renderSectionHeader?: (tabId: string) => JSX.Element | null
	initialModelTab?: "recommended" | "free"
}

/**
 * Neither the Vision nor the Agents tab is a `Mode`: each configures a second
 * model rather than a mode of the session's.
 */
type ConfigTab = Mode | "vision" | "agents"

const ApiConfigurationSection = ({ renderSectionHeader, initialModelTab }: ApiConfigurationSectionProps) => {
	const {
		planActSeparateModelsSetting,
		visionModelEnabled,
		visionModeApiConfiguration,
		agentsModelEnabled,
		agentsModeApiConfiguration,
		mode,
		apiConfiguration,
	} = useExtensionState()
	// Enabled with nothing on the Vision tab describes nothing. Said here
	// because this is where it is switched on, and because the alternative was
	// finding out from a failed run: the primary model gets the image, and a
	// model that cannot read one fails the whole turn.
	const visionUnconfigured = resolveScopedModelStatus(visionModelEnabled, visionModeApiConfiguration) === "unconfigured"
	// Same question of the Agents tab, and the same reason for asking it: an
	// enabled toggle over a tab that names nothing is a setting that silently
	// does not apply.
	const agentsUnconfigured = resolveScopedModelStatus(agentsModelEnabled, agentsModeApiConfiguration) === "unconfigured"
	const [currentTab, setCurrentTab] = useState<ConfigTab>(mode)
	const { handleFieldsChange } = useApiConfigurationHandlers()

	// A tab can be turned off while it is showing; fall back rather than render
	// a configuration the user can no longer see the toggle for.
	const scopedTabOff = (currentTab === "vision" && !visionModelEnabled) || (currentTab === "agents" && !agentsModelEnabled)
	const activeTab: ConfigTab = scopedTabOff ? mode : currentTab
	const showTabs = planActSeparateModelsSetting || visionModelEnabled || agentsModelEnabled
	// One profile list for every tab; only the target changes with the tab.
	const profileScope: ApiConfigurationProfileScope =
		activeTab === "vision"
			? { kind: "vision" }
			: activeTab === "agents"
				? { kind: "agents" }
				: { kind: "mode", mode: activeTab }

	return (
		<div>
			{renderSectionHeader?.("api-config")}
			<Section>
				{activeTab === "vision" || activeTab === "agents" ? (
					<ApiConfigProfileBar
						description={`Saving here stores the ${
							activeTab === "vision" ? "vision" : "agents"
						} model's settings. Profiles are shared with the other tabs, so one saved from Act can be loaded here.`}
						scope={profileScope}
					/>
				) : (
					<ApiConfigProfileBar scope={profileScope} />
				)}

				{showTabs ? (
					<div className="rounded-md mb-5">
						<div className="flex gap-px mb-[10px] -mt-2 border-0 border-b border-solid border-(--vscode-panel-border)">
							{planActSeparateModelsSetting ? (
								<>
									<TabButton
										disabled={activeTab === "plan"}
										isActive={activeTab === "plan"}
										onClick={() => setCurrentTab("plan")}
										style={{
											opacity: 1,
											cursor: "pointer",
										}}>
										Plan Mode
									</TabButton>
									<TabButton
										disabled={activeTab === "act"}
										isActive={activeTab === "act"}
										onClick={() => setCurrentTab("act")}
										style={{
											opacity: 1,
											cursor: "pointer",
										}}>
										Act Mode
									</TabButton>
								</>
							) : (
								<TabButton
									disabled={activeTab !== "vision" && activeTab !== "agents"}
									isActive={activeTab !== "vision" && activeTab !== "agents"}
									onClick={() => setCurrentTab(mode)}
									style={{
										opacity: 1,
										cursor: "pointer",
									}}>
									Model
								</TabButton>
							)}
							{visionModelEnabled ? (
								<TabButton
									disabled={activeTab === "vision"}
									isActive={activeTab === "vision"}
									onClick={() => setCurrentTab("vision")}
									style={{
										opacity: 1,
										cursor: "pointer",
									}}>
									Vision
								</TabButton>
							) : null}
							{agentsModelEnabled ? (
								<TabButton
									disabled={activeTab === "agents"}
									isActive={activeTab === "agents"}
									onClick={() => setCurrentTab("agents")}
									style={{
										opacity: 1,
										cursor: "pointer",
									}}>
									Agents
								</TabButton>
							) : null}
						</div>

						{/* Content container */}
						<div className="-mb-3">
							{activeTab === "vision" ? (
								<VisionModelTab />
							) : activeTab === "agents" ? (
								<AgentsModelTab />
							) : (
								<ApiOptions currentMode={activeTab} initialModelTab={initialModelTab} showModelOptions={true} />
							)}
						</div>
					</div>
				) : (
					<ApiOptions currentMode={mode} initialModelTab={initialModelTab} showModelOptions={true} />
				)}

				<div className="mb-[5px]">
					<SettingsCheckbox
						checked={planActSeparateModelsSetting}
						className="mb-[5px]"
						onChange={async (checked: boolean) => {
							try {
								// If unchecking the toggle, wait a bit for state to update, then sync configurations
								if (!checked) {
									await syncModeConfigurations(
										apiConfiguration,
										activeTab === "vision" || activeTab === "agents" ? mode : activeTab,
										handleFieldsChange,
									)
								}
								await StateServiceClient.updateSettings(
									UpdateSettingsRequest.create({
										planActSeparateModelsSetting: checked,
									}),
								)
							} catch (error) {
								console.error("Failed to update separate models setting:", error)
								throw error
							}
						}}>
						Use different models for Plan and Act modes
					</SettingsCheckbox>
					<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
						Switching between Plan and Act mode will persist the API and model used in the previous mode. This may be
						helpful e.g. when using a strong reasoning model to architect a plan for a cheaper coding model to act on.
					</p>
				</div>

				<div className="mb-[5px]">
					<SettingsCheckbox
						checked={visionModelEnabled}
						className="mb-[5px]"
						onChange={async (checked: boolean) => {
							try {
								await StateServiceClient.updateSettings(
									UpdateSettingsRequest.create({ visionModelEnabled: checked }),
								)
							} catch (error) {
								console.error("Failed to update vision model setting:", error)
								throw error
							}
						}}>
						Use a different model for vision processing
					</SettingsCheckbox>
					<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
						Images produced by tools — browser screenshots, for example — are sent to the model configured on the
						Vision tab, which describes them in text for the main model. Useful when the main model cannot read images
						at all, or reads them poorly.
					</p>
					{visionUnconfigured ? (
						<p className="text-xs mt-[5px] text-(--vscode-errorForeground)">
							The Vision tab does not name both a provider and a model, so nothing will describe images: they will
							not be accepted, and any already in a task are dropped rather than sent to a main model that cannot
							read them. Pick a provider <em>and</em> a model on the Vision tab.
						</p>
					) : null}
				</div>

				<div className="mb-[5px]">
					<SettingsCheckbox
						checked={agentsModelEnabled}
						className="mb-[5px]"
						onChange={async (checked: boolean) => {
							try {
								await StateServiceClient.updateSettings(
									UpdateSettingsRequest.create({ agentsModelEnabled: checked }),
								)
							} catch (error) {
								console.error("Failed to update agents model setting:", error)
								throw error
							}
						}}>
						Use a different model for subagents and teammates
					</SettingsCheckbox>
					<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
						Delegated agents otherwise run on the session's own model, with the session's own context window and
						sampler. The Agents tab gives them their own — a smaller or cheaper model under a strong lead, or the same
						model with a window sized for the narrower job.
					</p>
					{agentsUnconfigured ? (
						<p className="text-xs mt-[5px] text-(--vscode-errorForeground)">
							The Agents tab does not name both a provider and a model, so delegated agents keep running on the
							session's model. Pick a provider <em>and</em> a model on the Agents tab.
						</p>
					) : null}
				</div>
			</Section>
		</div>
	)
}

export default ApiConfigurationSection

import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { Mode } from "@shared/storage/types"
import { resolveVisionModelStatus } from "@shared/vision-config"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { TabButton } from "../../mcp/configuration/McpConfigurationView"
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

/** The Vision tab is not a `Mode`; it configures a second model, not a mode. */
type ConfigTab = Mode | "vision"

const ApiConfigurationSection = ({ renderSectionHeader, initialModelTab }: ApiConfigurationSectionProps) => {
	const { planActSeparateModelsSetting, visionModelEnabled, visionModeApiConfiguration, mode, apiConfiguration } =
		useExtensionState()
	// Enabled with nothing on the Vision tab describes nothing. Said here
	// because this is where it is switched on, and because the alternative was
	// finding out from a failed run: the primary model gets the image, and a
	// model that cannot read one fails the whole turn.
	const visionUnconfigured = resolveVisionModelStatus(visionModelEnabled, visionModeApiConfiguration) === "unconfigured"
	const [currentTab, setCurrentTab] = useState<ConfigTab>(mode)
	const { handleFieldsChange } = useApiConfigurationHandlers()

	// A tab can be turned off while it is showing; fall back rather than render
	// a configuration the user can no longer see the toggle for.
	const activeTab: ConfigTab = currentTab === "vision" && !visionModelEnabled ? mode : currentTab
	const showTabs = planActSeparateModelsSetting || visionModelEnabled
	// One profile list for every tab; only the target changes with the tab.
	const profileScope: ApiConfigurationProfileScope =
		activeTab === "vision" ? { kind: "vision" } : { kind: "mode", mode: activeTab }

	return (
		<div>
			{renderSectionHeader?.("api-config")}
			<Section>
				{activeTab === "vision" ? (
					<ApiConfigProfileBar
						description="Saving here stores the vision model's settings. Profiles are shared with the other tabs, so one saved from Act can be loaded here."
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
									disabled={activeTab !== "vision"}
									isActive={activeTab !== "vision"}
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
						</div>

						{/* Content container */}
						<div className="-mb-3">
							{activeTab === "vision" ? (
								<VisionModelTab />
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
										activeTab === "vision" ? mode : activeTab,
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
							No model is set on the Vision tab, so nothing will describe images: they go to the main model as they
							are, and a model that cannot read one fails the turn. Pick a provider and a model on the Vision tab.
						</p>
					) : null}
				</div>
			</Section>
		</div>
	)
}

export default ApiConfigurationSection

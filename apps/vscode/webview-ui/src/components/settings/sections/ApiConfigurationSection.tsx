import { resolveScopedModelStatus } from "@shared/model-scope-config"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { TabButton } from "../../mcp/configuration/McpConfigurationView"
import AgentsModelTab from "../AgentsModelTab"
import ApiConfigProfileBar from "../ApiConfigProfileBar"
import ApiOptions from "../ApiOptions"
import { SettingsCheckbox } from "../common/SettingsCheckbox"
import EscalationModelTab from "../EscalationModelTab"
import ImageGenModelTab from "../ImageGenModelTab"
import Section from "../Section"
import { type ConfigTab, isModelTab } from "../utils/configTabs"
import { flushPendingEdits } from "../utils/pendingEdits"
import { syncModeConfigurations } from "../utils/providerUtils"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"
import type { ApiConfigurationProfileScope } from "../utils/useApiConfigurationProfiles"
import VisionModelTab from "../VisionModelTab"

interface ApiConfigurationSectionProps {
	renderSectionHeader?: (tabId: string) => JSX.Element | null
	initialModelTab?: "recommended" | "free"
}

/**
 * None of Vision, Agents and Escalation is a `Mode`: each configures a second
 * model rather than a mode of the session's.
 */

/** Whether the stored image endpoint names both a URL and a model. */
function isImageEndpointComplete(raw: string): boolean {
	if (!raw) {
		return false
	}
	try {
		const parsed = JSON.parse(raw) as { baseUrl?: unknown; model?: unknown }
		return (
			typeof parsed?.baseUrl === "string" &&
			parsed.baseUrl.trim() !== "" &&
			typeof parsed?.model === "string" &&
			parsed.model.trim() !== ""
		)
	} catch {
		return false
	}
}

const ApiConfigurationSection = ({ renderSectionHeader, initialModelTab }: ApiConfigurationSectionProps) => {
	const {
		planActSeparateModelsSetting,
		visionModelEnabled,
		visionModeApiConfiguration,
		agentsModelEnabled,
		agentsModeApiConfiguration,
		escalationModelEnabled,
		escalationModeApiConfiguration,
		imageGenEnabled,
		imageGenEndpoint,
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
	// And of the Escalation tab. The consequence here is the quietest of the
	// three: nothing fails, the model is simply never offered the expert, and a
	// guard that would have handed the task over stops the run instead — which
	// is exactly what it did before the feature existed.
	const escalationUnconfigured =
		resolveScopedModelStatus(escalationModelEnabled, escalationModeApiConfiguration) === "unconfigured"
	// And of the image endpoint, where the consequence is quieter and so worth
	// stating louder: the tool is simply not offered, so the model never learns
	// it could have made a picture and the user sees no error at all.
	// Read from the stored record rather than `resolveScopedModelStatus`, which
	// knows about provider snapshots and this is not one.
	const imageGenUnconfigured = imageGenEnabled && !isImageEndpointComplete(imageGenEndpoint)
	const [currentTab, setCurrentTab] = useState<ConfigTab>(mode)
	const { handleFieldsChange } = useApiConfigurationHandlers()

	// Switching panel unmounts the one being left, and a field still inside its
	// debounce goes with it. Start its write first, so what reaches
	// providers.json is the value that was on screen rather than the one before
	// it. Not awaited -- the writes are in flight by the time this returns.
	const switchPanel = (tab: ConfigTab) => {
		void flushPendingEdits()
		setCurrentTab(tab)
	}

	// A tab can be turned off while it is showing; fall back rather than render
	// a configuration the user can no longer see the toggle for.
	const scopedTabOff =
		(currentTab === "vision" && !visionModelEnabled) ||
		(currentTab === "agents" && !agentsModelEnabled) ||
		(currentTab === "escalation" && !escalationModelEnabled) ||
		(currentTab === "imagegen" && !imageGenEnabled)
	const activeTab: ConfigTab = scopedTabOff ? mode : currentTab
	// The feature toggles belong to the Model tab and are shown only there.
	//
	// They used to sit below the tab content on every tab, which put "Use a
	// different model for escalation" directly under the Escalation tab's own
	// settings -- and unticking it there removes the tab you are standing on,
	// unmounting the panel mid-edit and losing whatever was typed into it. The
	// toggles say which tabs exist; the tab they switch off is the wrong place
	// to offer them.
	const onModelTab = isModelTab(activeTab)
	const showTabs =
		planActSeparateModelsSetting || visionModelEnabled || agentsModelEnabled || escalationModelEnabled || imageGenEnabled
	// One profile list for every tab; only the target changes with the tab. The
	// Images tab is not in it: a profile is a provider and a model for a
	// conversation, and that tab configures neither.
	const profileScope: ApiConfigurationProfileScope =
		activeTab === "vision"
			? { kind: "vision" }
			: activeTab === "agents"
				? { kind: "agents" }
				: activeTab === "escalation"
					? { kind: "escalation" }
					: { kind: "mode", mode: activeTab === "imagegen" ? mode : activeTab }

	return (
		<div>
			{renderSectionHeader?.("api-config")}
			<Section>
				{activeTab === "vision" || activeTab === "agents" || activeTab === "escalation" ? (
					<ApiConfigProfileBar
						description={`Saving here stores the ${activeTab} model's settings. Profiles are shared with the other tabs, so one saved from Act can be loaded here.`}
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
										onClick={() => switchPanel("plan")}
										style={{
											opacity: 1,
											cursor: "pointer",
										}}>
										Plan Mode
									</TabButton>
									<TabButton
										disabled={activeTab === "act"}
										isActive={activeTab === "act"}
										onClick={() => switchPanel("act")}
										style={{
											opacity: 1,
											cursor: "pointer",
										}}>
										Act Mode
									</TabButton>
								</>
							) : (
								<TabButton
									disabled={isModelTab(activeTab)}
									isActive={isModelTab(activeTab)}
									onClick={() => switchPanel(mode)}
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
									onClick={() => switchPanel("vision")}
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
									onClick={() => switchPanel("agents")}
									style={{
										opacity: 1,
										cursor: "pointer",
									}}>
									Agents
								</TabButton>
							) : null}
							{escalationModelEnabled ? (
								<TabButton
									disabled={activeTab === "escalation"}
									isActive={activeTab === "escalation"}
									onClick={() => switchPanel("escalation")}
									style={{
										opacity: 1,
										cursor: "pointer",
									}}>
									Escalation
								</TabButton>
							) : null}
							{imageGenEnabled ? (
								<TabButton
									disabled={activeTab === "imagegen"}
									isActive={activeTab === "imagegen"}
									onClick={() => switchPanel("imagegen")}
									style={{
										opacity: 1,
										cursor: "pointer",
									}}>
									Images
								</TabButton>
							) : null}
						</div>

						{/* Content container */}
						<div className="-mb-3">
							{activeTab === "vision" ? (
								<VisionModelTab />
							) : activeTab === "agents" ? (
								<AgentsModelTab />
							) : activeTab === "escalation" ? (
								<EscalationModelTab />
							) : activeTab === "imagegen" ? (
								<ImageGenModelTab />
							) : (
								<ApiOptions currentMode={activeTab} initialModelTab={initialModelTab} showModelOptions={true} />
							)}
						</div>
					</div>
				) : (
					<ApiOptions currentMode={mode} initialModelTab={initialModelTab} showModelOptions={true} />
				)}

				{onModelTab ? (
					<>
						<div className="mb-[5px]">
							<SettingsCheckbox
								checked={escalationModelEnabled}
								className="mb-[5px]"
								onChange={async (checked: boolean) => {
									try {
										await StateServiceClient.updateSettings(
											UpdateSettingsRequest.create({ escalationModelEnabled: checked }),
										)
									} catch (error) {
										console.error("Failed to update escalation model setting:", error)
										throw error
									}
								}}>
								Use a different model for escalation
							</SettingsCheckbox>
							<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
								When the model gets stuck it can hand the task to the model on the Escalation tab — on request, or
								when a guard would otherwise stop the run. The expert is meant to be the expensive one: a metered
								account, a limited allowance, or a larger model that has to be loaded. It is told so, and asked
								not to be called for work the session's own model can finish.
							</p>
							{escalationUnconfigured ? (
								<p className="text-xs mt-[5px] text-(--vscode-errorForeground)">
									The Escalation tab does not name both a provider and a model, so there is nothing to escalate
									to and the guards will stop the run as before. Pick a provider <em>and</em> a model on the
									Escalation tab.
								</p>
							) : null}
						</div>

						<div className="mb-[5px]">
							<SettingsCheckbox
								checked={planActSeparateModelsSetting}
								className="mb-[5px]"
								onChange={async (checked: boolean) => {
									try {
										// If unchecking the toggle, wait a bit for state to update, then sync configurations
										if (!checked) {
											// `activeTab` is a plan/act mode here: this
											// whole stack only renders on the Model
											// tab, which is what `onModelTab` above
											// establishes. The scoped-tab fallback to
											// `mode` that used to stand here is dead
											// code inside that branch.
											await syncModeConfigurations(apiConfiguration, activeTab, handleFieldsChange)
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
								Switching between Plan and Act mode will persist the API and model used in the previous mode. This
								may be helpful e.g. when using a strong reasoning model to architect a plan for a cheaper coding
								model to act on.
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
								Images produced by tools — browser screenshots, for example — are sent to the model configured on
								the Vision tab, which describes them in text for the main model. Useful when the main model cannot
								read images at all, or reads them poorly.
							</p>
							{visionUnconfigured ? (
								<p className="text-xs mt-[5px] text-(--vscode-errorForeground)">
									The Vision tab does not name both a provider and a model, so nothing will describe images:
									they will not be accepted, and any already in a task are dropped rather than sent to a main
									model that cannot read them. Pick a provider <em>and</em> a model on the Vision tab.
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
								Delegated agents otherwise run on the session's own model, with the session's own context window
								and sampler. The Agents tab gives them their own — a smaller or cheaper model under a strong lead,
								or the same model with a window sized for the narrower job.
							</p>
							{agentsUnconfigured ? (
								<p className="text-xs mt-[5px] text-(--vscode-errorForeground)">
									The Agents tab does not name both a provider and a model, so delegated agents keep running on
									the session's model. Pick a provider <em>and</em> a model on the Agents tab.
								</p>
							) : null}
						</div>

						<div className="mb-[5px]">
							<SettingsCheckbox
								checked={imageGenEnabled}
								className="mb-[5px]"
								onChange={async (checked: boolean) => {
									try {
										await StateServiceClient.updateSettings(
											UpdateSettingsRequest.create({ imageGenEnabled: checked }),
										)
									} catch (error) {
										console.error("Failed to update image generation setting:", error)
										throw error
									}
								}}>
								Use an endpoint for image generation
							</SettingsCheckbox>
							<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
								Offers the <code>generate_image</code> tool, which turns a description into a picture and saves it
								into the workspace — an app icon, a placeholder sprite, a mockup of a layout before it is built.
								The Images tab names where to generate them: any endpoint serving the OpenAI images API, local or
								hosted. Nothing is called until the model asks for a picture.
							</p>
							{imageGenUnconfigured ? (
								<p className="text-xs mt-[5px] text-(--vscode-errorForeground)">
									The Images tab does not name both an endpoint and a model, so the tool is not offered at all
									and the model is never told it could make one. Fill in both on the Images tab.
								</p>
							) : null}
						</div>
					</>
				) : null}
			</Section>
		</div>
	)
}

export default ApiConfigurationSection

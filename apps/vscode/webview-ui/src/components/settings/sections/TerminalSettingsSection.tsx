import { UpdateTerminalConnectionTimeoutResponse } from "@shared/proto/index.cline"
import { VSCodeCheckbox, VSCodeDropdown, VSCodeOption, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import React, { useState } from "react"
import { PlatformType } from "@/config/platform.config"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { usePlatform } from "@/context/PlatformContext"
import { StateServiceClient } from "../../../services/grpc-client"
import Section from "../Section"
import { updateSetting } from "../utils/settingsHandlers"

interface TerminalSettingsSectionProps {
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const TerminalSettingsSection: React.FC<TerminalSettingsSectionProps> = ({ renderSectionHeader }) => {
	const {
		shellIntegrationTimeout,
		terminalReuseEnabled,
		maxTerminals,
		defaultTerminalProfile,
		availableTerminalProfiles,
		vscodeTerminalExecutionMode,
	} = useExtensionState()
	const platformConfig = usePlatform()
	const isVsCodePlatform = platformConfig.type === PlatformType.VSCODE
	const executionMode = vscodeTerminalExecutionMode ?? "vscodeTerminal"
	const isBackgroundExec = executionMode === "backgroundExec"

	const [inputValue, setInputValue] = useState((shellIntegrationTimeout / 1000).toString())
	const [inputError, setInputError] = useState<string | null>(null)

	const handleTimeoutChange = (event: Event) => {
		const target = event.target as HTMLInputElement
		const value = target.value

		setInputValue(value)

		const seconds = Number.parseFloat(value)
		if (Number.isNaN(seconds) || seconds <= 0) {
			setInputError("Please enter a positive number")
			return
		}

		setInputError(null)
		const timeoutMs = Math.round(seconds * 1000)

		StateServiceClient.updateTerminalConnectionTimeout({ timeoutMs })
			.then((response: UpdateTerminalConnectionTimeoutResponse) => {
				const timeoutMs = response.timeoutMs
				// Backend calls postStateToWebview(), so state will update via subscription
				// Just sync the input value with the confirmed backend value
				if (timeoutMs !== undefined) {
					setInputValue((timeoutMs / 1000).toString())
				}
			})
			.catch((error) => {
				console.error("Failed to update terminal connection timeout:", error)
			})
	}

	const handleInputBlur = () => {
		if (inputError) {
			setInputValue((shellIntegrationTimeout / 1000).toString())
			setInputError(null)
		}
	}

	const [maxTerminalsInput, setMaxTerminalsInput] = useState(String(maxTerminals ?? 5))
	const [maxTerminalsError, setMaxTerminalsError] = useState<string | null>(null)

	// Saved on every valid keystroke, like the timeout above. 0 is a value
	// ("no limit"), so the check is for a whole number, not a positive one.
	const handleMaxTerminalsChange = (event: Event) => {
		const value = (event.target as HTMLInputElement).value
		setMaxTerminalsInput(value)
		const trimmed = value.trim()
		if (!/^\d+$/.test(trimmed)) {
			setMaxTerminalsError("Enter a whole number, or 0 for no limit")
			return
		}
		setMaxTerminalsError(null)
		updateSetting("maxTerminals", Number.parseInt(trimmed, 10))
	}

	const handleTerminalReuseChange = (event: Event) => {
		const target = event.target as HTMLInputElement
		const checked = target.checked
		updateSetting("terminalReuseEnabled", checked)
	}

	const handleExecutionModeChange = (event: Event) => {
		const target = event.target as HTMLSelectElement
		const value = target.value === "backgroundExec" ? "backgroundExec" : "vscodeTerminal"
		updateSetting("vscodeTerminalExecutionMode", value)
	}

	// Use any to avoid type conflicts between Event and FormEvent
	const handleDefaultTerminalProfileChange = (event: any) => {
		const target = event.target as HTMLSelectElement
		const profileId = target.value

		// Save immediately using the consolidated updateSettings approach
		updateSetting("defaultTerminalProfile", profileId || "default")
	}

	const profilesToShow = availableTerminalProfiles

	return (
		<div>
			{renderSectionHeader("terminal")}
			<Section>
				<div className="mb-5" id="terminal-settings-section">
					{isVsCodePlatform && (
						<div className="mb-4">
							<label className="font-medium block mb-1" htmlFor="terminal-execution-mode">
								Terminal Execution Mode
							</label>
							<VSCodeDropdown
								className="w-full"
								id="terminal-execution-mode"
								onChange={(event) => handleExecutionModeChange(event as Event)}
								value={executionMode}>
								<VSCodeOption value="vscodeTerminal">VS Code Terminal</VSCodeOption>
								<VSCodeOption value="backgroundExec">Background Exec</VSCodeOption>
							</VSCodeDropdown>
							<p className="text-xs text-[var(--vscode-descriptionForeground)] mt-1">
								Choose whether Cerebriline runs commands in the VS Code terminal or a background process.
							</p>
						</div>
					)}

					{isVsCodePlatform && !isBackgroundExec && (
						<>
							<div className="mb-4">
								<div className="mb-2">
									<label className="font-medium block mb-1">Shell integration timeout (seconds)</label>
									<div className="flex items-center">
										<VSCodeTextField
											className="w-full"
											onBlur={handleInputBlur}
											onChange={(event) => handleTimeoutChange(event as Event)}
											placeholder="Enter timeout in seconds"
											value={inputValue}
										/>
									</div>
									{inputError && (
										<div className="text-(--vscode-errorForeground) text-xs mt-1">{inputError}</div>
									)}
								</div>
								<p className="text-xs text-(--vscode-descriptionForeground)">
									Set how long Cerebriline waits for shell integration to activate before executing commands.
									Increase this value if you experience terminal connection timeouts.
								</p>
							</div>

							<div className="mb-4">
								<div className="flex items-center mb-2">
									<VSCodeCheckbox
										checked={terminalReuseEnabled ?? true}
										onChange={(event) => handleTerminalReuseChange(event as Event)}>
										Enable aggressive terminal reuse
									</VSCodeCheckbox>
								</div>
								<p className="text-xs text-(--vscode-descriptionForeground)">
									When enabled, Cerebriline will reuse existing terminal windows that aren't in the current
									working directory. Disable this if you experience issues with task lockout after a terminal
									command.
								</p>
							</div>

							<div className="mb-4">
								<div className="mb-2">
									<label className="font-medium block mb-1" htmlFor="max-terminals">
										Maximum terminals
									</label>
									<VSCodeTextField
										className="w-full"
										id="max-terminals"
										onChange={(event) => handleMaxTerminalsChange(event as Event)}
										placeholder="5"
										value={maxTerminalsInput}
									/>
									{maxTerminalsError && (
										<div className="text-(--vscode-errorForeground) text-xs mt-1">{maxTerminalsError}</div>
									)}
								</div>
								<p className="text-xs text-(--vscode-descriptionForeground)">
									How many Cerebriline terminals this window may have open at once; 0 for no limit. At the
									limit, Cerebriline closes its least recently used idle terminal to open a new one, and when
									all of them are busy (a dev server, a watcher) it runs the command without a terminal and says
									so. It never stops a running command to make room.
								</p>
							</div>
						</>
					)}

					{/* Terminal choice affects both foreground and background execution mode. */}
					<div className="mb-4">
						<label className="font-medium block mb-1" htmlFor="default-terminal-profile">
							Default Terminal Profile
						</label>
						<VSCodeDropdown
							className="w-full"
							id="default-terminal-profile"
							onChange={handleDefaultTerminalProfileChange}
							value={defaultTerminalProfile || "default"}>
							{profilesToShow.map((profile) => (
								<VSCodeOption key={profile.id} title={profile.description} value={profile.id}>
									{profile.name}
								</VSCodeOption>
							))}
						</VSCodeDropdown>
						<p className="text-xs text-(--vscode-descriptionForeground) mt-1">
							Select the default terminal Cerebriline will use. 'Default' uses your VSCode global setting.
						</p>
					</div>
					<div className="mt-5 p-3 bg-(--vscode-textBlockQuote-background) rounded border border-(--vscode-textBlockQuote-border)">
						<p className="text-[13px] m-0">
							<strong>Having terminal issues?</strong> Check our{" "}
							<a
								className="text-(--vscode-textLink-foreground) underline hover:no-underline"
								href="https://docs.cline.bot/troubleshooting/terminal-quick-fixes"
								rel="noopener noreferrer"
								target="_blank">
								Terminal Quick Fixes
							</a>{" "}
							or the{" "}
							<a
								className="text-(--vscode-textLink-foreground) underline hover:no-underline"
								href="https://docs.cline.bot/troubleshooting/terminal-integration-guide"
								rel="noopener noreferrer"
								target="_blank">
								Complete Troubleshooting Guide
							</a>
							.
						</p>
					</div>
				</div>
			</Section>
		</div>
	)
}

export default TerminalSettingsSection

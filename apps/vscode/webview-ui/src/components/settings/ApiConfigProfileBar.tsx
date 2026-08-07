import { VSCodeButton, VSCodeDropdown, VSCodeOption, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useState } from "react"
import { type ApiConfigurationProfileScope, useApiConfigurationProfiles } from "./utils/useApiConfigurationProfiles"

const NO_PROFILE = "__none__"

interface ApiConfigProfileBarProps {
	/** The configuration in view; decides what a save captures and a load writes. */
	scope: ApiConfigurationProfileScope
	/** Shown under the controls, e.g. to say what this tab's profile covers. */
	description?: string
}

/**
 * Load, save and update named API-configuration profiles.
 *
 * Sits above the Plan/Act/Vision tabs so it is reachable from all of them, and
 * always acts on the tab currently in view. One list serves all three: what a
 * profile holds is a provider, a model and the settings around them, and none
 * of that is specific to the tab it was saved from. Which profile is loaded is
 * tracked per tab, because loading one into Vision says nothing about what Plan
 * and Act are holding.
 */
const ApiConfigProfileBar = ({ scope, description }: ApiConfigProfileBarProps) => {
	const { profiles, activeName, isDirty, suggestedName, loadProfile, saveProfile, deleteProfile } =
		useApiConfigurationProfiles(scope)
	const [isNaming, setIsNaming] = useState(false)
	const [draftName, setDraftName] = useState("")

	// Reopening the field after the panel has changed should offer a name for
	// what is in it now, not the one suggested the last time it was opened.
	useEffect(() => {
		if (isNaming) {
			setDraftName(suggestedName)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isNaming])

	const nameIsTaken = profiles.some((profile) => profile.name.toLowerCase() === draftName.trim().toLowerCase())

	// A red outline on the buttons that resolve it.
	//
	// The wording below already said the panel had drifted from the profile, and
	// it was missed: it is a line of small grey-on-grey text under a row of
	// controls, and the controls themselves looked exactly as they do when
	// everything is saved. The colour goes where the user is already looking.
	const unsavedStyle = isDirty
		? ({
				background: "transparent",
				border: "1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground))",
				color: "var(--vscode-errorForeground)",
			} as React.CSSProperties)
		: undefined

	const commitSave = async () => {
		if (!draftName.trim()) {
			return
		}
		await saveProfile(draftName)
		setIsNaming(false)
	}

	return (
		<div className="mb-4 pb-3 border-0 border-b border-solid border-(--vscode-panel-border)">
			<div className="flex items-center gap-2 flex-wrap">
				<label className="text-xs shrink-0" htmlFor="api-config-profile">
					Profile
				</label>
				<VSCodeDropdown
					className="flex-1 min-w-[140px]"
					id="api-config-profile"
					onChange={async (event: any) => {
						const value = event.target.value
						if (value && value !== NO_PROFILE) {
							await loadProfile(value)
						}
					}}
					value={activeName || NO_PROFILE}>
					<VSCodeOption value={NO_PROFILE}>
						{profiles.length === 0 ? "No saved profiles" : "Select a profile…"}
					</VSCodeOption>
					{profiles.map((profile) => (
						<VSCodeOption key={profile.name} value={profile.name}>
							{profile.name}
						</VSCodeOption>
					))}
				</VSCodeDropdown>

				{activeName && isDirty ? (
					<>
						<VSCodeButton appearance="secondary" onClick={() => saveProfile(activeName)} style={unsavedStyle}>
							Update
						</VSCodeButton>
						{/* Reloading was only reachable by picking a different profile
						    and picking this one back: the dropdown fires nothing when
						    the value it already holds is chosen again, so there was no
						    way to discard an edit and return to what was saved. */}
						<VSCodeButton appearance="secondary" onClick={() => loadProfile(activeName)}>
							Revert
						</VSCodeButton>
					</>
				) : null}
				<VSCodeButton appearance="secondary" onClick={() => setIsNaming((open) => !open)} style={unsavedStyle}>
					Save as…
				</VSCodeButton>
				{activeName ? (
					<VSCodeButton appearance="secondary" onClick={() => deleteProfile(activeName)}>
						Delete
					</VSCodeButton>
				) : null}
			</div>

			{isNaming ? (
				<div className="flex items-center gap-2 mt-2">
					<VSCodeTextField
						className="flex-1"
						onInput={(event: any) => setDraftName(event.target.value)}
						onKeyDown={(event: any) => {
							if (event.key === "Enter") {
								void commitSave()
							}
							if (event.key === "Escape") {
								setIsNaming(false)
							}
						}}
						placeholder="Profile name"
						value={draftName}
					/>
					<VSCodeButton appearance="primary" disabled={!draftName.trim()} onClick={commitSave}>
						{nameIsTaken ? "Overwrite" : "Save"}
					</VSCodeButton>
					<VSCodeButton appearance="secondary" onClick={() => setIsNaming(false)}>
						Cancel
					</VSCodeButton>
				</div>
			) : null}

			<p className="text-xs mt-[5px] mb-0 text-(--vscode-descriptionForeground)">
				{activeName && isDirty ? (
					<span className="text-(--vscode-errorForeground)">
						“{activeName}” has unsaved changes — Update to keep them, or Revert to discard them.
					</span>
				) : activeName ? (
					<span>Loaded from “{activeName}”.</span>
				) : (
					// Without this the panel looks like it simply has no profile
					// selected, when in fact these settings are live and unsaved.
					<span>These settings are not saved to a profile.</span>
				)}{" "}
				{description ??
					"A profile stores every setting on this tab — provider, model, URL, context size and the rest. API keys are stored separately and are not part of a profile."}
			</p>
		</div>
	)
}

export default ApiConfigProfileBar

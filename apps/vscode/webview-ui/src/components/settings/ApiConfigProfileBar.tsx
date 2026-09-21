import { VSCodeButton, VSCodeDropdown, VSCodeOption, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { AlertTriangle } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { DROPDOWN_Z_INDEX, DropdownContainer, SETTINGS_MODAL_Z_INDEX } from "./ApiOptions"
import { hasPendingEdits } from "./utils/pendingEdits"
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
	// The profile a confirmed switch would load, while the question is open.
	const [pendingSwitch, setPendingSwitch] = useState<string | null>(null)
	// Picking a name moves the dropdown immediately, before anything has been
	// loaded, so a cancelled switch leaves it showing a profile that is not the
	// one in the panel. Nothing puts it back: `value` still holds `activeName`,
	// which has not changed, so React has nothing to re-apply. Bumping this
	// remounts the dropdown, which re-applies `value` on mount.
	const [selectionEpoch, setSelectionEpoch] = useState(0)

	// Reopening the field after the panel has changed should offer a name for
	// what is in it now, not the one suggested the last time it was opened.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `suggestedName` tracks the panel and changes as the user types, so depending on it would overwrite the name being typed on every keystroke -- the suggestion is read once, when the field opens.
	useEffect(() => {
		if (isNaming) {
			setDraftName(suggestedName)
		}
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

	/** Puts the dropdown back to the profile that is actually loaded. */
	const restoreSelection = useCallback(() => {
		setPendingSwitch(null)
		setSelectionEpoch((epoch) => epoch + 1)
	}, [])

	// A modal that can only be left with the mouse traps a keyboard user, and
	// the backdrop it would otherwise hang off is not focusable.
	useEffect(() => {
		if (!pendingSwitch) {
			return
		}
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				restoreSelection()
			}
		}
		document.addEventListener("keydown", onKey)
		return () => document.removeEventListener("keydown", onKey)
	}, [pendingSwitch, restoreSelection])

	/**
	 * Applies a profile, asking first if that would lose something.
	 *
	 * Revert never asks: saying it is how the user asks to discard. Load does,
	 * because the button only reads "Load" rather than "Revert" when `isDirty`
	 * is false -- and a value typed within the last 800ms has not reached the
	 * store yet, so `isDirty` is false while there is something to lose.
	 */
	const requestLoad = (name: string) => {
		if (!isDirty && hasPendingEdits()) {
			setPendingSwitch(name)
			return
		}
		return loadProfile(name)
	}

	const switchTo = async (name: string) => {
		setPendingSwitch(null)
		await loadProfile(name)
	}

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
				{/* The open list has to paint over the provider controls below it. The
				    API Provider combobox sets `zIndex: DROPDOWN_Z_INDEX` on its own
				    input, so a list opened from up here was drawn underneath it and cut
				    off — the more profiles are saved, the more of the list is lost.
				    This is the container the provider dropdowns already use, one step
				    higher, and it also pins the list to open downward. */}
				<DropdownContainer className="flex-1 min-w-[140px]" zIndex={DROPDOWN_Z_INDEX + 1}>
					<VSCodeDropdown
						className="w-full"
						id="api-config-profile"
						key={selectionEpoch}
						onChange={async (event) => {
							const value = (event.target as HTMLSelectElement).value
							if (!value || value === NO_PROFILE || value === activeName) {
								return
							}
							// A load overwrites the whole panel, and what it overwrites is
							// not all on screen: a value typed a moment ago may still be
							// sitting inside its debounce, unsaved and invisible to
							// `isDirty`. Ask on either.
							if (isDirty || hasPendingEdits()) {
								setPendingSwitch(value)
								return
							}
							await switchTo(value)
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
				</DropdownContainer>

				{activeName && isDirty ? (
					<VSCodeButton appearance="secondary" onClick={() => saveProfile(activeName)} style={unsavedStyle}>
						Update
					</VSCodeButton>
				) : null}
				{/* Applying the selected profile has to be reachable on its own. The
				    dropdown fires nothing when the value it already holds is picked
				    again, so with a profile selected there was no way to ask for it to
				    be applied — neither to discard an edit nor to retry a load that
				    looked like it had not taken. It is the same action either way; the
				    label says which one it is from where the user is standing. */}
				{activeName ? (
					<VSCodeButton appearance="secondary" onClick={() => requestLoad(activeName)}>
						{isDirty ? "Revert" : "Load"}
					</VSCodeButton>
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

			{pendingSwitch ? (
				// biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a click-away shortcut for Cancel; the same action is on the Cancel button and on Escape, so no behaviour is mouse-only.
				<div
					// Not Tailwind's z-50: that is 50, and the model pickers in
					// this view open their lists at 1,000, so the Model ID list
					// painted over this dialog and its buttons.
					className="fixed inset-0 bg-black/50 flex items-center justify-center"
					onClick={(event) => {
						if (event.target === event.currentTarget) {
							restoreSelection()
						}
					}}
					role="presentation"
					style={{ zIndex: SETTINGS_MODAL_Z_INDEX }}>
					<div
						aria-labelledby="profile-switch-dialog-title"
						aria-modal="true"
						className="bg-(--vscode-editor-background) border border-solid border-(--vscode-panel-border) rounded-lg p-5 w-[400px] max-w-[90vw]"
						role="dialog">
						<div className="flex items-center gap-2 mb-3">
							<AlertTriangle className="w-5 h-5 text-(--vscode-errorForeground)" />
							<h4 className="m-0" id="profile-switch-dialog-title">
								Unsaved changes
							</h4>
						</div>
						<p className="text-sm text-(--vscode-descriptionForeground) mt-0 mb-4">
							Loading “{pendingSwitch}” replaces every setting on this tab.{" "}
							{activeName
								? `The changes you have made since loading “${activeName}” will be lost.`
								: "The changes you have made here are not saved to any profile and will be lost."}
						</p>
						<div className="flex justify-end gap-2 flex-wrap">
							<VSCodeButton appearance="secondary" onClick={restoreSelection}>
								Cancel
							</VSCodeButton>
							{activeName ? (
								<VSCodeButton
									appearance="secondary"
									onClick={async () => {
										const target = pendingSwitch
										setPendingSwitch(null)
										await saveProfile(activeName)
										await loadProfile(target)
									}}>
									Update “{activeName}” first
								</VSCodeButton>
							) : null}
							<VSCodeButton appearance="primary" onClick={() => switchTo(pendingSwitch)}>
								Discard and load
							</VSCodeButton>
						</div>
					</div>
				</div>
			) : null}

			{isNaming ? (
				<div className="flex items-center gap-2 mt-2">
					<VSCodeTextField
						className="flex-1"
						onInput={(event) => setDraftName((event.target as HTMLInputElement).value)}
						onKeyDown={(event: { key: string }) => {
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

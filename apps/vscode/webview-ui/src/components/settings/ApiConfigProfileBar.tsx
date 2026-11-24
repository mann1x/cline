import { EmptyRequest } from "@shared/proto/cline/common"
import { VSCodeButton, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { AlertTriangle, Check } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { FileServiceClient } from "@/services/grpc-client"
import { matchesFilter } from "@/utils/text-filter"
import { DROPDOWN_Z_INDEX, DropdownContainer, SETTINGS_MODAL_Z_INDEX } from "./ApiOptions"
import { hasPendingEdits } from "./utils/pendingEdits"
import { type ApiConfigurationProfileScope, useApiConfigurationProfiles } from "./utils/useApiConfigurationProfiles"

/** Where a right-click landed, and on which profile. */
interface ProfileMenu {
	name: string
	x: number
	y: number
}

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
	const { profiles, activeName, isDirty, suggestedName, loadProfile, saveProfile, deleteProfile, renameProfile } =
		useApiConfigurationProfiles(scope)
	const [isNaming, setIsNaming] = useState(false)
	const [draftName, setDraftName] = useState("")
	// The profile a confirmed switch would load, while the question is open.
	const [pendingSwitch, setPendingSwitch] = useState<string | null>(null)
	// The profile a confirmed Delete would remove, while the question is open.
	// Delete used to act on the click: one misplaced press next to "Save as…"
	// took a profile with it, with nothing to undo.
	const [pendingDelete, setPendingDelete] = useState<string | null>(null)
	// The picker is a combobox, not a dropdown: with many profiles saved the
	// list was too long to find one in (pandorum, 2026-11-22). Typing filters
	// it; closed, the field shows the loaded profile.
	const [listOpen, setListOpen] = useState(false)
	const [query, setQuery] = useState("")
	const [highlight, setHighlight] = useState(-1)
	const pickerRef = useRef<HTMLDivElement>(null)
	const itemRefs = useRef<(HTMLDivElement | null)[]>([])
	// The right-click menu, and the rename it can start. Renaming used to take
	// "Save as…" under the new name and a Delete of the old one.
	const [menu, setMenu] = useState<ProfileMenu | null>(null)
	const [renaming, setRenaming] = useState<string | null>(null)
	const [renameDraft, setRenameDraft] = useState("")
	// Agents name a profile in their own files; a rename cannot edit those.
	const [agentsNaming, setAgentsNaming] = useState<string[]>([])

	// The field opens holding the loaded profile's name, selected, so typing
	// replaces it; until it is changed it is not a filter.
	const filtering = query.trim() !== "" && query !== activeName
	const shown = useMemo(
		() => (filtering ? profiles.filter((profile) => matchesFilter(query, profile.name)) : profiles),
		[profiles, query, filtering],
	)

	// Reopening the field after the panel has changed should offer a name for
	// what is in it now, not the one suggested the last time it was opened.
	//
	// The loaded profile's own name first, edited or not: "Save as…" from a
	// profile is most often a variant of it, and the generated name threw away
	// the one the user had chosen. The generated name is for a panel that is
	// not loaded from any profile.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `suggestedName` tracks the panel and changes as the user types, so depending on it would overwrite the name being typed on every keystroke -- the suggestion is read once, when the field opens.
	useEffect(() => {
		if (isNaming) {
			setDraftName(activeName || suggestedName)
		}
	}, [isNaming])

	const nameIsTaken = profiles.some((profile) => profile.name.toLowerCase() === draftName.trim().toLowerCase())
	const renameTarget = renaming ?? ""
	const renameTaken =
		renameDraft.trim().toLowerCase() !== renameTarget.toLowerCase() &&
		profiles.some((profile) => profile.name.toLowerCase() === renameDraft.trim().toLowerCase())
	const renameUnchanged = renameDraft.trim() === renameTarget

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

	/** Closes a switch that was not confirmed; the field shows the loaded profile again. */
	const restoreSelection = useCallback(() => {
		setPendingSwitch(null)
	}, [])

	const closeList = useCallback(() => {
		setListOpen(false)
		setHighlight(-1)
		setQuery("")
	}, [])

	// A click anywhere else closes the list and the menu.
	useEffect(() => {
		if (!listOpen && !menu) {
			return
		}
		const onDown = (event: MouseEvent) => {
			const target = event.target as Node
			if (menu && (target as Element).closest?.("[data-profile-menu]")) {
				return
			}
			setMenu(null)
			if (pickerRef.current && !pickerRef.current.contains(target)) {
				closeList()
			}
		}
		document.addEventListener("mousedown", onDown)
		return () => document.removeEventListener("mousedown", onDown)
	}, [listOpen, menu, closeList])

	// The highlighted profile stays in view while the arrows move it.
	useEffect(() => {
		if (highlight >= 0) {
			itemRefs.current[highlight]?.scrollIntoView?.({ block: "nearest" })
		}
	}, [highlight])

	// A new filter starts the highlight over.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `query` is the trigger, not a value the body reads.
	useEffect(() => {
		setHighlight(-1)
	}, [query])

	// The list opens at the loaded profile, highlighted and in the middle of
	// the view, as a native select does: with a long list it opened at the
	// top, and the ticked profile had to be scrolled to every time (pandorum,
	// 2026-11-24). After the reset above, which opening also triggers by
	// putting the name in the field, so the highlight it sets is the one kept.
	// biome-ignore lint/correctness/useExhaustiveDependencies: opening is the trigger; the list and the name are read as they are at that moment.
	useEffect(() => {
		if (!listOpen) {
			return
		}
		const index = shown.findIndex((profile) => profile.name === activeName)
		if (index < 0) {
			return
		}
		setHighlight(index)
		itemRefs.current[index]?.scrollIntoView?.({ block: "center" })
	}, [listOpen])

	// Which agents name the profile being renamed, so the row can say they keep
	// the old name: their files are the user's, and a rename does not edit them.
	useEffect(() => {
		if (!renaming) {
			setAgentsNaming([])
			return
		}
		let current = true
		FileServiceClient.refreshAgents(EmptyRequest.create({}))
			.then((response) => {
				if (current) {
					setAgentsNaming(
						(response.agents ?? [])
							.filter((agent) => agent.profile.trim().toLowerCase() === renaming.toLowerCase())
							.map((agent) => agent.name),
					)
				}
			})
			.catch(() => undefined)
		return () => {
			current = false
		}
	}, [renaming])

	// A modal that can only be left with the mouse traps a keyboard user, and
	// the backdrop it would otherwise hang off is not focusable.
	useEffect(() => {
		if (!pendingSwitch && !pendingDelete && !menu) {
			return
		}
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				if (pendingSwitch) {
					restoreSelection()
				}
				setPendingDelete(null)
				setMenu(null)
			}
		}
		document.addEventListener("keydown", onKey)
		return () => document.removeEventListener("keydown", onKey)
	}, [pendingSwitch, pendingDelete, menu, restoreSelection])

	/**
	 * Copy on the profile picker copies the selected profile's name.
	 *
	 * The picker was a dropdown with no text to select, and a Copy copied
	 * nothing -- when what the user wanted was the name, to start a "Save as…"
	 * from it rather than from the generated one. It is a text field now, and
	 * "Copy name" is on its right-click menu, but a copy with nothing selected
	 * still answers with the name. A real text selection still wins.
	 */
	const copyProfileName = (event: React.ClipboardEvent) => {
		if (!activeName || (window.getSelection()?.toString() ?? "") !== "") {
			return
		}
		event.clipboardData.setData("text/plain", activeName)
		event.preventDefault()
	}

	/**
	 * Ctrl+C / Cmd+C on the picker, which the copy event above does not see.
	 *
	 * With the dropdown focused and nothing selected there is no copy to
	 * answer: the webview dispatches no `copy` event without a selection, so
	 * the handler above only ever ran from a context menu. The key itself is
	 * the reliable signal.
	 */
	const copyProfileNameOnKey = (event: React.KeyboardEvent) => {
		if (
			!activeName ||
			!(event.ctrlKey || event.metaKey) ||
			event.altKey ||
			event.shiftKey ||
			event.key.toLowerCase() !== "c" ||
			(window.getSelection()?.toString() ?? "") !== ""
		) {
			return
		}
		event.preventDefault()
		void navigator.clipboard?.writeText(activeName).catch(() => undefined)
	}

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

	/** A profile picked from the list. */
	const choose = async (name: string) => {
		closeList()
		if (name === activeName) {
			return
		}
		// A load overwrites the whole panel, and what it overwrites is not all
		// on screen: a value typed a moment ago may still be sitting inside its
		// debounce, unsaved and invisible to `isDirty`. Ask on either.
		if (isDirty || hasPendingEdits()) {
			setPendingSwitch(name)
			return
		}
		await switchTo(name)
	}

	const openList = (event?: { target: EventTarget | null }) => {
		setListOpen(true)
		setQuery(activeName)
		// Selected, so the first key typed replaces the name and filters.
		const field = event?.target as { select?: () => void } | null
		field?.select?.()
	}

	const startRename = (name: string) => {
		setMenu(null)
		closeList()
		setIsNaming(false)
		setRenaming(name)
		setRenameDraft(name)
	}

	const commitRename = async () => {
		if (!renaming || !renameDraft.trim() || renameTaken || renameUnchanged) {
			return
		}
		if (await renameProfile(renaming, renameDraft)) {
			setRenaming(null)
		}
	}

	const copyName = (name: string) => {
		setMenu(null)
		void navigator.clipboard?.writeText(name).catch(() => undefined)
	}

	/** The menu at the pointer, or under the field when it came from the keyboard. */
	const openMenu = (name: string, at: { x: number; y: number }) => {
		setMenu({ name, x: at.x, y: at.y })
	}

	const onPickerKey = (event: React.KeyboardEvent) => {
		// The context-menu key and Shift+F10 open the menu on the highlighted
		// profile, or the loaded one, as a right-click would.
		if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
			const name = listOpen && highlight >= 0 ? shown[highlight]?.name : activeName
			if (name) {
				event.preventDefault()
				const box = (event.target as HTMLElement).getBoundingClientRect?.()
				openMenu(name, { x: box?.left ?? 0, y: box?.bottom ?? 0 })
			}
			return
		}
		if (!listOpen) {
			if (event.key === "ArrowDown" || event.key === "Enter") {
				event.preventDefault()
				openList(event)
			}
			return
		}
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault()
				setHighlight((index) => Math.min(index + 1, shown.length - 1))
				break
			case "ArrowUp":
				event.preventDefault()
				setHighlight((index) => Math.max(index - 1, 0))
				break
			case "Enter": {
				event.preventDefault()
				// The highlighted one, or the only one the filter left.
				const name = highlight >= 0 ? shown[highlight]?.name : shown.length === 1 ? shown[0].name : undefined
				if (name) {
					void choose(name)
				}
				break
			}
			case "Escape":
				event.preventDefault()
				closeList()
				break
		}
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
				<DropdownContainer
					className="flex-1 min-w-[140px]"
					onCopy={copyProfileName}
					onKeyDown={copyProfileNameOnKey}
					ref={pickerRef}
					zIndex={DROPDOWN_Z_INDEX + 1}>
					<VSCodeTextField
						aria-autocomplete="list"
						aria-controls="api-config-profile-list"
						aria-expanded={listOpen}
						className="w-full"
						id="api-config-profile"
						onClick={(event) => {
							if (!listOpen) {
								openList(event)
							}
						}}
						onContextMenu={(event) => {
							if (!activeName) {
								return
							}
							event.preventDefault()
							openMenu(activeName, { x: event.clientX, y: event.clientY })
						}}
						onFocus={(event) => openList(event)}
						onInput={(event) => {
							setQuery((event.target as HTMLInputElement).value)
							setListOpen(true)
						}}
						onKeyDown={onPickerKey}
						placeholder={profiles.length === 0 ? "No saved profiles" : "Select a profile, or type to filter…"}
						role="combobox"
						value={listOpen ? query : activeName}>
						<span className="codicon codicon-chevron-down" slot="end" />
					</VSCodeTextField>
					{listOpen && profiles.length > 0 ? (
						<div
							className="absolute left-0 right-0 top-full max-h-[260px] overflow-y-auto border border-solid border-(--vscode-list-activeSelectionBackground) bg-(--vscode-dropdown-background) rounded-b-[3px]"
							id="api-config-profile-list"
							role="listbox">
							{shown.length === 0 ? (
								<div className="px-2.5 py-1.5 text-(--vscode-descriptionForeground)">
									No profile matches “{query.trim()}”.
								</div>
							) : (
								shown.map((profile, index) => (
									<div
										aria-selected={profile.name === activeName}
										className={`flex items-center gap-1.5 px-2.5 py-1 cursor-pointer break-all ${
											index === highlight
												? "bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)"
												: ""
										}`}
										key={profile.name}
										onClick={() => void choose(profile.name)}
										onContextMenu={(event) => {
											event.preventDefault()
											setHighlight(index)
											openMenu(profile.name, { x: event.clientX, y: event.clientY })
										}}
										onMouseEnter={() => setHighlight(index)}
										ref={(element) => {
											itemRefs.current[index] = element
										}}
										role="option">
										<Check
											aria-hidden="true"
											className={`w-3.5 h-3.5 shrink-0 ${profile.name === activeName ? "" : "invisible"}`}
										/>
										<span>{profile.name}</span>
									</div>
								))
							)}
							{filtering && shown.length > 0 ? (
								<div className="px-2.5 py-1 text-xs text-(--vscode-descriptionForeground)">
									{shown.length} of {profiles.length} profiles
								</div>
							) : null}
						</div>
					) : null}
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
				<VSCodeButton
					appearance="secondary"
					onClick={() => {
						setRenaming(null)
						setIsNaming((open) => !open)
					}}
					style={unsavedStyle}>
					Save as…
				</VSCodeButton>
				{activeName ? (
					<VSCodeButton appearance="secondary" onClick={() => setPendingDelete(activeName)}>
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

			{pendingDelete ? (
				// biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a click-away shortcut for Cancel; the same action is on the Cancel button and on Escape.
				<div
					className="fixed inset-0 bg-black/50 flex items-center justify-center"
					onClick={(event) => {
						if (event.target === event.currentTarget) {
							setPendingDelete(null)
						}
					}}
					role="presentation"
					style={{ zIndex: SETTINGS_MODAL_Z_INDEX }}>
					<div
						aria-labelledby="profile-delete-dialog-title"
						aria-modal="true"
						className="bg-(--vscode-editor-background) border border-solid border-(--vscode-panel-border) rounded-lg p-5 w-[400px] max-w-[90vw]"
						role="dialog">
						<div className="flex items-center gap-2 mb-3">
							<AlertTriangle className="w-5 h-5 text-(--vscode-errorForeground)" />
							<h4 className="m-0" id="profile-delete-dialog-title">
								Delete “{pendingDelete}”?
							</h4>
						</div>
						<p className="text-sm text-(--vscode-descriptionForeground) mt-0 mb-4">
							The profile is removed from every tab that uses it. The settings on this tab stay as they are; they
							are just no longer saved anywhere. This cannot be undone.
						</p>
						<div className="flex justify-end gap-2 flex-wrap">
							<VSCodeButton appearance="secondary" onClick={() => setPendingDelete(null)}>
								Keep it
							</VSCodeButton>
							<VSCodeButton
								appearance="primary"
								onClick={async () => {
									const target = pendingDelete
									setPendingDelete(null)
									await deleteProfile(target)
								}}>
								Delete profile
							</VSCodeButton>
						</div>
					</div>
				</div>
			) : null}

			{menu ? (
				<div
					className="fixed min-w-[160px] py-1 border border-solid border-(--vscode-menu-border,var(--vscode-panel-border)) bg-(--vscode-menu-background,var(--vscode-editor-background)) text-(--vscode-menu-foreground,var(--vscode-foreground)) rounded shadow-lg"
					data-profile-menu=""
					role="menu"
					style={{ left: menu.x, top: menu.y, zIndex: SETTINGS_MODAL_Z_INDEX }}>
					<div className="px-3 pt-0.5 pb-1 text-xs text-(--vscode-descriptionForeground) truncate max-w-[260px]">
						{menu.name}
					</div>
					{[
						{ label: "Rename…", act: () => startRename(menu.name) },
						{ label: "Copy name", act: () => copyName(menu.name) },
						{
							label: "Delete…",
							act: () => {
								setMenu(null)
								closeList()
								setPendingDelete(menu.name)
							},
						},
					].map((item) => (
						<button
							className="block w-full text-left px-3 py-1 bg-transparent border-0 cursor-pointer text-inherit hover:bg-(--vscode-menu-selectionBackground,var(--vscode-list-activeSelectionBackground)) hover:text-(--vscode-menu-selectionForeground,inherit)"
							key={item.label}
							onClick={item.act}
							role="menuitem"
							type="button">
							{item.label}
						</button>
					))}
				</div>
			) : null}

			{renaming ? (
				<div className="mt-2">
					<div className="flex items-center gap-2">
						<VSCodeTextField
							aria-label={`New name for “${renaming}”`}
							className="flex-1"
							onInput={(event) => setRenameDraft((event.target as HTMLInputElement).value)}
							onKeyDown={(event: { key: string }) => {
								if (event.key === "Enter") {
									void commitRename()
								}
								if (event.key === "Escape") {
									setRenaming(null)
								}
							}}
							placeholder="New profile name"
							value={renameDraft}
						/>
						<VSCodeButton
							appearance="primary"
							disabled={!renameDraft.trim() || renameTaken || renameUnchanged}
							onClick={commitRename}>
							Rename
						</VSCodeButton>
						<VSCodeButton appearance="secondary" onClick={() => setRenaming(null)}>
							Cancel
						</VSCodeButton>
					</div>
					<p className="text-xs mt-1 mb-0 text-(--vscode-descriptionForeground)">
						{renameTaken ? (
							<span className="text-(--vscode-errorForeground)">
								Another profile is already called “{renameDraft.trim()}”.
							</span>
						) : (
							<span>
								Renaming “{renaming}”. Every tab that has it loaded, and the Memory and Library settings that use
								it, follow the new name.
							</span>
						)}
						{agentsNaming.length > 0 ? (
							<span>
								{" "}
								{agentsNaming.length === 1 ? "The agent" : "The agents"} {agentsNaming.join(", ")} name it in{" "}
								{agentsNaming.length === 1 ? "its file" : "their files"}; edit{" "}
								{agentsNaming.length === 1 ? "it" : "them"} on the Agents tab to use the new name.
							</span>
						) : null}
					</p>
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

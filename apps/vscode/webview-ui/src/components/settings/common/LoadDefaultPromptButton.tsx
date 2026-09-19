import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useState } from "react"

interface LoadDefaultPromptButtonProps {
	/** What is in the box now. Whitespace counts as empty. */
	currentValue: string | undefined
	/** The built-in prompt, or `undefined` while the state is still loading. */
	defaultValue: string | undefined
	/** Named in the warning, so a page of four buttons says which one is asking. */
	label: string
	onLoad: (value: string) => void
	disabled?: boolean
}

/**
 * Puts the built-in prompt into the box so it can be edited.
 *
 * The defaults were only ever shown as the field's placeholder, which means the
 * text is visible and unreachable: editing a built-in prompt to try a variation
 * meant opening the source and copying it out. Asked for directly — "If I want
 * to test variations of the prompts on features, I have to go to the source
 * code."
 *
 * The confirmation is the reason this is a component rather than four buttons.
 * A custom prompt is work, and the button sits next to "Reset to default",
 * which also writes the field without asking — but that one writes it *empty*,
 * and an empty field is recoverable by not saving. Overwriting a custom prompt
 * with several thousand characters of built-in text is not.
 *
 * Nothing renders without a default to load: the settings state arrives
 * asynchronously, and a button that wrote `undefined` into the field would
 * clear the user's prompt while claiming to fill it.
 */
export const LoadDefaultPromptButton = ({
	currentValue,
	defaultValue,
	label,
	onLoad,
	disabled,
}: LoadDefaultPromptButtonProps) => {
	const [confirming, setConfirming] = useState(false)
	const hasCustom = (currentValue ?? "").trim() !== ""

	// A box emptied while the warning is open no longer has anything to warn
	// about, and leaving the confirmation up would ask about a prompt that is
	// not there any more.
	useEffect(() => {
		if (!hasCustom) {
			setConfirming(false)
		}
	}, [hasCustom])

	if (!defaultValue) {
		return null
	}

	if (confirming) {
		return (
			<div className="flex flex-col gap-1">
				<p className="text-xs text-(--vscode-editorWarning-foreground)">
					The {label} box holds a prompt of your own. Loading the built-in one replaces it, and it is not kept anywhere.
				</p>
				<div className="flex gap-2">
					<VSCodeButton
						appearance="secondary"
						onClick={() => {
							setConfirming(false)
							onLoad(defaultValue)
						}}>
						Replace
					</VSCodeButton>
					<VSCodeButton appearance="secondary" onClick={() => setConfirming(false)}>
						Keep mine
					</VSCodeButton>
				</div>
			</div>
		)
	}

	return (
		<VSCodeButton
			appearance="secondary"
			disabled={disabled}
			onClick={() => {
				if (hasCustom) {
					setConfirming(true)
					return
				}
				onLoad(defaultValue)
			}}>
			Load default
		</VSCodeButton>
	)
}

export default LoadDefaultPromptButton

import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useRef, useState } from "react"

interface SettingsCheckboxProps {
	checked: boolean
	onChange: (checked: boolean) => Promise<void> | void
	children: React.ReactNode
	className?: string
}

/**
 * A checkbox that answers the click, not the round trip.
 *
 * `VSCodeCheckbox` is a web component that flips its own internal state when
 * clicked. Driving it from a setting that only comes back after a write to the
 * extension and a state broadcast means React re-renders with the old value
 * before the new one arrives, and the component does not reliably reconcile —
 * so the box appears to snap back, and a second click toggles the internal
 * state the other way. Reported live as needing three to five clicks to enable
 * a setting, and as one checkbox refusing to move while another was settling.
 *
 * The displayed value is local and changes immediately. The setting is the
 * authority: when it arrives it wins, so a write that failed shows as the box
 * returning to where it was rather than as a lie.
 */
export const SettingsCheckbox = ({ checked, onChange, children, className }: SettingsCheckboxProps) => {
	const [shown, setShown] = useState(checked)
	// A pending write must not be overwritten by the state broadcast that
	// preceded it, or the box flickers back mid-flight.
	const pending = useRef(false)

	useEffect(() => {
		if (!pending.current) {
			setShown(checked)
		}
	}, [checked])

	return (
		<VSCodeCheckbox
			checked={shown}
			className={className}
			onChange={async (event: any) => {
				const next = event.target.checked === true
				setShown(next)
				pending.current = true
				try {
					await onChange(next)
				} catch (error) {
					setShown(checked)
					throw error
				} finally {
					pending.current = false
				}
			}}>
			{children}
		</VSCodeCheckbox>
	)
}

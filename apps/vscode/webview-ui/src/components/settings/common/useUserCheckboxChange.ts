import { useCallback, useRef } from "react"

/**
 * A checkbox `onChange` that reports clicks and nothing else.
 *
 * The toolkit's checkbox emits `change` whenever its `checked` property
 * changes, including when the panel sets it on a re-render (fast-foundation's
 * `checkedChanged`). A handler that stores whatever it is told therefore stores
 * the panel's own display back as a choice. For a plain on/off setting that is
 * a redundant write. For one where absent means something — thinking, which an
 * Agents tab leaves unset to mean "as the session has it" — it turns "not
 * stated" into "off".
 *
 * Measured 2026-10-11 on pandorum: an Agents tab held
 * `reasoning: { enabled: false }` beside a session with thinking on, and its
 * agents ran with thinking off. Loading a configuration that says nothing about
 * thinking, after one that had it on, moves the box from ticked to unticked,
 * and that move was written.
 *
 * The test for "the user did this" is that the event reports something other
 * than what is on screen: a click always does, an echo never does. What is on
 * screen is read from a ref set during render, because the echo is emitted
 * while React is still committing and may reach the previous render's handler.
 */
export function useUserCheckboxChange(shown: boolean, onUserChange: (checked: boolean) => void) {
	const shownRef = useRef(shown)
	shownRef.current = shown
	const handlerRef = useRef(onUserChange)
	handlerRef.current = onUserChange

	return useCallback((event: unknown) => {
		const checked = (event as { target?: { checked?: unknown } })?.target?.checked === true
		if (checked === shownRef.current) {
			return
		}
		handlerRef.current(checked)
	}, [])
}

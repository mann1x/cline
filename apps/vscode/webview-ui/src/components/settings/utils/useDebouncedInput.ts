import { useCallback, useEffect, useRef, useState } from "react"
import { useDebounceEffect } from "@/utils/useDebounceEffect"
import { registerPendingEdit } from "./pendingEdits"

/**
 * A custom hook that provides debounced input handling to prevent jumpy text inputs
 * when saving changes directly to backend on every keystroke.
 *
 * `onChange` only fires for values set through the returned setter (user
 * edits). It must not fire on mount or when `initialValue` resyncs
 * externally: fields often mount with a placeholder (e.g. an empty API key
 * mask) while their backing config is still loading asynchronously, and
 * echoing that placeholder back to the backend would overwrite — or, for
 * secret fields, silently delete — the stored value.
 *
 * @param initialValue - The initial value for the input
 * @param onChange - Callback function to save the value (e.g., to backend)
 * @param debounceMs - Debounce delay in milliseconds (default: 100ms)
 * @returns The current value, an editing setter, an authoritative sync setter,
 *          and a flush that saves a pending edit right now, returning
 *          whatever `onChange` returns so the caller can await the write
 */
export function useDebouncedInput<T>(
	initialValue: T,
	onChange: (value: T) => unknown,
	debounceMs: number = 100,
): [T, (value: T) => void, (value: T) => void, () => unknown] {
	// Local state to prevent jumpy input - initialize once
	const [localValue, setLocalValueState] = useState(initialValue)

	// Track previous initialValue to detect external changes
	const prevInitialValueRef = useRef<T>(initialValue)

	// Whether the current localValue came from the returned setter (a user
	// edit) rather than from mount or an external initialValue resync.
	const hasPendingUserEditRef = useRef(false)

	const setLocalValue = useCallback((value: T) => {
		hasPendingUserEditRef.current = true
		setLocalValueState(value)
	}, [])
	const syncLocalValue = useCallback((value: T) => {
		hasPendingUserEditRef.current = false
		setLocalValueState(value)
	}, [])

	// Sync local state when initialValue changes externally (e.g., when switching
	// Plan/Act tabs). Skip the resync while a user edit is pending: because each
	// debounced save round-trips through the backend and updates initialValue,
	// an in-flight save can echo back an older value while the user is still
	// typing, and resyncing would visibly delete their newest keystrokes.
	useEffect(() => {
		if (prevInitialValueRef.current !== initialValue) {
			prevInitialValueRef.current = initialValue
			if (!hasPendingUserEditRef.current) {
				setLocalValueState(initialValue)
			}
		}
	}, [initialValue])

	// Debounced backend save - saves after user stops changing value
	useDebounceEffect(
		() => {
			if (!hasPendingUserEditRef.current) {
				return
			}
			hasPendingUserEditRef.current = false
			onChange(localValue)
		},
		debounceMs,
		[localValue],
	)

	// Flush a pending edit on unmount so keystrokes typed within the debounce
	// window still save when the view closes (e.g. clicking Done in settings).
	// The same flush is offered to callers, so a field can save on an explicit
	// boundary -- blur, Enter -- instead of waiting out its idle timer.
	const latestRef = useRef({ localValue, onChange })
	latestRef.current = { localValue, onChange }
	useEffect(
		() => () => {
			if (hasPendingUserEditRef.current) {
				hasPendingUserEditRef.current = false
				latestRef.current.onChange(latestRef.current.localValue)
			}
		},
		[],
	)

	// The return is passed through, so a caller that flushes before reading the
	// stored configuration can wait for the write rather than racing it. That
	// race is the bug this exists for: Update captured the panel from before
	// the value was typed, and the value reached providers.json a moment after,
	// where only the running session could see it.
	const flush = useCallback(() => {
		if (!hasPendingUserEditRef.current) {
			return undefined
		}
		hasPendingUserEditRef.current = false
		return latestRef.current.onChange(latestRef.current.localValue)
	}, [])

	// Put the field back to what is stored, without writing. For revert: a
	// debounce that fires after the profile has been re-applied writes the
	// value the user just asked to discard.
	const discard = useCallback(() => {
		if (!hasPendingUserEditRef.current) {
			return
		}
		hasPendingUserEditRef.current = false
		setLocalValueState(prevInitialValueRef.current)
	}, [])

	// Registered for the lifetime of the field rather than only while an edit
	// is pending: `pending` is the question every boundary asks first, and a
	// registry that has to be kept in step with a ref is a second source of
	// truth for the same fact.
	useEffect(
		() =>
			registerPendingEdit({
				pending: () => hasPendingUserEditRef.current,
				flush,
				discard,
			}),
		[flush, discard],
	)

	return [localValue, setLocalValue, syncLocalValue, flush]
}

import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useDebouncedInput } from "../utils/useDebouncedInput"

/**
 * How long a field that holds a number typed digit by digit waits before it
 * saves.
 *
 * The default below is 100ms, which is shorter than the gap between two
 * keystrokes, so each prefix of a number reaches the store as though it were
 * the value chosen. pandorum's extension log caught one:
 *
 *   [ProviderConfig] write provider=ollama contextWindow=6553 stored=6553
 *
 * -- 65536 with the last digit not yet typed, live until the next key. A
 * prefix of a context window is not a smaller window; it is a tenth of the one
 * being typed, and anything that reads providers.json in that window runs on
 * it. Blur and Enter flush, so the wait is only ever paid by someone who types
 * a number and then leaves the panel alone.
 */
const NUMERIC_FIELD_DEBOUNCE_MS = 800

/**
 * Props for the DebouncedTextField component
 */
interface DebouncedTextFieldProps {
	// Custom props for debouncing functionality
	initialValue: string
	onChange: (value: string) => unknown
	/**
	 * This field holds a number typed digit by digit, so it waits out a pause
	 * mid-number before saving. See {@link NUMERIC_FIELD_DEBOUNCE_MS}.
	 */
	numeric?: boolean

	// Common VSCodeTextField props
	style?: React.CSSProperties
	type?: "text" | "password"
	placeholder?: string
	id?: string
	children?: React.ReactNode
	disabled?: boolean
	className?: string
}

/**
 * A wrapper around VSCodeTextField that automatically handles debounced input
 * to prevent excessive API calls while typing
 */
export const DebouncedTextField = ({
	initialValue,
	onChange,
	numeric,
	children,
	type,
	className,
	...otherProps
}: DebouncedTextFieldProps) => {
	const [localValue, setLocalValue, , flush] = useDebouncedInput(
		initialValue,
		onChange,
		numeric ? NUMERIC_FIELD_DEBOUNCE_MS : undefined,
	)

	return (
		<VSCodeTextField
			{...otherProps}
			className={className}
			onBlur={flush}
			onInput={(e: any) => {
				const value = e.target.value
				setLocalValue(value)
			}}
			onKeyDown={(e: { key: string }) => {
				if (e.key === "Enter") {
					flush()
				}
			}}
			type={type}
			value={localValue}>
			{children}
		</VSCodeTextField>
	)
}

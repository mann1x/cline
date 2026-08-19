import { useLayoutEffect, useRef } from "react"
import { useDebouncedInput } from "../utils/useDebouncedInput"

interface DebouncedTextAreaProps {
	initialValue: string
	onChange: (value: string) => void

	placeholder?: string
	id?: string
	children?: React.ReactNode
	disabled?: boolean
	className?: string
	/** Never shorter than this, so an empty field still looks like a field. */
	minRows?: number
	/** Beyond this it scrolls, so one runaway value cannot take the whole panel. */
	maxRows?: number
}

const LINE_HEIGHT_FALLBACK_PX = 18

/**
 * A multi-line settings field that grows to fit what is in it.
 *
 * Some values are prose, not a token: `think_budget_message` is a paragraph or
 * three, and a single-line input shows a few words of it with the rest off the
 * right-hand edge. That makes the model's own value unreadable — which is the
 * value the user most needs to see, since it is what they are deciding whether
 * to replace — and makes writing a replacement worse still.
 *
 * Height is measured rather than counted: `scrollHeight` accounts for wrapping,
 * so a long unbroken line is given the rows it actually occupies instead of the
 * one row a newline count would suggest.
 */
export const DebouncedTextArea = ({
	initialValue,
	onChange,
	children,
	className,
	minRows = 2,
	maxRows = 14,
	...otherProps
}: DebouncedTextAreaProps) => {
	const [localValue, setLocalValue] = useDebouncedInput(initialValue, onChange)
	const textAreaRef = useRef<HTMLTextAreaElement | null>(null)

	// Before paint, so the field is never shown at the wrong height first.
	useLayoutEffect(() => {
		const element = textAreaRef.current
		if (!element) {
			return
		}
		const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || LINE_HEIGHT_FALLBACK_PX
		// Collapse first: `scrollHeight` never reports less than the current
		// height, so without this the field can only ever grow.
		element.style.height = "auto"
		const padding = element.offsetHeight - element.clientHeight
		const contentHeight = element.scrollHeight + padding
		element.style.height = `${Math.min(Math.max(contentHeight, minRows * lineHeight), maxRows * lineHeight)}px`
	}, [localValue, minRows, maxRows])

	return (
		<div className={className}>
			{children ? <div className="mb-1">{children}</div> : null}
			<textarea
				{...otherProps}
				className="w-full resize-none box-border bg-(--vscode-input-background) text-(--vscode-input-foreground) border border-solid border-(--vscode-input-border,transparent) px-2 py-1 font-[var(--vscode-font-family)] text-[var(--vscode-font-size)] focus:outline-1 focus:outline-(--vscode-focusBorder)"
				onInput={(event) => setLocalValue((event.target as HTMLTextAreaElement).value)}
				ref={textAreaRef}
				rows={minRows}
				value={localValue}
			/>
		</div>
	)
}

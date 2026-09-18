import { AskResponseRequest } from "@shared/proto/cline/task"
import { useState } from "react"
import styled from "styled-components"
import { CODE_BLOCK_BG_COLOR } from "@/components/common/CodeBlock"
import { TaskServiceClient } from "@/services/grpc-client"
import { readOptionItems } from "./recommended-option"

const OptionButton = styled.button<{ $isSelected?: boolean; $isNotSelectable?: boolean; $isRecommended?: boolean }>`
	padding: 8px 12px;
	background: ${(props) => (props.$isSelected ? "var(--vscode-focusBorder)" : CODE_BLOCK_BG_COLOR)};
	color: ${(props) => (props.$isSelected ? "white" : "var(--vscode-input-foreground)")};
	border: 1px solid
		${(props) => (props.$isRecommended && !props.$isSelected ? "var(--vscode-focusBorder)" : "var(--vscode-editorGroup-border)")};
	border-radius: 2px;
	cursor: ${(props) => (props.$isNotSelectable ? "default" : "pointer")};
	text-align: left;
	font-size: 12px;

	${(props) =>
		!props.$isNotSelectable &&
		`
		&:hover {
			background: var(--vscode-focusBorder);
			color: white;
		}
	`}
`

/**
 * The word on the option the model would pick.
 *
 * Kept to one word and set apart from the option's own text, because the option
 * is what is being chosen and the mark is only how it is being pointed at. The
 * reason lives in the question above, which is where there is room for it.
 */
const RecommendedTag = styled.span`
	margin-left: 8px;
	font-size: 10px;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	opacity: 0.75;
`

export const OptionsButtons = ({
	options,
	selected,
	isActive,
	inputValue,
}: {
	options?: string[]
	selected?: string
	isActive?: boolean
	inputValue?: string
}) => {
	// The model may mark one option as the one it would pick. The mark is a
	// suffix on the option text, so it is split off here: the button shows the
	// option, and what goes back to the model is the option, not the mark.
	const items = readOptionItems(options)
	const optionItems = items.map((item) => item.label)
	const optionsKey = optionItems.join("\u0000")
	const optimisticSelectionKey = `${selected ?? ""}\u0001${optionsKey}`
	const [optimisticSelection, setOptimisticSelection] = useState<{ key: string; option: string }>()

	if (!optionItems.length) {
		return null
	}

	const selectedOption =
		selected !== undefined && optionItems.includes(selected)
			? selected
			: optimisticSelection?.key === optimisticSelectionKey
				? optimisticSelection.option
				: undefined
	const hasSelected = selectedOption !== undefined && optionItems.includes(selectedOption)

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				gap: "8px",
			}}>
			{/* <div style={{ color: "var(--vscode-descriptionForeground)", fontSize: "11px", textTransform: "uppercase" }}>
				SELECT ONE:
			</div> */}
			{items.map((item, index) => (
				<OptionButton
					$isNotSelectable={hasSelected || !isActive}
					$isRecommended={item.recommended}
					$isSelected={item.label === selectedOption}
					className="options-button"
					disabled={hasSelected || !isActive}
					id={`options-button-${index}`}
					key={item.raw}
					onClick={async () => {
						if (hasSelected || !isActive) {
							return
						}
						setOptimisticSelection({ key: optimisticSelectionKey, option: item.label })
						try {
							await TaskServiceClient.askResponse(
								AskResponseRequest.create({
									responseType: "messageResponse",
									text: item.label + (inputValue ? `: ${inputValue?.trim()}` : ""),
									images: [],
								}),
							)
						} catch (error) {
							setOptimisticSelection(undefined)
							console.error("Error sending option response:", error)
						}
					}}>
					<span className="ph-no-capture">{item.label}</span>
					{item.recommended && <RecommendedTag>Recommended</RecommendedTag>}
				</OptionButton>
			))}
		</div>
	)
}

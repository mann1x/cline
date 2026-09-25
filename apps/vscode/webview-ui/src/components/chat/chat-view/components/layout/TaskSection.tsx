import { ClineMessage, ContextBreakdown, ContextWindowGrant } from "@shared/ExtensionMessage"
import type { ExpertApiMetrics, ProviderApiMetrics } from "@shared/getApiMetrics"
import React from "react"
import TaskHeader from "@/components/chat/task-header/TaskHeader"
import { MessageHandlers } from "../../types/chatTypes"

interface TaskSectionProps {
	task: ClineMessage
	apiMetrics: {
		totalTokensIn: number
		totalTokensOut: number
		totalCacheWrites?: number
		totalCacheReads?: number
		totalCost: number
		byProvider: ProviderApiMetrics[]
		totalGenerateTokens: number
		totalGenerateMs: number
		expert?: ExpertApiMetrics
	}
	contextTokensUsed?: number
	/** The fixed price of that request, when the turn reported one. */
	contextBreakdown?: ContextBreakdown
	/** The window the server granted that request, when it stated one. */
	contextWindowGrant?: ContextWindowGrant
	selectedModelInfo: {
		supportsPromptCache: boolean
		supportsImages: boolean
	}
	messageHandlers: MessageHandlers
}

/**
 * Task section shown when there's an active task
 * Includes the task header and manages task-specific UI
 */
export const TaskSection: React.FC<TaskSectionProps> = ({
	task,
	apiMetrics,
	contextTokensUsed,
	contextBreakdown,
	contextWindowGrant,
	selectedModelInfo,
	messageHandlers,
}) => {
	return (
		<TaskHeader
			byProvider={apiMetrics.byProvider}
			cacheReads={apiMetrics.totalCacheReads}
			cacheWrites={apiMetrics.totalCacheWrites}
			contextBreakdown={contextBreakdown}
			contextTokensUsed={contextTokensUsed}
			contextWindowGrant={contextWindowGrant}
			doesModelSupportPromptCache={selectedModelInfo.supportsPromptCache}
			expert={apiMetrics.expert}
			generateMs={apiMetrics.totalGenerateMs}
			generateTokens={apiMetrics.totalGenerateTokens}
			onClose={messageHandlers.handleTaskCloseButtonClick}
			onSendMessage={messageHandlers.handleSendMessage}
			task={task}
			tokensIn={apiMetrics.totalTokensIn}
			tokensOut={apiMetrics.totalTokensOut}
			totalCost={apiMetrics.totalCost}
		/>
	)
}

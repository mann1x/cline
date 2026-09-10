import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import { combineHookSequences } from "@shared/combineHookSequences"
import { getApiMetrics, getLastApiReqTotalTokens } from "@shared/getApiMetrics"
import { BooleanRequest } from "@shared/proto/cline/common"
import { resolveVisionModelStatus } from "@shared/vision-config"
import { useCallback, useEffect, useMemo, useRef } from "react"
import { useMount } from "react-use"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useShowNavbar } from "@/context/PlatformContext"
import { useNormalizedApiConfiguration } from "@/hooks/useNormalizedApiConfiguration"
import { FileServiceClient, UiServiceClient } from "@/services/grpc-client"
import { Navbar } from "../menu/Navbar"
import AutoApproveBar from "./auto-approve-menu/AutoApproveBar"
// Import utilities and hooks from the new structure
import {
	ActionButtons,
	BackgroundAgents,
	CHAT_CONSTANTS,
	ChatLayout,
	filterVisibleMessages,
	groupLowStakesTools,
	groupMessages,
	InputSection,
	MessagesArea,
	QueuedPrompts,
	TaskSection,
	useChatState,
	useMessageHandlers,
	useScrollBehavior,
	WelcomeSection,
} from "./chat-view"
import { copyTextForSelection } from "./chat-view/utils/copySelection"
import {
	hasPendingMessageConfirmation,
	isPendingResponseUnconfirmed,
	withPendingUserMessage,
} from "./chat-view/utils/pendingResponse"

interface ChatViewProps {
	isHidden: boolean
	showAnnouncement: boolean
	hideAnnouncement: () => void
	showHistoryView: () => void
}

// Use constants from the imported module
const MAX_IMAGES_AND_FILES_PER_MESSAGE = CHAT_CONSTANTS.MAX_IMAGES_AND_FILES_PER_MESSAGE
const QUICK_WINS_HISTORY_THRESHOLD = 3

const ChatView = ({ isHidden, showAnnouncement, hideAnnouncement, showHistoryView }: ChatViewProps) => {
	const showNavbar = useShowNavbar()
	const {
		version,
		clineMessages: messages,
		taskHistory,
		telemetrySetting,
		mode,
		userInfo,
		hooksEnabled,
		checkpointRestoreInput,
		queuedPrompts,
		turnState,
		visionModelEnabled,
		visionModeApiConfiguration,
		showRequestTimings,
	} = useExtensionState()
	const isProdHostedApp = userInfo?.apiBaseUrl === "https://app.cline.bot"
	const shouldShowQuickWins = isProdHostedApp && (!taskHistory || taskHistory.length < QUICK_WINS_HISTORY_THRESHOLD)

	// Use custom hooks for state management
	const chatState = useChatState(messages)
	const {
		setInputValue,
		selectedImages,
		setSelectedImages,
		selectedFiles,
		setSelectedFiles,
		sendingDisabled,
		enableButtons,
		expandedRows,
		setExpandedRows,
		pendingUserMessage,
		setPendingUserMessage,
		pendingResponse,
		setPendingResponse,
		textAreaRef,
	} = chatState

	const displayMessages = useMemo(() => withPendingUserMessage(messages, pendingUserMessage), [messages, pendingUserMessage])

	useEffect(() => {
		if (pendingUserMessage && hasPendingMessageConfirmation(messages, pendingUserMessage)) {
			setPendingUserMessage((current) => (current === pendingUserMessage ? undefined : current))
		}
	}, [messages, pendingUserMessage, setPendingUserMessage])

	useEffect(() => {
		if (!pendingResponse || isPendingResponseUnconfirmed(pendingResponse, turnState, messages.length)) {
			return
		}
		setPendingResponse((current) => (current?.id === pendingResponse.id ? undefined : current))
	}, [messages.length, pendingResponse, setPendingResponse, turnState])

	//const task = messages.length > 0 ? (messages[0].say === "task" ? messages[0] : undefined) : undefined) : undefined
	const task = useMemo(() => displayMessages.at(0), [displayMessages]) // leaving this less safe version here since if the first message is not a task, then the extension is in a bad state and needs to be debugged (see Cline.abort)
	const modifiedMessages = useMemo(() => {
		const slicedMessages = displayMessages.slice(1)
		// Only combine hook sequences if hooks are enabled
		const withHooks = hooksEnabled ? combineHookSequences(slicedMessages) : slicedMessages
		return combineApiRequests(combineCommandSequences(withHooks))
	}, [displayMessages, hooksEnabled])
	// has to be after api_req_finished are all reduced into api_req_started messages
	const apiMetrics = useMemo(() => getApiMetrics(modifiedMessages), [modifiedMessages])

	const lastApiReqTotalTokens = useMemo(() => getLastApiReqTotalTokens(modifiedMessages) || undefined, [modifiedMessages])
	const lastAppliedCheckpointRestoreSessionId = useRef<string | undefined>(checkpointRestoreInput?.sessionId)

	useEffect(() => {
		if (!checkpointRestoreInput || checkpointRestoreInput.sessionId === lastAppliedCheckpointRestoreSessionId.current) {
			return
		}
		lastAppliedCheckpointRestoreSessionId.current = checkpointRestoreInput.sessionId
		setInputValue(checkpointRestoreInput.text)
		setSelectedImages(checkpointRestoreInput.images ?? [])
		setSelectedFiles(checkpointRestoreInput.files ?? [])
		setTimeout(() => {
			textAreaRef.current?.focus()
		}, 0)
	}, [checkpointRestoreInput, setInputValue, setSelectedImages, setSelectedFiles, textAreaRef])

	useEffect(() => {
		// Synchronous, start to finish. The previous version awaited the
		// HTML-to-Markdown conversion and only then called `preventDefault()`
		// and posted the text to the host — by which point the event had
		// finished dispatching, so the cancel was decided on a write nothing
		// waited for. A host that could not take the clipboard left the user
		// with whatever was on it before, and reported that to a log only.
		// The text now goes through `clipboardData`, which is the copy the
		// browser was already about to make.
		const handleCopy = (e: ClipboardEvent) => {
			const targetElement = e.target as HTMLElement | null
			// If the copy event originated from an input or textarea,
			// let the default browser behavior handle it.
			if (
				targetElement &&
				(targetElement.tagName === "INPUT" || targetElement.tagName === "TEXTAREA" || targetElement.isContentEditable)
			) {
				return
			}
			if (!e.clipboardData) {
				// Nothing to write through, so leave the browser's own copy
				// alone rather than cancelling it for a replacement that
				// cannot be delivered.
				return
			}

			const textToCopy = copyTextForSelection(window.getSelection?.() ?? null, (element) =>
				window.getComputedStyle(element),
			)
			if (textToCopy === null) {
				return
			}
			e.clipboardData.setData("text/plain", textToCopy)
			e.preventDefault()
		}
		document.addEventListener("copy", handleCopy)

		return () => {
			document.removeEventListener("copy", handleCopy)
		}
	}, [])
	// Button state is now managed by useButtonState hook

	// handleFocusChange is already provided by chatState

	// Use message handlers hook
	const messageHandlers = useMessageHandlers(messages, chatState)

	const { selectedModelInfo } = useNormalizedApiConfiguration(mode)

	// A second model configured to read images makes them usable here whatever
	// the primary model can do — the description goes in the image's place
	// before the primary ever sees it. Asking only the primary is how the file
	// picker came to refuse an image for a session that was set up to handle
	// one.
	//
	// The toggle alone is not that question, though. With it on and the Vision
	// tab empty no describer is installed, and trusting the toggle here let an
	// image reach a model that answered "this model does not support image
	// input" and failed the run. The session resolves it the same way.
	const imagesAccepted =
		selectedModelInfo.supportsImages || resolveVisionModelStatus(visionModelEnabled, visionModeApiConfiguration) === "ready"

	const selectFilesAndImages = useCallback(async () => {
		try {
			const response = await FileServiceClient.selectFiles(
				BooleanRequest.create({
					value: imagesAccepted,
				}),
			)
			if (
				response &&
				response.values1 &&
				response.values2 &&
				(response.values1.length > 0 || response.values2.length > 0)
			) {
				const currentTotal = selectedImages.length + selectedFiles.length
				const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - currentTotal

				if (availableSlots > 0) {
					// Prioritize images first
					const imagesToAdd = Math.min(response.values1.length, availableSlots)
					if (imagesToAdd > 0) {
						setSelectedImages((prevImages) => [...prevImages, ...response.values1.slice(0, imagesToAdd)])
					}

					// Use remaining slots for files
					const remainingSlots = availableSlots - imagesToAdd
					if (remainingSlots > 0) {
						setSelectedFiles((prevFiles) => [...prevFiles, ...response.values2.slice(0, remainingSlots)])
					}
				}
			}
		} catch (error) {
			console.error("Error selecting images & files:", error)
		}
	}, [imagesAccepted])

	const shouldDisableFilesAndImages = selectedImages.length + selectedFiles.length >= MAX_IMAGES_AND_FILES_PER_MESSAGE

	// Subscribe to show webview events from the backend
	useEffect(() => {
		const cleanup = UiServiceClient.subscribeToShowWebview(
			{},
			{
				onResponse: (event: any) => {
					// Only focus if not hidden and preserveEditorFocus is false
					if (!isHidden && !event.preserveEditorFocus) {
						textAreaRef.current?.focus()
					}
				},
				onError: (error: any) => {
					console.error("Error in showWebview subscription:", error)
				},
				onComplete: () => {
					console.log("showWebview subscription completed")
				},
			},
		)

		return cleanup
	}, [isHidden])

	// Set up addToInput subscription
	useEffect(() => {
		const cleanup = UiServiceClient.subscribeToAddToInput(
			{},
			{
				onResponse: (event: any) => {
					if (event.value) {
						setInputValue((prevValue) => {
							const newText = event.value
							const newTextWithNewline = newText + "\n"
							return prevValue ? `${prevValue}\n${newTextWithNewline}` : newTextWithNewline
						})
						// Add scroll to bottom after state update
						// Auto focus the input and start the cursor on a new line for easy typing
						setTimeout(() => {
							if (textAreaRef.current) {
								textAreaRef.current.scrollTop = textAreaRef.current.scrollHeight
								textAreaRef.current.focus()
							}
						}, 0)
					}
				},
				onError: (error: any) => {
					console.error("Error in addToInput subscription:", error)
				},
				onComplete: () => {
					console.log("addToInput subscription completed")
				},
			},
		)

		return cleanup
	}, [])

	useMount(() => {
		// NOTE: the vscode window needs to be focused for this to work
		textAreaRef.current?.focus()
	})

	useEffect(() => {
		const timer = setTimeout(() => {
			if (!isHidden && !sendingDisabled && !enableButtons) {
				textAreaRef.current?.focus()
			}
		}, 50)
		return () => {
			clearTimeout(timer)
		}
	}, [isHidden, sendingDisabled, enableButtons])

	const visibleMessages = useMemo(() => {
		return filterVisibleMessages(modifiedMessages, { showRequestTimings })
	}, [modifiedMessages, showRequestTimings])

	const groupedMessages = useMemo(() => {
		return groupLowStakesTools(groupMessages(visibleMessages))
	}, [visibleMessages])

	// Use scroll behavior hook
	const scrollBehavior = useScrollBehavior(displayMessages, visibleMessages, groupedMessages, expandedRows, setExpandedRows)
	const { scrollToBottomSmooth, scrollToBottomAuto, disableAutoScrollRef, resumeFollowing } = scrollBehavior

	// When a prompt gets queued, the queue banner mounts (or grows) in the footer, which
	// shrinks the messages area and visually covers the bottom of the conversation. No new
	// chat row is added, so the list-length-based auto-scroll never fires — re-pin to the
	// bottom here so the latest content stays visible.
	const queuedPromptCount = queuedPrompts?.length ?? 0
	const taskTs = task?.ts
	const prevQueuedPromptCountRef = useRef(queuedPromptCount)
	const prevQueuedPromptTaskTsRef = useRef(taskTs)
	useEffect(() => {
		const previousCount = prevQueuedPromptCountRef.current
		const previousTaskTs = prevQueuedPromptTaskTsRef.current
		prevQueuedPromptCountRef.current = queuedPromptCount
		prevQueuedPromptTaskTsRef.current = taskTs
		// A task switch can grow the count without a send from this webview (the newly
		// displayed task may already have queued prompts) — don't hijack its scroll position.
		if (taskTs !== previousTaskTs || queuedPromptCount <= previousCount) {
			return
		}
		// Queueing is a deliberate send, so re-engage bottom pinning like handleSendMessage does.
		resumeFollowing()
		scrollToBottomSmooth()
		// Settle with an instant scroll once the footer's layout change has landed.
		setTimeout(() => {
			if (!disableAutoScrollRef.current) {
				scrollToBottomAuto()
			}
		}, 50)
	}, [queuedPromptCount, taskTs, scrollToBottomSmooth, scrollToBottomAuto, disableAutoScrollRef, resumeFollowing])

	const placeholderText = useMemo(() => {
		const text = task ? "Type a message..." : "Type your task here..."
		return text
	}, [task])

	return (
		<ChatLayout isHidden={isHidden}>
			<div className="flex flex-col flex-1 overflow-hidden">
				{showNavbar && <Navbar />}
				{task ? (
					<TaskSection
						apiMetrics={apiMetrics}
						lastApiReqTotalTokens={lastApiReqTotalTokens}
						messageHandlers={messageHandlers}
						selectedModelInfo={{
							supportsPromptCache: selectedModelInfo.supportsPromptCache,
							supportsImages: selectedModelInfo.supportsImages || false,
						}}
						task={task}
					/>
				) : (
					<WelcomeSection
						hideAnnouncement={hideAnnouncement}
						shouldShowQuickWins={shouldShowQuickWins}
						showAnnouncement={showAnnouncement}
						showHistoryView={showHistoryView}
						taskHistory={taskHistory}
						telemetrySetting={telemetrySetting}
						version={version}
					/>
				)}
				{task && (
					<MessagesArea
						chatState={chatState}
						groupedMessages={groupedMessages}
						messageHandlers={messageHandlers}
						modifiedMessages={modifiedMessages}
						scrollBehavior={scrollBehavior}
						task={task}
					/>
				)}
			</div>
			<footer className="bg-(--vscode-sidebar-background) flex flex-col" style={{ gridRow: "2" }}>
				<AutoApproveBar />
				<ActionButtons
					chatState={chatState}
					messageHandlers={messageHandlers}
					messages={messages}
					mode={mode}
					task={task}
				/>
				<BackgroundAgents />
				<QueuedPrompts items={queuedPrompts} />
				<InputSection
					chatState={chatState}
					messageHandlers={messageHandlers}
					placeholderText={placeholderText}
					scrollBehavior={scrollBehavior}
					selectFilesAndImages={selectFilesAndImages}
					shouldDisableFilesAndImages={shouldDisableFilesAndImages}
				/>
			</footer>
		</ChatLayout>
	)
}

export default ChatView

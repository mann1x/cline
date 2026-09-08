import type { Boolean, EmptyRequest } from "@shared/proto/cline/common"
import { useCallback, useEffect } from "react"
import AccountView from "./components/account/AccountView"
import ChatView from "./components/chat/ChatView"
import { RootErrorBoundary } from "./components/common/RootErrorBoundary"
import { ViewErrorBoundary } from "./components/common/ViewErrorBoundary"
import { WaitingForCline } from "./components/common/WaitingForCline"
import HistoryView from "./components/history/HistoryView"
import MarketplaceView from "./components/marketplace/MarketplaceView"
import McpView from "./components/mcp/configuration/McpConfigurationView"
import { openClinePassSubscriptionIfPending } from "./components/onboarding/clinePassSubscribe"
import OnboardingView from "./components/onboarding/OnboardingView"
import SettingsView from "./components/settings/SettingsView"
import WorktreesView from "./components/worktrees/WorktreesView"
import { useClineAuth } from "./context/ClineAuthContext"
import { useExtensionState } from "./context/ExtensionStateContext"
import { Providers } from "./Providers"
import { UiServiceClient } from "./services/grpc-client"

const AppContent = () => {
	const {
		didHydrateState,
		hydrationStalled,
		showWelcome,
		shouldShowAnnouncement,
		showMarketplace,
		showMcp,
		mcpTab,
		showSettings,
		settingsTargetSection,
		showHistory,
		showAccount,
		showWorktrees,
		showAnnouncement,
		setShowAnnouncement,
		setShouldShowAnnouncement,
		closeMcpView,
		navigateToHistory,
		hideSettings,
		hideHistory,
		hideAccount,
		hideWorktrees,
		closeMarketplaceView,
		hideAnnouncement,
	} = useExtensionState()

	const { clineUser, organizations, activeOrganization } = useClineAuth()

	const showUpdateAnnouncementModal = useCallback(() => {
		setShowAnnouncement(true)
		UiServiceClient.onDidShowAnnouncement({} as EmptyRequest)
			.then((response: Boolean) => {
				setShouldShowAnnouncement(response.value)
			})
			.catch((error) => {
				console.error("Failed to acknowledge announcement:", error)
			})
	}, [setShouldShowAnnouncement, setShowAnnouncement])

	useEffect(() => {
		if (!didHydrateState || showWelcome || !shouldShowAnnouncement || showAnnouncement) {
			return
		}
		showUpdateAnnouncementModal()
	}, [didHydrateState, showWelcome, shouldShowAnnouncement, showAnnouncement, showUpdateAnnouncementModal])

	// Open the ClinePass subscription page once auth completes. Lives here (not in OnboardingView)
	// because handleAuthCallback unmounts onboarding before the clineUser update arrives.
	useEffect(() => {
		if (clineUser?.uid) {
			openClinePassSubscriptionIfPending(clineUser.appBaseUrl)
		}
	}, [clineUser?.uid, clineUser?.appBaseUrl])

	if (!didHydrateState) {
		// Blank until the first state arrives, which is normal for a moment and
		// a silent failure after that. `hydrationStalled` is the context saying
		// the wait has stopped being normal.
		return hydrationStalled ? <WaitingForCline /> : null
	}

	if (showWelcome) {
		return <OnboardingView />
	}

	return (
		<div className="flex h-screen w-full flex-col">
			{/*
			 * Each overlay view carries its own boundary. They sit above a
			 * ChatView that is never unmounted, so a view that throws during
			 * render stops at itself instead of taking the session's panel
			 * down with it -- which is what a provider settings panel did.
			 */}
			{showSettings && (
				<ViewErrorBoundary onDone={hideSettings} viewName="Settings">
					<SettingsView onDone={hideSettings} targetSection={settingsTargetSection} />
				</ViewErrorBoundary>
			)}
			{showHistory && (
				<ViewErrorBoundary onDone={hideHistory} viewName="History">
					<HistoryView onDone={hideHistory} />
				</ViewErrorBoundary>
			)}
			{showMarketplace && (
				<ViewErrorBoundary onDone={closeMarketplaceView} viewName="Marketplace">
					<MarketplaceView initialType={mcpTab ? "mcp" : undefined} onDone={closeMarketplaceView} />
				</ViewErrorBoundary>
			)}
			{showMcp && (
				<ViewErrorBoundary onDone={closeMcpView} viewName="MCP servers">
					<McpView initialTab={mcpTab} onDone={closeMcpView} />
				</ViewErrorBoundary>
			)}
			{showAccount && (
				<ViewErrorBoundary onDone={hideAccount} viewName="Account">
					<AccountView
						activeOrganization={activeOrganization}
						clineUser={clineUser}
						onDone={hideAccount}
						organizations={organizations}
					/>
				</ViewErrorBoundary>
			)}
			{showWorktrees && (
				<ViewErrorBoundary onDone={hideWorktrees} viewName="Worktrees">
					<WorktreesView onDone={hideWorktrees} />
				</ViewErrorBoundary>
			)}
			{/* Do not conditionally load ChatView, it's expensive and there's state we don't want to lose (user input, disableInput, askResponse promise, etc.) */}
			<ChatView
				hideAnnouncement={hideAnnouncement}
				isHidden={showSettings || showHistory || showMarketplace || showMcp || showAccount || showWorktrees}
				showAnnouncement={showAnnouncement}
				showHistoryView={navigateToHistory}
			/>
		</div>
	)
}

const App = () => {
	return (
		// Outside the providers on purpose: a provider that throws on a piece of
		// state it cannot read is the failure this exists for, and a boundary
		// inside would be unmounted along with it.
		<RootErrorBoundary>
			<Providers>
				<AppContent />
			</Providers>
		</RootErrorBoundary>
	)
}

export default App

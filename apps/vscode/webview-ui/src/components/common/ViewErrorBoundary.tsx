import React from "react"
import { reportWebviewFailure } from "@/services/webview-error-report"

interface ViewErrorBoundaryProps {
	/** Named in the message and in the report, so a log says which view fell over. */
	viewName: string
	/** Closes the view, returning to the chat underneath it. */
	onDone?: () => void
	children: React.ReactNode
}

interface ViewErrorBoundaryState {
	error: Error | null
	componentStack: string
}

/**
 * One view's blast radius.
 *
 * `RootErrorBoundary` catches everything, which is the right last resort and
 * the wrong first one: a settings panel that throws during render took the
 * chat down with it, and the whole webview became an error card over a task
 * that was still running. That is what the 4.100.76 report turned out to be --
 * a provider panel reading a stored override, in a `useMemo`, on the Vision and
 * Agents tabs.
 *
 * The overlay views sit above a permanently mounted `ChatView`, so a boundary
 * around each of them keeps a broken view broken and leaves the session alone.
 * The view can be closed from here, which is usually enough to get working
 * again without reloading and losing the composer's contents.
 */
export class ViewErrorBoundary extends React.Component<ViewErrorBoundaryProps, ViewErrorBoundaryState> {
	constructor(props: ViewErrorBoundaryProps) {
		super(props)
		this.state = { error: null, componentStack: "" }
	}

	static getDerivedStateFromError(error: Error): Partial<ViewErrorBoundaryState> {
		return { error }
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		this.setState({ componentStack: errorInfo.componentStack ?? "" })
		reportWebviewFailure(`${this.props.viewName} failed to render`, error, errorInfo.componentStack ?? undefined)
	}

	render() {
		const { error, componentStack } = this.state
		if (!error) {
			return this.props.children
		}

		return (
			<div
				className="flex h-full w-full flex-col overflow-auto"
				style={{
					padding: "16px",
					color: "var(--vscode-foreground)",
					fontFamily: "var(--vscode-font-family)",
				}}>
				<h3 style={{ margin: "0 0 8px 0", color: "var(--vscode-errorForeground)" }}>
					{this.props.viewName} could not be drawn
				</h3>
				<p style={{ margin: "0 0 12px 0" }}>
					Your conversation is untouched — close this view to go back to it. The failure below has been written to the
					Cline output channel, so a report collected now will carry it.
				</p>
				<div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
					{this.props.onDone && (
						<button
							onClick={this.props.onDone}
							style={{
								padding: "4px 12px",
								cursor: "pointer",
								color: "var(--vscode-button-foreground)",
								backgroundColor: "var(--vscode-button-background)",
								border: "none",
								borderRadius: "2px",
							}}
							type="button">
							Close this view
						</button>
					)}
					<button
						onClick={() => this.setState({ error: null, componentStack: "" })}
						style={{
							padding: "4px 12px",
							cursor: "pointer",
							color: "var(--vscode-button-secondaryForeground)",
							backgroundColor: "var(--vscode-button-secondaryBackground)",
							border: "none",
							borderRadius: "2px",
						}}
						type="button">
						Try again
					</button>
				</div>
				<pre
					style={{
						margin: 0,
						padding: "8px",
						whiteSpace: "pre-wrap",
						wordBreak: "break-word",
						fontSize: "12px",
						border: "1px solid var(--vscode-editorError-foreground)",
						borderRadius: "4px",
						backgroundColor: "var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1))",
					}}>
					{error.stack || error.message}
					{componentStack}
				</pre>
			</div>
		)
	}
}

export default ViewErrorBoundary

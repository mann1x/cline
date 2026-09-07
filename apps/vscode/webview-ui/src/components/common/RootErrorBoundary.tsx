import React from "react"
import { reportWebviewFailure } from "@/services/webview-error-report"

interface RootErrorBoundaryProps {
	children: React.ReactNode
}

interface RootErrorBoundaryState {
	error: Error | null
	componentStack: string
}

/**
 * The last boundary in the webview: what it catches would otherwise be a blank
 * panel.
 *
 * React unmounts the entire tree when a render throws and nothing catches it,
 * and an unmounted tree in a webview is an empty grey rectangle. From outside
 * it is indistinguishable from a panel that never opened — the extension host
 * is untouched, the task keeps running in the background, and nothing is
 * written to any log. That is the report we have had twice, both times with
 * nothing to go on.
 *
 * So this renders what happened and says it to the extension host, where a
 * collected report will find it. It deliberately wraps the context providers
 * rather than sitting inside them: a provider that throws on a bad piece of
 * state is exactly the failure worth catching, and a boundary underneath it
 * would go down with the tree.
 */
export class RootErrorBoundary extends React.Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
	constructor(props: RootErrorBoundaryProps) {
		super(props)
		this.state = { error: null, componentStack: "" }
	}

	static getDerivedStateFromError(error: Error): Partial<RootErrorBoundaryState> {
		return { error }
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		this.setState({ componentStack: errorInfo.componentStack ?? "" })
		reportWebviewFailure("Render failed", error, errorInfo.componentStack ?? undefined)
	}

	render() {
		const { error, componentStack } = this.state
		if (!error) {
			return this.props.children
		}

		return (
			<div
				style={{
					padding: "16px",
					color: "var(--vscode-foreground)",
					fontFamily: "var(--vscode-font-family)",
					height: "100vh",
					overflow: "auto",
				}}>
				<h3 style={{ margin: "0 0 8px 0", color: "var(--vscode-errorForeground)" }}>Cline could not draw this view</h3>
				<p style={{ margin: "0 0 12px 0" }}>
					The failure below has been written to the Cline output channel, so a report collected now will carry it.
					Reloading usually brings the panel back.
				</p>
				<button
					onClick={() => window.location.reload()}
					style={{
						marginBottom: "12px",
						padding: "4px 12px",
						cursor: "pointer",
						color: "var(--vscode-button-foreground)",
						backgroundColor: "var(--vscode-button-background)",
						border: "none",
						borderRadius: "2px",
					}}
					type="button">
					Reload the panel
				</button>
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

export default RootErrorBoundary

/**
 * What the panel shows when the extension host has sent it nothing.
 *
 * The webview renders nothing until its first state arrives, so a stream that
 * fails leaves an empty grey rectangle — indistinguishable from a panel that
 * never opened, and reported three times as "Cline crashed" when the extension
 * host was healthy the whole time and the task was still running.
 *
 * The stream is already being reopened by the time this appears; this is here
 * to say so, and to offer the reload that people were doing anyway.
 */
export function WaitingForCline() {
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "flex-start",
				gap: "10px",
				padding: "16px",
				color: "var(--vscode-foreground)",
				fontFamily: "var(--vscode-font-family)",
			}}>
			<h3 style={{ margin: 0 }}>Waiting for Cline</h3>
			<p style={{ margin: 0 }}>
				The panel has not received its state from the extension. Any task you started is still running — this is the view,
				not the run. Reconnecting.
			</p>
			<p style={{ margin: 0, opacity: 0.8, fontSize: "12px" }}>
				The failure has been written to the Cline output channel, so a report collected now will carry it.
			</p>
			<button
				onClick={() => window.location.reload()}
				style={{
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
		</div>
	)
}

export default WaitingForCline

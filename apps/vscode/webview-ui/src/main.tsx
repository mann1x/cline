import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./main.css"
import "./index.css"
import { BoardViewer, windowMessageTransport } from "@cline/ui/components/board-viewer"
import App from "./App.tsx"
import "@cline/ui/components/board-viewer.css"
import { PLATFORM_CONFIG } from "./config/platform.config"
import { installGlobalWebviewErrorReporting } from "./services/webview-error-report"

// Before the first render: a throw during it is the one worth having.
installGlobalWebviewErrorReporting()

// The same bundle serves the chat and the board viewer's editor panel, which
// marks its root (see hosts/vscode/board-viewer/panel.ts).
const root = document.getElementById("root")!
const boardTransport = windowMessageTransport((request) => PLATFORM_CONFIG.postMessage(request))
createRoot(root).render(
	<StrictMode>{root.dataset.view === "board" ? <BoardViewer transport={boardTransport} /> : <App />}</StrictMode>,
)

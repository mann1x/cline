import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./main.css"
import "./index.css"
import App from "./App.tsx"
import { BoardViewer } from "./components/board-viewer/BoardViewer"
import { installGlobalWebviewErrorReporting } from "./services/webview-error-report"

// Before the first render: a throw during it is the one worth having.
installGlobalWebviewErrorReporting()

// The same bundle serves the chat and the board viewer's editor panel, which
// marks its root (see hosts/vscode/board-viewer/panel.ts).
const root = document.getElementById("root")!
createRoot(root).render(<StrictMode>{root.dataset.view === "board" ? <BoardViewer /> : <App />}</StrictMode>)

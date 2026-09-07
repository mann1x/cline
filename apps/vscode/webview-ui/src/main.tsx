import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./main.css"
import "./index.css"
import App from "./App.tsx"
import { installGlobalWebviewErrorReporting } from "./services/webview-error-report"

// Before the first render: a throw during it is the one worth having.
installGlobalWebviewErrorReporting()

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
)

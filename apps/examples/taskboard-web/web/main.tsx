import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// The ui theme's tokens (colours, fonts) on :root and .dark, then the Board
// tab's stylesheet, which takes its colours from them outside VS Code.
import "@cline/ui/theme/tokens.css";
import "@cline/ui/components/board-viewer.css";
import "./app.css";
import { App } from "./App";

// Follow the system's light or dark setting: the ui theme switches on `.dark`.
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () =>
	document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
}

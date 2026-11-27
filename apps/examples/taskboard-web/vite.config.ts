import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

// The page is built into dist/web, which the server serves.
export default defineConfig({
	root: fileURLToPath(new URL("./web", import.meta.url)),
	plugins: [react()],
	// One React for the page and the Board tab. Installed from npm, React is a
	// peer of the ui package and there is only one; in this repository the ui
	// package resolves its own development copy, so pin both to the page's.
	resolve: { dedupe: ["react", "react-dom"] },
	build: {
		outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
		emptyOutDir: true,
	},
});

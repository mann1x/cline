import { writeFileSync } from "node:fs"
import * as path from "node:path"
import { createRenderImageTool } from "@cline/core"
import { describe, expect, it } from "vitest"
import { renderWithChrome } from "../services/browser/render-page"

const OUT = process.env.RENDER_LIVE_OUT ?? ""
const CHROME = process.env.RENDER_LIVE_CHROME ?? ""

describe.skipIf(!OUT || !CHROME)("render_image against a real Chrome", () => {
	const ws = path.join(OUT, "ws")
	const tool = createRenderImageTool({
		cwd: ws,
		createDriver: () => ({
			render: (request) =>
				renderWithChrome(request, {
					executablePath: CHROME,
					mermaidScriptPath: path.resolve(__dirname, "../../webview-ui/node_modules/mermaid/dist/mermaid.min.js"),
					args: ["--no-sandbox"],
				}),
		}),
		writeFile: async (file, data) => writeFileSync(file, data),
	})
	const run = (input: Record<string, unknown>) => tool.execute(input, { metadata: {} } as never) as Promise<unknown>

	it("draws a fragment with the workspace's stylesheet, as large as the card", async () => {
		const out = String(
			await run({
				source: '<link rel="stylesheet" href="styles/app.css"><div class="card"><h2>Documents</h2><span class="pill">Synced</span></div>',
				path: "card.png",
			}),
		)
		console.log(out)
		expect(out).toMatch(/\(7\d\dx\d+\)/)
	}, 60_000)

	it("draws a Mermaid diagram, as PNG and as SVG", async () => {
		const source =
			"flowchart LR\n  A[Upload document] --> B{Valid?}\n  B -- yes --> C[Index]\n  B -- no --> D[Reject]\n  C --> E[Search]"
		console.log(String(await run({ source, path: "flow.png" })))
		console.log(String(await run({ source, path: "flow.svg", theme: "dark" })))
		console.log(String(await run({ source: "flowchart LR\n  A --> ", path: "bad.png" })))
	}, 90_000)

	it("draws an SVG, sized, cropped and transparent", async () => {
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" rx="12" fill="#0969da"/><text x="100" y="58" text-anchor="middle" fill="#fff" font-family="sans-serif" font-size="24">Dashboard</text></svg>'
		console.log(String(await run({ source: svg, path: "badge.png", scale: 1 })))
		console.log(String(await run({ source: svg, path: "crop.png", crop: "0,0,100,50", scale: 1, background: "transparent" })))
		console.log(String(await run({ source: "<p>hello</p>", path: "page.png", width: 400, height: 300, scale: 1 })))
	}, 90_000)
})

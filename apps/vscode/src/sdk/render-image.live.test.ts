import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { createGenerateIconTool, createRenderImageTool, createTransformImageTool } from "@cline/core"
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

	it("resizes, crops and converts a file, and packs an icon", async () => {
		const change = createTransformImageTool({
			cwd: ws,
			createDriver: () => ({
				render: (request) => renderWithChrome(request, { executablePath: CHROME, args: ["--no-sandbox"] }),
			}),
			fileExists: async (file) => existsSync(file),
			writeFile: async (file, data) => writeFileSync(file, data),
		})
		const go = (input: Record<string, unknown>) => change.execute(input, { metadata: {} } as never) as Promise<unknown>
		const sizeOf = (name: string) => {
			const data = readFileSync(path.join(ws, name))
			return [data.readUInt32BE(16), data.readUInt32BE(20)]
		}
		// flow.png is 1380 by 348.
		console.log(String(await go({ image: "flow.png", width: 690 })))
		expect(sizeOf("flow-690x174.png")).toEqual([690, 174])
		await go({ image: "flow.png", path: "cover.png", width: 300, height: 300, fit: "cover" })
		expect(sizeOf("cover.png")).toEqual([300, 300])
		await go({ image: "flow.png", path: "pad.png", width: 300, height: 300, fit: "pad", background: "#0d1117" })
		expect(sizeOf("pad.png")).toEqual([300, 300])
		await go({ image: "flow.png", path: "cut.png", crop: "0,0,400,348" })
		expect(sizeOf("cut.png")).toEqual([400, 348])
		await go({ image: "flow.png", path: "flow.jpg", width: 600, quality: 80 })
		expect(readFileSync(path.join(ws, "flow.jpg")).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
		await go({ image: "flow.png", path: "flow.webp", width: 600 })
		expect(readFileSync(path.join(ws, "flow.webp")).subarray(8, 12).toString()).toBe("WEBP")
		console.log(String(await go({ image: "badge.png", path: "badge.ico" })))
		const ico = readFileSync(path.join(ws, "badge.ico"))
		expect(ico.readUInt16LE(4)).toBe(7)
		// Each entry is a PNG of the size its directory entry says.
		const at = ico.readUInt32LE(6 + 12)
		expect(ico.readUInt32BE(at + 16)).toBe(16)
		await go({ image: "badge.png", path: "badge.icns" })
		expect(readFileSync(path.join(ws, "badge.icns")).subarray(0, 4).toString()).toBe("icns")
		expect(String(await go({ image: "styles/app.css", path: "no.png" }))).toContain("could not be read as an image")
	}, 180_000)

	it("shows icon proposals on one sheet and writes the chosen one out", async () => {
		// The endpoint is a stand-in: what is live here is the sheet and the files.
		const drawn = readFileSync(path.join(ws, "pad.png"))
		const icon = createGenerateIconTool({
			cwd: ws,
			getEndpoint: () => ({ baseUrl: "http://images.invalid/v1", model: "stand-in" }),
			fetchImpl: (async () =>
				new Response(JSON.stringify({ data: [{ b64_json: drawn.toString("base64") }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as never,
			createDriver: () => ({
				render: (request) => renderWithChrome(request, { executablePath: CHROME, args: ["--no-sandbox"] }),
			}),
			fileExists: async (file) => existsSync(file),
			writeFile: async (file, data) => {
				mkdirSync(path.dirname(file), { recursive: true })
				writeFileSync(file, data)
			},
		})
		const out = (await icon.execute({ prompt: "a workflow", count: 5 }, {
			metadata: { modelSupportsImages: true },
		} as never)) as Array<{ type: string; text?: string; data?: string }>
		writeFileSync(path.join(ws, "sheet.png"), Buffer.from(out[1]?.data ?? "", "base64"))
		const first = /1\. `([^`]+)`/.exec(out[0]?.text ?? "")?.[1] ?? ""
		const saved = String(await icon.execute({ pick: first, path: "icons/app" }, { metadata: {} } as never))
		console.log(saved)
		const ico = readFileSync(path.join(ws, "icons/app.ico"))
		expect(ico.readUInt16LE(4)).toBe(7)
		const big = readFileSync(path.join(ws, "icons/app.png"))
		expect([big.readUInt32BE(16), big.readUInt32BE(20)]).toEqual([1024, 1024])
		expect(readFileSync(path.join(ws, "icons/app.icns")).readUInt32BE(4)).toBe(statSync(path.join(ws, "icons/app.icns")).size)
	}, 180_000)
})
